import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RelayClient } from "../src/client.js";
import { RelayError } from "../src/errors.js";
import { RelayService } from "../src/service.js";
import { RelayStore } from "../src/store.js";

class PresenceDelivery {
  constructor() {
    this.deliveries = [];
    this.online = true;
  }

  async inspect({ paneId }) {
    if (!this.online) throw new RelayError("pane_missing", "pane is gone");
    return { paneId, panePid: 4242, paneCommand: "codex" };
  }

  async deliver(agent, message) {
    this.deliveries.push({ agent, message });
  }
}

function withService(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-relay-operator-"));
  const store = new RelayStore(path.join(directory, "relay.sqlite"));
  const delivery = new PresenceDelivery();
  const service = new RelayService({ store, delivery });
  t.after(async () => {
    await service.drain();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { delivery, service, store };
}

async function register(service) {
  await service.register({
    id: "worker",
    adapter: "codex",
    tmuxSocket: "/tmp/fake-tmux.sock",
    paneId: "%7",
  });
  await service.drain();
}

test("only the sender can cancel and ambiguous delivery requires force", async (t) => {
  const { service, store } = withService(t);
  await register(service);

  const queued = store.createMessage({
    sender: "coordinator",
    recipient: "offline-worker",
    body: "Safe to withdraw",
  }).message;
  await assert.rejects(
    service.cancel({ id: queued.id, sender: "other-agent" }),
    (error) => error.code === "wrong_sender",
  );
  assert.equal((await service.cancel({ id: queued.id, sender: "coordinator" })).state, "cancelled");
  assert.equal((await service.cancel({ id: queued.id, sender: "coordinator" })).state, "cancelled");

  const delivered = await service.send({
    sender: "coordinator",
    recipient: "worker",
    body: "May already be visible",
  });
  await service.drain();
  assert.equal(store.requireMessage(delivered.message.id).state, "injected");
  await assert.rejects(
    service.cancel({ id: delivered.message.id, sender: "coordinator" }),
    (error) => error.code === "cancel_requires_force",
  );
  assert.equal((await service.cancel({ id: delivered.message.id, sender: "coordinator", force: true })).state, "cancelled");

  const accepted = await service.send({
    sender: "coordinator",
    recipient: "worker",
    body: "Accepted work is recipient-owned",
  });
  await service.drain();
  service.accept({ id: accepted.message.id, agent: "worker" });
  await assert.rejects(
    service.cancel({ id: accepted.message.id, sender: "coordinator", force: true }),
    (error) => error.code === "invalid_transition",
  );
  assert.equal(store.requireMessage(accepted.message.id).state, "accepted");
});

test("cancelling open next work releases its queued successor", async (t) => {
  const { delivery, service, store } = withService(t);
  await register(service);
  const first = await service.send({
    sender: "coordinator",
    recipient: "worker",
    mode: "next",
    body: "First",
  });
  await service.drain();
  const second = await service.send({
    sender: "coordinator",
    recipient: "worker",
    mode: "next",
    body: "Second",
  });
  await service.drain();
  assert.equal(store.requireMessage(first.message.id).state, "injected");
  assert.equal(store.requireMessage(second.message.id).state, "queued");

  await service.cancel({ id: first.message.id, sender: "coordinator", force: true });
  await service.drain();

  assert.equal(store.requireMessage(first.message.id).state, "cancelled");
  assert.equal(store.requireMessage(second.message.id).state, "injected");
  assert.deepEqual(delivery.deliveries.map(({ message }) => message.id), [first.message.id, second.message.id]);
});

test("acknowledgement and completion require the recipient identity", async (t) => {
  const { service, store } = withService(t);
  await register(service);
  const sent = await service.send({
    sender: "coordinator",
    recipient: "worker",
    body: "Identity-bound task",
  });
  await service.drain();

  await assert.rejects(
    service.handle({ op: "accept", id: sent.message.id }),
    (error) => error.code === "invalid_agent",
  );
  const accepted = await service.handle({ op: "accept", id: sent.message.id, agent: "worker" });
  assert.equal(accepted.acceptedNow, true);
  assert.equal((await service.handle({ op: "accept", id: sent.message.id, agent: "worker" })).acceptedNow, false);
  await assert.rejects(
    service.handle({ op: "complete", id: sent.message.id, result: "done" }),
    (error) => error.code === "invalid_agent",
  );
  assert.equal((await service.handle({ op: "complete", id: sent.message.id, agent: "worker", result: "done" })).state, "completed");
  assert.equal(store.requireMessage(sent.message.id).result, "done");
});

test("peer discovery reports stale pane registrations as offline", async (t) => {
  const { delivery, service } = withService(t);
  await register(service);
  assert.equal((await service.agents())[0].online, true);
  delivery.online = false;
  assert.equal((await service.agents())[0].online, false);
});

for (const lostResponseCode of ["request_timeout", "empty_response", "ECONNRESET", "EPIPE"]) {
  test(`client retries a lost ${lostResponseCode} send response with one generated idempotency key`, async () => {
    const client = new RelayClient({ socketPath: "/not-used" });
    const requests = [];
    client.request = async (operation, payload) => {
      requests.push({ operation, payload });
      if (requests.length === 1) throw new RelayError(lostResponseCode, "response was lost");
      return { created: false, message: { id: "msg_00000000000000000000000000000000", state: "queued" } };
    };

    const result = await client.send({
      sender: "coordinator",
      recipient: "worker",
      body: "Return my durable handle",
    });

    assert.equal(result.message.state, "queued");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].operation, "send");
    assert.match(requests[0].payload.idempotencyKey, /^client-[0-9a-f]{32}$/);
    assert.deepEqual(requests[1], requests[0]);
  });
}
