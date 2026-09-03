import net from "node:net";
import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

import { RelayError } from "./errors.js";
import { defaultSocketPath } from "./paths.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class RelayClient {
  constructor({ socketPath = defaultSocketPath(), timeoutMs = 5000 } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  request(op, payload = {}, { timeoutMs = this.timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: this.socketPath });
      let settled = false;
      let response = "";
      let responseBytes = 0;
      const decoder = new StringDecoder("utf8");

      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(result);
      };

      const timer = setTimeout(() => {
        finish(new RelayError("request_timeout", `relay request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ op, ...payload })}\n`);
      });

      socket.on("data", (chunk) => {
        responseBytes += chunk.length;
        if (responseBytes > MAX_RESPONSE_BYTES) {
          finish(new RelayError("response_too_large", "relay response exceeded 2 MiB"));
          return;
        }
        response += decoder.write(chunk);
        const newline = response.indexOf("\n");
        if (newline === -1) return;

        let parsed;
        try {
          parsed = JSON.parse(response.slice(0, newline));
        } catch (error) {
          finish(new RelayError("invalid_response", `relay returned invalid JSON: ${error.message}`));
          return;
        }

        if (!parsed.ok) {
          finish(new RelayError(parsed.error?.code ?? "request_failed", parsed.error?.message ?? "relay request failed", parsed.error?.details));
          return;
        }
        finish(null, parsed.result);
      });

      socket.on("error", (error) => {
        if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
          finish(new RelayError("daemon_unavailable", `relay daemon is unavailable at ${this.socketPath}`));
          return;
        }
        finish(error);
      });

      socket.on("end", () => {
        if (!settled && !response.includes("\n")) {
          finish(new RelayError("empty_response", "relay daemon closed the connection without a response"));
        }
      });
    });
  }

  ping() {
    return this.request("ping");
  }

  register(input) {
    return this.request("register", input);
  }

  identify(input) {
    return this.request("identify", input);
  }

  send(input) {
    const payload = {
      ...input,
      idempotencyKey: input.idempotencyKey ?? `client-${randomBytes(16).toString("hex")}`,
    };
    return this.request("send", payload).catch((error) => {
      if (!["request_timeout", "empty_response", "ECONNRESET", "EPIPE"].includes(error.code)) throw error;
      return this.request("send", payload);
    });
  }

  accept(id, agent = undefined) {
    return this.request("accept", { id, agent });
  }

  complete(id, result = "", agent = undefined) {
    return this.request("complete", { id, agent, result });
  }

  fail(id, result = "", agent = undefined) {
    return this.request("fail", { id, agent, result });
  }

  cancel(id, sender, force = false) {
    return this.request("cancel", { id, sender, force });
  }

  show(id) {
    return this.request("show", { id });
  }

  inbox(agent, options = {}) {
    return this.request("inbox", { agent, ...options });
  }

  agents() {
    return this.request("agents");
  }

  status() {
    return this.request("status");
  }

  retry(id, force = false) {
    return this.request("retry", { id, force });
  }
}
