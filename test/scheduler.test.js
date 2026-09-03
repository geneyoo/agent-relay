import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RelayService } from "../src/service.js";
import { RelayStore } from "../src/store.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class RecordingDelivery {
  constructor() {
    this.deliveries = [];
  }

  async inspect({ paneId }) {
    return {
      paneId,
      panePid: 4000 + Number(paneId.slice(1)),
      paneCommand: "codex",
    };
  }

  async deliver(agent, message) {
    this.deliveries.push({ agent, message });
  }
}

class GatedDelivery extends RecordingDelivery {
  constructor() {
    super();
    this.started = deferred();
    this.release = deferred();
    this.blocked = true;
  }

  async deliver(agent, message) {
    this.deliveries.push({ agent, message });
    if (!this.blocked) return;
    this.blocked = false;
    this.started.resolve();
    await this.release.promise;
  }
}

function withService(t, delivery = new RecordingDelivery()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-relay-scheduler-"));
  const store = new RelayStore(path.join(directory, "relay.sqlite"));
  const service = new RelayService({ store, delivery });
  t.after(async () => {
    await service.drain();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { delivery, service, store };
}

function registerStoredAgent(store, id, paneNumber) {
  return store.registerAgent({
    id,
    adapter: "codex",
    tmuxSocket: "/tmp/fake-tmux.sock",
    paneId: `%${paneNumber}`,
    panePid: 4000 + paneNumber,
    paneCommand: "codex",
  });
}

async function registerAgent(service, id = "worker", paneNumber = 7) {
  const agent = await service.register({
    id,
    adapter: "codex",
    tmuxSocket: "/tmp/fake-tmux.sock",
    paneId: `%${paneNumber}`,
  });
  await service.drain();
  return agent;
}

function resolvesWithin(promise, milliseconds = 200) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`operation exceeded ${milliseconds} ms`)), milliseconds);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function markOpen(store, id, state) {
  store.markInjecting(id);
  if (state === "uncertain") {
    store.markDeliveryFailure(id, { uncertain: true, error: "injection outcome unknown" });
    return;
  }
  store.markInjected(id);
  if (state === "accepted") store.acceptMessage(id, store.requireMessage(id).recipient);
}

test("idempotency keys replay only the exact original request", (t) => {
  const { store } = withService(t);
  const parent = store.createMessage({
    sender: "coordinator",
    recipient: "worker",
    body: "Parent",
  }).message;
  const request = {
    sender: "coordinator",
    recipient: "worker",
    parentId: parent.id,
    mode: "now",
    body: "Original body",
    idempotencyKey: "stable-key",
  };
  const original = store.createMessage(request);
  const replay = store.createMessage(request);

  assert.equal(replay.created, false);
  assert.equal(replay.message.id, original.message.id);

  for (const conflict of [
    { recipient: "other-worker" },
    { parentId: null },
    { mode: "next" },
    { body: "Changed body" },
  ]) {
    assert.throws(
      () => store.createMessage({ ...request, ...conflict }),
      (error) => error.code === "idempotency_conflict"
        && error.details.messageId === original.message.id,
    );
  }
});

test("repeating a terminal transition requires the exact same result", (t) => {
  const { store } = withService(t);
  const message = store.createMessage({
    sender: "coordinator",
    recipient: "worker",
    body: "Complete once",
  }).message;
  store.markInjecting(message.id);
  store.markInjected(message.id);
  store.acceptMessage(message.id, "worker");

  const completed = store.finishMessage(message.id, "worker", "completed", "stable result");
  assert.equal(store.finishMessage(message.id, "worker", "completed", "stable result").id, completed.id);
  assert.throws(
    () => store.finishMessage(message.id, "worker", "completed", "changed result"),
    (error) => error.code === "terminal_result_conflict",
  );
  assert.equal(store.requireMessage(message.id).result, "stable result");
  assert.equal(store.events(message.id).filter((event) => event.type === "message_completed").length, 1);
});

test("queued ordering uses insertion order when timestamps tie", (t) => {
  const { store } = withService(t);
  const first = store.createMessage({
    sender: "coordinator",
    recipient: "worker",
    mode: "next",
    body: "First",
  }).message;
  const second = store.createMessage({
    sender: "coordinator",
    recipient: "worker",
    mode: "next",
    body: "Second",
  }).message;
  store.db.prepare("UPDATE messages SET created_at = ? WHERE id IN (?, ?)")
    .run("2026-09-02T00:00:00.000Z", first.id, second.id);

  assert.deepEqual(store.listQueued("worker").map((message) => message.id), [first.id, second.id]);
  assert.equal(store.nextQueued("worker").id, first.id);
});

test("a new next message schedules the oldest queued next message", async (t) => {
  const { delivery, service, store } = withService(t);
  await registerAgent(service);
  const first = store.createMessage({
    sender: "coordinator",
    recipient: "worker",
    mode: "next",
    body: "First",
  }).message;

  const second = await service.send({
    sender: "coordinator",
    recipient: "worker",
    mode: "next",
    body: "Second",
  });
  await service.drain();

  assert.equal(second.message.state, "queued");
  assert.deepEqual(delivery.deliveries.map(({ message }) => message.id), [first.id]);
  assert.equal(store.requireMessage(first.id).state, "injected");
  assert.equal(store.requireMessage(second.message.id).state, "queued");
});

test("retrying next work cannot bypass an older queued next message", async (t) => {
  const { delivery, service, store } = withService(t);
  await registerAgent(service);
  const first = store.createMessage({
    sender: "coordinator",
    recipient: "worker",
    mode: "next",
    body: "Older queued work",
  }).message;
  const retried = store.createMessage({
    sender: "coordinator",
    recipient: "worker",
    mode: "next",
    body: "Retry later",
  }).message;
  store.markInjecting(retried.id);
  store.markInjected(retried.id);

  const result = await service.retry({ id: retried.id, force: true });

  assert.equal(result.state, "queued");
  assert.deepEqual(delivery.deliveries.map(({ message }) => message.id), [first.id]);
  assert.equal(store.requireMessage(first.id).state, "injected");
});

test("retrying next work cannot bypass a different open task", async (t) => {
  const { delivery, service, store } = withService(t);
  await registerAgent(service);
  const open = store.createMessage({
    sender: "coordinator",
    recipient: "worker",
    body: "Already active",
  }).message;
  markOpen(store, open.id, "accepted");
  const retried = store.createMessage({
    sender: "coordinator",
    recipient: "worker",
    mode: "next",
    body: "Must remain queued",
  }).message;
  markOpen(store, retried.id, "injected");

  const result = await service.retry({ id: retried.id, force: true });

  assert.equal(result.state, "queued");
  assert.deepEqual(delivery.deliveries, []);
  assert.equal(store.requireMessage(open.id).state, "accepted");
});

test("an exact idempotent hit schedules a queued original only once", async (t) => {
  const { delivery, service, store } = withService(t);
  await registerAgent(service);
  const request = {
    sender: "coordinator",
    recipient: "worker",
    body: "Recover my handle",
    idempotencyKey: "recover-handle",
  };
  const original = store.createMessage(request);

  const replay = await service.send(request);
  assert.equal(replay.created, false);
  assert.equal(replay.message.state, "queued");
  await service.drain();
  assert.equal(store.requireMessage(original.message.id).state, "injected");
  assert.equal(delivery.deliveries.length, 1);

  const injectedReplay = await service.send(request);
  await service.drain();
  assert.equal(injectedReplay.message.state, "injected");
  assert.equal(delivery.deliveries.length, 1);
});

test("startup dispatch sends queued work but does not replay open states", async (t) => {
  const { delivery, service, store } = withService(t);
  registerStoredAgent(store, "safe-worker", 1);
  const safe = store.createMessage({
    sender: "coordinator",
    recipient: "safe-worker",
    mode: "next",
    body: "Safe after restart",
  }).message;

  const blocked = [];
  for (const [index, state] of ["uncertain", "injected", "accepted"].entries()) {
    const recipient = `${state}-worker`;
    registerStoredAgent(store, recipient, index + 2);
    const open = store.createMessage({
      sender: "coordinator",
      recipient,
      body: `Remain ${state}`,
    }).message;
    markOpen(store, open.id, state);
    const queued = store.createMessage({
      sender: "coordinator",
      recipient,
      mode: "next",
      body: "Wait behind the open task",
    }).message;
    blocked.push({ open, queued, state });
  }

  await service.dispatchQueued();

  assert.deepEqual(delivery.deliveries.map(({ message }) => message.id), [safe.id]);
  assert.equal(store.requireMessage(safe.id).state, "injected");
  for (const entry of blocked) {
    assert.equal(store.requireMessage(entry.open.id).state, entry.state);
    assert.equal(store.requireMessage(entry.queued.id).state, "queued");
  }
});

test("send returns durable IDs while target delivery is slow and contended", async (t) => {
  const delivery = new GatedDelivery();
  const { service, store } = withService(t, delivery);
  await registerAgent(service);

  const first = await resolvesWithin(service.send({
    sender: "coordinator",
    recipient: "worker",
    body: "Block delivery",
  }));
  assert.equal(first.message.state, "queued");
  await delivery.started.promise;

  const second = await resolvesWithin(service.send({
    sender: "coordinator",
    recipient: "worker",
    body: "Wait only in the background",
  }));
  assert.equal(second.message.state, "queued");
  assert.equal(delivery.deliveries.length, 1);

  delivery.release.resolve();
  await service.drain();
  assert.equal(store.requireMessage(first.message.id).state, "injected");
  assert.equal(store.requireMessage(second.message.id).state, "injected");
});

test("registration cannot replace a target mapping during delivery", async (t) => {
  const delivery = new GatedDelivery();
  const { service, store } = withService(t, delivery);
  await registerAgent(service, "worker", 7);

  const sent = await service.send({
    sender: "coordinator",
    recipient: "worker",
    body: "Use the registered target",
  });
  await delivery.started.promise;

  let registrationFinished = false;
  const registration = service.register({
    id: "worker",
    adapter: "codex",
    tmuxSocket: "/tmp/fake-tmux.sock",
    paneId: "%8",
  }).then((agent) => {
    registrationFinished = true;
    return agent;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(registrationFinished, false);
  assert.equal(store.getAgent("worker").paneId, "%7");
  assert.equal(delivery.deliveries[0].agent.paneId, "%7");

  delivery.release.resolve();
  const registered = await registration;
  await service.drain();
  assert.equal(registered.paneId, "%8");
  assert.equal(store.requireMessage(sent.message.id).state, "injected");
  assert.equal(store.getAgent("worker").paneId, "%8");
});

test("registration returns before delivering queued work", async (t) => {
  const delivery = new GatedDelivery();
  const { service, store } = withService(t, delivery);
  const sent = await service.send({
    sender: "coordinator",
    recipient: "offline-worker",
    body: "Deliver after registration",
  });
  await service.drain();
  assert.equal(store.requireMessage(sent.message.id).state, "queued");

  const registered = await resolvesWithin(service.register({
    id: "offline-worker",
    adapter: "codex",
    tmuxSocket: "/tmp/fake-tmux.sock",
    paneId: "%9",
  }));
  assert.equal(registered.id, "offline-worker");
  await delivery.started.promise;
  assert.equal(store.requireMessage(sent.message.id).state, "injecting");

  delivery.release.resolve();
  await service.drain();
  assert.equal(store.requireMessage(sent.message.id).state, "injected");
});
