import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CURRENT_SCHEMA_VERSION, RelayStore } from "../src/store.js";

function withStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-relay-store-"));
  const store = new RelayStore(path.join(directory, "relay.sqlite"));
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

test("message lifecycle preserves explicit delivery boundaries", (t) => {
  const store = withStore(t);
  const { message } = store.createMessage({
    sender: "coordinator",
    recipient: "reviewer",
    mode: "now",
    body: "Review the change",
  });

  assert.equal(message.state, "queued");
  assert.equal(store.markInjecting(message.id).state, "injecting");
  assert.equal(store.markInjected(message.id).state, "injected");
  assert.equal(store.acceptMessage(message.id, "reviewer").state, "accepted");
  const completed = store.finishMessage(message.id, "reviewer", "completed", "Looks good");
  assert.equal(completed.state, "completed");
  assert.equal(completed.result, "Looks good");
  assert.deepEqual(store.events(message.id).map((event) => event.type), [
    "message_queued",
    "delivery_started",
    "message_injected",
    "message_accepted",
    "message_completed",
  ]);
});

test("idempotency key returns the original message", (t) => {
  const store = withStore(t);
  const first = store.createMessage({
    sender: "coordinator",
    recipient: "reviewer",
    body: "First body",
    idempotencyKey: "task-42-review",
  });
  const second = store.createMessage({
    sender: "coordinator",
    recipient: "reviewer",
    body: "Different body",
    idempotencyKey: "task-42-review",
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.message.id, first.message.id);
  assert.equal(second.message.body, "First body");
});

test("interrupted injection recovers as uncertain without automatic replay", (t) => {
  const store = withStore(t);
  const { message } = store.createMessage({
    sender: "coordinator",
    recipient: "reviewer",
    body: "Do not duplicate",
  });
  store.markInjecting(message.id);

  assert.equal(store.recoverInterruptedDeliveries(), 1);
  const recovered = store.requireMessage(message.id);
  assert.equal(recovered.state, "uncertain");
  assert.match(recovered.lastError, /restarted during injection/);
});

test("only the intended recipient can acknowledge a message", (t) => {
  const store = withStore(t);
  const { message } = store.createMessage({
    sender: "coordinator",
    recipient: "reviewer",
    body: "Review",
  });
  store.markInjecting(message.id);
  store.markInjected(message.id);

  assert.throws(
    () => store.acceptMessage(message.id, "coder"),
    (error) => error.code === "wrong_recipient",
  );
  assert.equal(store.requireMessage(message.id).state, "injected");
});

test("database records an explicit schema version", (t) => {
  const store = withStore(t);
  assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, CURRENT_SCHEMA_VERSION);
});
