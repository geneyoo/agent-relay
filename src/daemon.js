import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import { RelayError } from "./errors.js";
import { RelayService } from "./service.js";
import { RelayStore } from "./store.js";
import { TmuxDelivery } from "./tmux.js";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

function serializedError(error) {
  return {
    code: error?.code ?? "internal_error",
    message: error?.code ? error.message : "internal relay error",
    ...(error?.details === undefined ? {} : { details: error.details }),
  };
}

async function socketIsLive(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new RelayError("socket_probe_timeout", `timed out probing ${socketPath}`));
    }, 500);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
      else reject(error);
    });
  });
}

async function prepareSocket(socketPath) {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  while (true) {
    let stat;
    try {
      stat = fs.lstatSync(socketPath);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (!stat.isSocket()) {
      throw new RelayError("unsafe_socket_path", `refusing to replace non-socket path ${socketPath}`);
    }
    if (await socketIsLive(socketPath)) {
      throw new RelayError("daemon_already_running", `a relay daemon is already listening at ${socketPath}`);
    }

    let current;
    try {
      current = fs.lstatSync(socketPath);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (current.dev !== stat.dev || current.ino !== stat.ino) continue;
    try {
      fs.unlinkSync(socketPath);
      return;
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
  }
}

function privateSocketPath(socketPath) {
  return path.join(path.dirname(socketPath), `.r-${randomBytes(4).toString("hex")}`);
}

function unlinkOwnedSocket(socketPath, identity) {
  if (!identity) return;
  try {
    const stat = fs.lstatSync(socketPath);
    if (stat.isSocket() && stat.dev === identity.dev && stat.ino === identity.ino) {
      fs.unlinkSync(socketPath);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export class RelayDaemon {
  constructor({ socketPath, statePath, delivery = new TmuxDelivery() }) {
    this.socketPath = socketPath;
    this.statePath = statePath;
    this.delivery = delivery;
    this.store = null;
    this.service = null;
    this.socketIdentity = null;
    this.boundSocketPath = null;
    this.boundSocketIdentity = null;
    this.server = net.createServer((socket) => this.handleConnection(socket));
    this.closed = false;
  }

  async listen() {
    await prepareSocket(this.socketPath);
    this.boundSocketPath = privateSocketPath(this.socketPath);
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(this.boundSocketPath, () => {
        this.server.off("error", onError);
        try {
          const boundStat = fs.lstatSync(this.boundSocketPath);
          this.boundSocketIdentity = { dev: boundStat.dev, ino: boundStat.ino };
          fs.chmodSync(this.boundSocketPath, 0o600);
          try {
            fs.linkSync(this.boundSocketPath, this.socketPath);
          } catch (error) {
            if (error.code === "EEXIST") {
              throw new RelayError("daemon_already_running", `a relay daemon already owns ${this.socketPath}`);
            }
            throw error;
          }
          const socketStat = fs.lstatSync(this.socketPath);
          this.socketIdentity = { dev: socketStat.dev, ino: socketStat.ino };
          fs.unlinkSync(this.boundSocketPath);
          this.store = new RelayStore(this.statePath);
          this.store.recoverInterruptedDeliveries();
          this.service = new RelayService({ store: this.store, delivery: this.delivery });
          resolve();
        } catch (error) {
          this.close().then(() => reject(error), reject);
        }
      });
    });
  }

  handleConnection(socket) {
    let request = "";
    let requestBytes = 0;
    let handled = false;
    const decoder = new StringDecoder("utf8");

    const respond = (payload) => {
      if (socket.destroyed) return;
      socket.end(`${JSON.stringify(payload)}\n`);
    };

    socket.on("data", async (chunk) => {
      if (handled) return;
      requestBytes += chunk.length;
      if (requestBytes > MAX_REQUEST_BYTES) {
        handled = true;
        respond({ ok: false, error: serializedError(new RelayError("request_too_large", "request exceeds 2 MiB")) });
        return;
      }
      request += decoder.write(chunk);
      const newline = request.indexOf("\n");
      if (newline === -1) return;
      handled = true;
      try {
        if (!this.service) throw new RelayError("daemon_not_ready", "relay daemon is not ready");
        const parsed = JSON.parse(request.slice(0, newline));
        const result = await this.service.handle(parsed);
        respond({ ok: true, result });
      } catch (error) {
        respond({ ok: false, error: serializedError(error) });
      }
    });

    socket.on("error", () => {
      // A disconnected client must not terminate the daemon.
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.server.listening) {
      await new Promise((resolve, reject) => {
        this.server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
    this.store?.close();
    this.store = null;
    this.service = null;
    unlinkOwnedSocket(this.boundSocketPath, this.boundSocketIdentity);
    unlinkOwnedSocket(this.socketPath, this.socketIdentity);
    this.boundSocketPath = null;
    this.boundSocketIdentity = null;
    this.socketIdentity = null;
  }
}
