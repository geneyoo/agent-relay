import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RelayClient } from "../src/client.js";
import { RelayDaemon } from "../src/daemon.js";
import { RelayStore } from "../src/store.js";

const MAX_WIRE_BYTES = 2 * 1024 * 1024;

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

function socketIdentity(filename) {
  const stat = fs.lstatSync(filename);
  return { dev: stat.dev, ino: stat.ino };
}

async function listen(server, socketPath) {
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function writePieces(socket, buffer, boundaries) {
  let offset = 0;
  for (const boundary of boundaries) {
    socket.write(buffer.subarray(offset, boundary));
    offset = boundary;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  socket.write(buffer.subarray(offset));
}

test("a rejected daemon cannot recover work or unlink the active daemon socket", async () => {
  const directory = temporaryDirectory("agent-relay-owner-");
  const socketPath = path.join(directory, "relay.sock");
  const statePath = path.join(directory, "relay.sqlite");
  let releaseDelivery;
  const delivery = {
    async inspect({ paneId }) {
      return { paneId, panePid: 4242, paneCommand: "codex" };
    },
    async deliver() {
      await new Promise((resolve) => { releaseDelivery = resolve; });
      return { bytes: 1 };
    },
  };
  const active = new RelayDaemon({ socketPath, statePath, delivery });
  let rejected;
  let pendingSend;

  try {
    await active.listen();
    const client = new RelayClient({ socketPath });
    await client.register({
      id: "worker",
      adapter: "codex",
      tmuxSocket: "/tmp/fake-tmux.sock",
      paneId: "%1",
    });

    pendingSend = client.send({ sender: "coordinator", recipient: "worker", body: "hold delivery" });
    const row = await waitFor(
      () => active.store.db.prepare("SELECT id, state FROM messages LIMIT 1").get(),
      "message was not persisted",
    );
    await waitFor(
      () => active.store.requireMessage(row.id).state === "injecting",
      "message did not enter injecting",
    );
    const identity = socketIdentity(socketPath);

    rejected = new RelayDaemon({ socketPath, statePath, delivery });
    assert.equal(rejected.store, null);
    await assert.rejects(
      rejected.listen(),
      (error) => error.code === "daemon_already_running",
    );
    assert.equal(rejected.store, null);
    assert.equal(active.store.requireMessage(row.id).state, "injecting");

    await rejected.close();
    assert.deepEqual(socketIdentity(socketPath), identity);
    assert.equal((await client.ping()).pid, process.pid);

    releaseDelivery();
    const sent = await pendingSend;
    assert.equal(sent.message.state, "queued");
    await active.service.drain();
    assert.equal((await client.show(sent.message.id)).state, "injected");
  } finally {
    releaseDelivery?.();
    await pendingSend?.catch(() => undefined);
    await rejected?.close();
    await active.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("daemon close preserves a replacement socket with a different inode", async () => {
  const directory = temporaryDirectory("agent-relay-inode-");
  const socketPath = path.join(directory, "relay.sock");
  const daemon = new RelayDaemon({
    socketPath,
    statePath: path.join(directory, "relay.sqlite"),
    delivery: {},
  });
  const replacement = net.createServer((socket) => socket.end());

  try {
    await daemon.listen();
    const ownedIdentity = socketIdentity(socketPath);
    fs.unlinkSync(socketPath);
    await listen(replacement, socketPath);
    const replacementIdentity = socketIdentity(socketPath);
    assert.notDeepEqual(replacementIdentity, ownedIdentity);

    await daemon.close();
    assert.deepEqual(socketIdentity(socketPath), replacementIdentity);
  } finally {
    await daemon.close();
    await closeServer(replacement);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("daemon startup schedules durable queued work", async () => {
  const directory = temporaryDirectory("agent-relay-startup-queue-");
  const socketPath = path.join(directory, "relay.sock");
  const statePath = path.join(directory, "relay.sqlite");
  const seeded = new RelayStore(statePath);
  seeded.registerAgent({
    id: "worker",
    adapter: "codex",
    tmuxSocket: "/tmp/fake-tmux.sock",
    paneId: "%7",
    panePid: 4242,
    paneCommand: "codex",
  });
  const queued = seeded.createMessage({
    sender: "coordinator",
    recipient: "worker",
    mode: "next",
    body: "Resume after daemon restart",
  }).message;
  seeded.close();
  const deliveries = [];
  const daemon = new RelayDaemon({
    socketPath,
    statePath,
    delivery: {
      async inspect({ paneId }) {
        return { paneId, panePid: 4242, paneCommand: "codex" };
      },
      async deliver(agent, message) {
        deliveries.push({ agent, message });
      },
    },
  });

  try {
    await daemon.listen();
    await daemon.service.drain();
    assert.equal(daemon.store.requireMessage(queued.id).state, "injected");
    assert.deepEqual(deliveries.map(({ message }) => message.id), [queued.id]);
  } finally {
    await daemon.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("daemon shutdown drains an in-flight background delivery before closing state", async () => {
  const directory = temporaryDirectory("agent-relay-shutdown-drain-");
  const socketPath = path.join(directory, "relay.sock");
  const statePath = path.join(directory, "relay.sqlite");
  let release;
  const deliveryStarted = new Promise((resolve) => { release = { started: resolve }; });
  let finishDelivery;
  const daemon = new RelayDaemon({
    socketPath,
    statePath,
    delivery: {
      async inspect({ paneId }) {
        return { paneId, panePid: 4242, paneCommand: "codex" };
      },
      async deliver() {
        release.started();
        await new Promise((resolve) => { finishDelivery = resolve; });
      },
    },
  });

  try {
    await daemon.listen();
    const client = new RelayClient({ socketPath });
    await client.register({
      id: "worker",
      adapter: "codex",
      tmuxSocket: "/tmp/fake-tmux.sock",
      paneId: "%7",
    });
    const sent = await client.send({ sender: "coordinator", recipient: "worker", body: "Finish the state write" });
    await deliveryStarted;
    let closed = false;
    const closing = daemon.close().then(() => { closed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    finishDelivery();
    await closing;

    const reopened = new RelayStore(statePath);
    try {
      assert.equal(reopened.requireMessage(sent.message.id).state, "injected");
    } finally {
      reopened.close();
    }
  } finally {
    finishDelivery?.();
    await daemon.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("daemon shutdown drops idle partial clients instead of waiting forever", async () => {
  const directory = temporaryDirectory("agent-relay-idle-client-");
  const socketPath = path.join(directory, "relay.sock");
  const daemon = new RelayDaemon({
    socketPath,
    statePath: path.join(directory, "relay.sqlite"),
    delivery: {},
  });
  let idle;

  try {
    await daemon.listen();
    idle = net.createConnection({ path: socketPath });
    await new Promise((resolve, reject) => {
      idle.once("connect", resolve);
      idle.once("error", reject);
    });
    idle.write('{"op":"ping"');
    const closing = daemon.close();
    await Promise.race([
      closing,
      new Promise((_, reject) => setTimeout(() => reject(new Error("daemon close remained blocked")), 500)),
    ]);
  } finally {
    idle?.destroy();
    await daemon.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a connection callback queued behind shutdown is destroyed immediately", () => {
  const daemon = new RelayDaemon({
    socketPath: "/tmp/not-opened-relay.sock",
    statePath: "/tmp/not-opened-relay.sqlite",
    delivery: {},
  });
  daemon.closed = true;
  let destroyed = false;

  daemon.handleConnection({
    destroy() {
      destroyed = true;
    },
  });

  assert.equal(destroyed, true);
  assert.equal(daemon.connections.size, 0);
});

test("daemon preserves UTF-8 split at every byte of a multibyte request character", async () => {
  const directory = temporaryDirectory("agent-relay-request-utf8-");
  const socketPath = path.join(directory, "relay.sock");
  const daemon = new RelayDaemon({
    socketPath,
    statePath: path.join(directory, "relay.sqlite"),
    delivery: {},
  });

  try {
    await daemon.listen();
    const body = "blue 💙 heart";
    const request = Buffer.from(`${JSON.stringify({
      op: "send",
      sender: "coordinator",
      recipient: "offline-worker",
      body,
    })}\n`);
    const characterOffset = request.indexOf(Buffer.from("💙"));
    const response = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: socketPath });
      const chunks = [];
      socket.on("connect", () => {
        writePieces(socket, request, [characterOffset + 1, characterOffset + 2, characterOffset + 3]).catch(reject);
      });
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("end", () => resolve(Buffer.concat(chunks)));
      socket.on("error", reject);
    });
    const parsed = JSON.parse(response.toString("utf8"));

    assert.equal(parsed.ok, true);
    assert.equal(parsed.result.message.body, body);
    assert.equal(daemon.store.requireMessage(parsed.result.message.id).body, body);
  } finally {
    await daemon.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("client preserves UTF-8 split at every byte of a multibyte response character", async () => {
  const directory = temporaryDirectory("agent-relay-response-utf8-");
  const socketPath = path.join(directory, "relay.sock");
  const expected = "blue 💙 heart";
  const response = Buffer.from(`${JSON.stringify({ ok: true, result: { text: expected } })}\n`);
  const characterOffset = response.indexOf(Buffer.from("💙"));
  const server = net.createServer((socket) => {
    socket.once("data", () => {
      writePieces(socket, response, [characterOffset + 1, characterOffset + 2, characterOffset + 3])
        .then(() => socket.end(), (error) => socket.destroy(error));
    });
  });

  try {
    await listen(server, socketPath);
    const result = await new RelayClient({ socketPath }).request("unicode");
    assert.equal(result.text, expected);
  } finally {
    await closeServer(server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("daemon and client enforce limits on raw wire bytes", async () => {
  const directory = temporaryDirectory("agent-relay-wire-limit-");
  const daemonSocket = path.join(directory, "daemon.sock");
  const oversizedResponseSocket = path.join(directory, "oversized.sock");
  const daemon = new RelayDaemon({
    socketPath: daemonSocket,
    statePath: path.join(directory, "relay.sqlite"),
    delivery: {},
  });
  const oversizedResponseServer = net.createServer((socket) => {
    socket.once("data", () => socket.end(Buffer.alloc(MAX_WIRE_BYTES + 1, 0x20)));
  });

  try {
    await daemon.listen();
    const response = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: daemonSocket });
      const chunks = [];
      socket.on("connect", () => socket.write(Buffer.alloc(MAX_WIRE_BYTES + 1, 0x20)));
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("end", () => resolve(Buffer.concat(chunks)));
      socket.on("error", reject);
    });
    assert.equal(JSON.parse(response.toString("utf8")).error.code, "request_too_large");

    await listen(oversizedResponseServer, oversizedResponseSocket);
    await assert.rejects(
      new RelayClient({ socketPath: oversizedResponseSocket }).request("oversized"),
      (error) => error.code === "response_too_large",
    );
  } finally {
    await daemon.close();
    await closeServer(oversizedResponseServer);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
