import assert from "node:assert/strict";
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
  return { client: new RelayClient({ socketPath }), delivery };
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
  assert.equal(sent.message.state, "injected");
  assert.equal(delivery.deliveries.length, 1);

  assert.equal((await client.accept(sent.message.id, "reviewer")).state, "accepted");
  const completed = await client.complete(sent.message.id, "reviewer", "Done");
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

  assert.equal(first.message.state, "injected");
  assert.equal(second.message.state, "queued");
  assert.equal(delivery.deliveries.length, 1);

  await client.accept(first.message.id, "worker");
  await client.complete(first.message.id, "worker", "First done");

  assert.equal((await client.show(second.message.id)).state, "injected");
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
  assert.equal((await client.show(sent.message.id)).state, "injected");
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

test("client keeps the socket open for asynchronous delivery responses", async (t) => {
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
  assert.equal(sent.message.state, "injected");
});
