import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RelayClient } from "../src/client.js";
import { RelayDaemon } from "../src/daemon.js";

class FakeDelivery {
  constructor(delayMs = 0) {
    this.deliveries = [];
    this.delayMs = delayMs;
  }

  async inspect({ paneId }) {
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return { paneId, panePid: 4242, paneCommand: paneId === "%7" ? "codex" : paneId === "%12" ? "claude" : "zsh" };
  }

  async deliver(agent, message) {
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.deliveries.push({ agent, message });
    return { bytes: message.body.length };
  }
}

async function withDaemon(t, delivery = new FakeDelivery()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-relay-daemon-"));
  const socketPath = path.join(directory, "relay.sock");
  const statePath = path.join(directory, "relay.sqlite");
  const daemon = new RelayDaemon({ socketPath, statePath, delivery });
  await daemon.listen();
  t.after(async () => {
    await daemon.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { client: new RelayClient({ socketPath }), delivery, socketPath };
}

async function waitForState(client, id, state, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = await client.show(id);
    if (message.state === state) return message;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`${id} did not reach ${state}`);
}

test("daemon delivers, accepts, and completes a message", async (t) => {
  const { client, delivery } = await withDaemon(t);
  await client.register({
    id: "reviewer",
    adapter: "claude",
    tmuxSocket: "/tmp/fake-tmux.sock",
    paneId: "%12",
  });

  const sent = await client.send({
    sender: "coordinator",
    recipient: "reviewer",
    mode: "now",
    body: "Review the change",
  });
  assert.equal(sent.message.state, "queued");
  await waitForState(client, sent.message.id, "injected");
  assert.equal(delivery.deliveries.length, 1);

  assert.equal((await client.accept(sent.message.id, "reviewer")).state, "accepted");
  const completed = await client.complete(sent.message.id, "Done", "reviewer");
  assert.equal(completed.state, "completed");
  assert.equal((await client.show(sent.message.id)).result, "Done");
});

test("next mode serializes work per recipient", async (t) => {
  const { client, delivery } = await withDaemon(t);
  await client.register({
    id: "worker",
    adapter: "codex",
    tmuxSocket: "/tmp/fake-tmux.sock",
    paneId: "%7",
  });

  const first = await client.send({
    sender: "coordinator",
    recipient: "worker",
    mode: "next",
    body: "First",
  });
  const second = await client.send({
    sender: "coordinator",
    recipient: "worker",
    mode: "next",
    body: "Second",
  });

  assert.equal(first.message.state, "queued");
  await waitForState(client, first.message.id, "injected");
  assert.equal(second.message.state, "queued");
  assert.equal(delivery.deliveries.length, 1);

  await client.accept(first.message.id, "worker");
  await client.complete(first.message.id, "First done", "worker");

  await waitForState(client, second.message.id, "injected");
  assert.equal(delivery.deliveries.length, 2);
});

test("send is durable while its recipient is unregistered", async (t) => {
  const { client, delivery } = await withDaemon(t);
  const sent = await client.send({
    sender: "coordinator",
    recipient: "offline-worker",
    mode: "next",
    body: "Wait for registration",
  });
  assert.equal(sent.message.state, "queued");
  assert.equal(delivery.deliveries.length, 0);

  await client.register({
    id: "offline-worker",
    adapter: "tmux",
    tmuxSocket: "/tmp/fake-tmux.sock",
    paneId: "%9",
  });
  await waitForState(client, sent.message.id, "injected");
  assert.equal(delivery.deliveries.length, 1);
});

test("provider adapter refuses a pane running the wrong foreground command", async (t) => {
  const { client } = await withDaemon(t);
  await assert.rejects(
    client.register({
      id: "reviewer",
      adapter: "claude",
      tmuxSocket: "/tmp/fake-tmux.sock",
      paneId: "%9",
    }),
    (error) => error.code === "adapter_not_ready",
  );
  assert.deepEqual(await client.agents(), []);
});

test("client receives the durable ID before asynchronous delivery finishes", async (t) => {
  const { client } = await withDaemon(t, new FakeDelivery(25));
  const registered = await client.register({
    id: "slow-worker",
    adapter: "tmux",
    tmuxSocket: "/tmp/fake-tmux.sock",
    paneId: "%9",
  });
  assert.equal(registered.id, "slow-worker");

  const sent = await client.send({
    sender: "coordinator",
    recipient: "slow-worker",
    mode: "now",
    body: "Wait for the real response",
  });
  assert.equal(sent.message.state, "queued");
  await waitForState(client, sent.message.id, "injected");
});

test("auto registration detects the provider and resolves pane identity", async (t) => {
  const { client } = await withDaemon(t);
  const joined = await client.register({
    id: "reviewer",
    adapter: "auto",
    tmuxSocket: "/tmp/fake-tmux.sock",
    paneId: "%12",
  });
  assert.equal(joined.adapter, "claude");
  assert.equal((await client.identify({ tmuxSocket: "/tmp/fake-tmux.sock", paneId: "%12" })).id, "reviewer");
});

test("one pane cannot silently claim two agent names", async (t) => {
  const { client } = await withDaemon(t);
  await client.register({
    id: "first-name",
    adapter: "auto",
    tmuxSocket: "/tmp/fake-tmux.sock",
    paneId: "%7",
  });
  await assert.rejects(
    client.register({
      id: "second-name",
      adapter: "auto",
      tmuxSocket: "/tmp/fake-tmux.sock",
      paneId: "%7",
    }),
    (error) => error.code === "pane_already_registered",
  );
});

test("ask command prints only the completed result", async (t) => {
  const { client, socketPath } = await withDaemon(t);
  await client.register({
    id: "coordinator",
    adapter: "claude",
    tmuxSocket: "/tmp/fake-tmux.sock",
    paneId: "%12",
  });
  await client.register({
    id: "worker",
    adapter: "codex",
    tmuxSocket: "/tmp/fake-tmux.sock",
    paneId: "%7",
  });

  const child = spawn(process.execPath, [
    new URL("../bin/relay.js", import.meta.url).pathname,
    "ask",
    "worker",
    "Review this",
    "--socket",
    socketPath,
    "--accept-timeout",
    "2",
    "--timeout",
    "2",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      TMUX: "/tmp/fake-tmux.sock,123,0",
      TMUX_PANE: "%12",
      AGENT_RELAY_AGENT: "",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

  let message;
  for (let attempt = 0; attempt < 40 && !message; attempt += 1) {
    const inbox = await client.inbox("worker", { includeBody: true });
    message = inbox[0];
    if (!message) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(message, "ask did not create a message");
  assert.equal(message.sender, "coordinator");
  await client.accept(message.id, "worker");
  await client.complete(message.id, "One issue found", "worker");

  const exitCode = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(exitCode, 0, stderr);
  assert.equal(stdout, "One issue found\n");
  assert.match(stderr, new RegExp(`relay: ${message.id} persisted; waiting for worker`));
});

test("CLI explicit recipient identity survives misleading tool pane coordinates", async (t) => {
  const { client, socketPath } = await withDaemon(t);
  await client.register({
    id: "coordinator",
    adapter: "claude",
    tmuxSocket: "/tmp/fake-tmux.sock",
    paneId: "%12",
  });
  await client.register({
    id: "worker",
    adapter: "codex",
    tmuxSocket: "/tmp/fake-tmux.sock",
    paneId: "%7",
  });
  const sent = await client.send({
    sender: "coordinator",
    recipient: "worker",
    body: "Do not let the wrong pane acknowledge this",
  });
  await waitForState(client, sent.message.id, "injected");

  const child = spawn(process.execPath, [
    new URL("../bin/relay.js", import.meta.url).pathname,
    "ack",
    sent.message.id,
    "--agent",
    "worker",
    "--socket",
    socketPath,
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      TMUX: "/tmp/fake-tmux.sock,123,0",
      TMUX_PANE: "%12",
      AGENT_RELAY_AGENT: "worker",
    },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const exitCode = await new Promise((resolve) => child.once("close", resolve));

  assert.equal(exitCode, 0, stderr);
  assert.equal((await client.show(sent.message.id)).state, "accepted");
});
