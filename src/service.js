import { RelayError, assertRelay } from "./errors.js";
import { validateAgentId, validateMessageId } from "./validation.js";

const SUPPORTED_ADAPTERS = new Set(["auto", "tmux", "claude", "codex"]);

function detectAdapter(command) {
  const normalized = command.toLowerCase();
  if (normalized.includes("claude")) return "claude";
  if (normalized.includes("codex")) return "codex";
  throw new RelayError("adapter_not_detected", `pane currently runs ${command}; specify --adapter tmux for a generic target`);
}

function adapterMatchesCommand(adapter, command) {
  if (adapter === "tmux") return true;
  return command.toLowerCase().includes(adapter);
}

export class RelayService {
  constructor({ store, delivery }) {
    this.store = store;
    this.delivery = delivery;
    this.targetLocks = new Map();
    this.backgroundTasks = new Set();
  }

  async handle(request) {
    assertRelay(request && typeof request === "object" && !Array.isArray(request), "invalid_request", "request must be an object");
    switch (request.op) {
      case "ping":
        return { version: 1, pid: process.pid };
      case "register":
        return this.register(request);
      case "identify":
        return this.identify(request);
      case "send":
        return this.send(request);
      case "accept":
        return this.accept(request);
      case "complete":
        return this.finish(request, "completed");
      case "fail":
        return this.finish(request, "failed");
      case "cancel":
        return this.cancel(request);
      case "show":
        return this.show(request);
      case "inbox":
        return this.inbox(request);
      case "agents":
        return this.agents();
      case "status":
        return this.store.status();
      case "retry":
        return this.retry(request);
      default:
        throw new RelayError("unknown_operation", `unknown operation: ${request.op ?? "<missing>"}`);
    }
  }

  async register({ id, adapter = "auto", tmuxSocket, paneId }) {
    validateAgentId(id);
    assertRelay(SUPPORTED_ADAPTERS.has(adapter), "unsupported_adapter", `unsupported adapter: ${adapter}`);
    const agent = await this.withTargetLock(id, async () => {
      const fingerprint = await this.delivery.inspect({ tmuxSocket, paneId });
      const resolvedAdapter = adapter === "auto" ? detectAdapter(fingerprint.paneCommand) : adapter;
      assertRelay(adapterMatchesCommand(resolvedAdapter, fingerprint.paneCommand), "adapter_not_ready", `pane ${paneId} currently runs ${fingerprint.paneCommand}, not ${resolvedAdapter}`);
      return this.store.registerAgent({
        id,
        adapter: resolvedAdapter,
        tmuxSocket,
        paneId: fingerprint.paneId,
        panePid: fingerprint.panePid,
        paneCommand: fingerprint.paneCommand,
      });
    });
    this.runInBackground(id, () => this.withTargetLock(id, () => this.dispatchQueuedLocked(id)));
    return agent;
  }

  async identify({ tmuxSocket, paneId }) {
    const agent = this.store.findAgentByPane(tmuxSocket, paneId);
    if (!agent) return null;
    try {
      const fingerprint = await this.delivery.inspect({ tmuxSocket, paneId });
      if (fingerprint.panePid !== agent.panePid) return null;
      if (agent.adapter !== "tmux" && fingerprint.paneCommand !== agent.paneCommand) return null;
      return agent;
    } catch {
      return null;
    }
  }

  async send({ sender, recipient, parentId = null, mode = "now", body, idempotencyKey = null }) {
    const created = this.store.createMessage({ sender, recipient, parentId, mode, body, idempotencyKey });
    if (created.message.state === "queued") {
      this.runInBackground(created.message.recipient, () => this.withTargetLock(created.message.recipient, () => (
        this.scheduleMessageLocked(created.message.id)
      )));
    }
    return created;
  }

  accept({ id, agent = undefined }) {
    validateMessageId(id);
    validateAgentId(agent);
    const existing = this.store.requireMessage(id);
    const acceptedNow = !["accepted", "completed", "failed"].includes(existing.state);
    return { ...this.store.acceptMessage(id, agent), acceptedNow };
  }

  async finish({ id, agent = undefined, result = "" }, state) {
    validateMessageId(id);
    validateAgentId(agent);
    const message = this.store.finishMessage(id, agent, state, result);
    this.runInBackground(message.recipient, () => (
      this.withTargetLock(message.recipient, () => this.dispatchNextLocked(message.recipient))
    ));
    return message;
  }

  async cancel({ id, sender, force = false }) {
    validateMessageId(id);
    validateAgentId(sender, "sender");
    const existing = this.store.requireMessage(id);
    const message = await this.withTargetLock(existing.recipient, () => (
      this.store.cancelMessage(id, sender, force)
    ));
    this.runInBackground(message.recipient, () => (
      this.withTargetLock(message.recipient, () => this.dispatchNextLocked(message.recipient))
    ));
    return message;
  }

  show({ id }) {
    const message = this.store.requireMessage(id);
    return { ...message, events: this.store.events(id) };
  }

  inbox({ agent, state = null, limit = 50, includeBody = false }) {
    return this.store.listInbox(agent, { state, limit, includeBody });
  }

  async retry({ id, force = false }) {
    validateMessageId(id);
    const existing = this.store.requireMessage(id);
    const message = await this.withTargetLock(existing.recipient, () => (
      this.store.requeueMessage(id, force)
    ));
    this.runInBackground(message.recipient, () => (
      this.withTargetLock(message.recipient, () => this.scheduleMessageLocked(id))
    ));
    return message;
  }

  async agents() {
    return Promise.all(this.store.listAgents().map(async (agent) => {
      try {
        const fingerprint = await this.delivery.inspect(agent);
        const online = fingerprint.panePid === agent.panePid
          && (agent.adapter === "tmux" || fingerprint.paneCommand === agent.paneCommand);
        return { ...agent, online };
      } catch {
        return { ...agent, online: false };
      }
    }));
  }

  async dispatchNext(recipient) {
    return this.withTargetLock(recipient, () => this.dispatchNextLocked(recipient));
  }

  async dispatchQueued() {
    const recipients = this.store.listQueuedRecipients();
    return Promise.all(recipients.map((recipient) => (
      this.withTargetLock(recipient, () => this.dispatchQueuedLocked(recipient))
    )));
  }

  async dispatchQueuedLocked(recipient) {
    const dispatched = [];
    const queued = this.store.listQueued(recipient);
    for (const snapshot of queued) {
      const current = this.store.requireMessage(snapshot.id);
      if (current.state !== "queued") continue;

      if (current.mode === "next") {
        const next = this.store.nextQueued(recipient);
        if (!next || next.id !== current.id || this.store.hasOpenMessage(recipient)) break;
        dispatched.push(await this.attemptDelivery(current.id));
        break;
      }

      dispatched.push(await this.attemptDelivery(current.id));
    }
    return dispatched;
  }

  async dispatchNextLocked(recipient) {
    const next = this.store.nextQueued(recipient);
    if (!next) return undefined;
    if (next.mode === "next" && this.store.hasOpenMessage(recipient)) return next;
    return this.attemptDelivery(next.id);
  }

  async scheduleMessageLocked(id) {
    const message = this.store.requireMessage(id);
    if (message.state !== "queued") return message;
    if (message.mode === "now") return this.attemptDelivery(id);
    await this.dispatchNextLocked(message.recipient);
    return this.store.requireMessage(id);
  }

  async attemptDelivery(id) {
    const message = this.store.requireMessage(id);
    if (message.state !== "queued") return message;
    const agent = this.store.getAgent(message.recipient);
    if (!agent) return message;

    this.store.markInjecting(id);
    try {
      await this.delivery.deliver(agent, message);
      this.store.setAgentError(agent.id, null);
      return this.store.markInjected(id);
    } catch (error) {
      const description = `${error.code ?? "delivery_failed"}: ${error.message}`;
      this.store.setAgentError(agent.id, description);
      return this.store.markDeliveryFailure(id, {
        uncertain: error.mayHaveReachedPane === true,
        error: description,
      });
    }
  }

  withTargetLock(target, fn) {
    validateAgentId(target, "recipient");
    const previous = this.targetLocks.get(target) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(fn);
    this.targetLocks.set(target, current);
    return current.finally(() => {
      if (this.targetLocks.get(target) === current) this.targetLocks.delete(target);
    });
  }

  runInBackground(target, fn) {
    const task = Promise.resolve().then(fn);
    this.backgroundTasks.add(task);
    task.then(
      () => this.backgroundTasks.delete(task),
      (error) => {
        this.backgroundTasks.delete(task);
        try {
          this.store.setAgentError(target, `${error.code ?? "dispatch_failed"}: ${error.message}`);
        } catch {
          // The rejected task is handled even if its diagnostic cannot be persisted.
        }
      },
    );
  }

  start() {
    for (const recipient of this.store.listQueuedRecipients()) {
      this.runInBackground(recipient, () => (
        this.withTargetLock(recipient, () => this.dispatchQueuedLocked(recipient))
      ));
    }
  }

  async drain() {
    while (this.backgroundTasks.size > 0) {
      await Promise.allSettled([...this.backgroundTasks]);
    }
  }
}
