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
      case "show":
        return this.show(request);
      case "inbox":
        return this.inbox(request);
      case "agents":
        return this.store.listAgents();
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
    const fingerprint = await this.delivery.inspect({ tmuxSocket, paneId });
    const resolvedAdapter = adapter === "auto" ? detectAdapter(fingerprint.paneCommand) : adapter;
    assertRelay(adapterMatchesCommand(resolvedAdapter, fingerprint.paneCommand), "adapter_not_ready", `pane ${paneId} currently runs ${fingerprint.paneCommand}, not ${resolvedAdapter}`);
    const agent = this.store.registerAgent({
      id,
      adapter: resolvedAdapter,
      tmuxSocket,
      paneId: fingerprint.paneId,
      panePid: fingerprint.panePid,
      paneCommand: fingerprint.paneCommand,
    });
    await this.dispatchNext(id);
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
    if (!created.created) return created;
    const message = await this.withTargetLock(recipient, async () => {
      if (mode === "next" && this.store.hasOpenMessage(recipient, created.message.id)) {
        return this.store.requireMessage(created.message.id);
      }
      return this.attemptDelivery(created.message.id);
    });
    return { message, created: true };
  }

  accept({ id, agent = undefined }) {
    validateMessageId(id);
    const message = this.store.requireMessage(id);
    const resolvedAgent = agent ?? message.recipient;
    validateAgentId(resolvedAgent);
    return this.store.acceptMessage(id, resolvedAgent);
  }

  async finish({ id, agent = undefined, result = "" }, state) {
    validateMessageId(id);
    const existing = this.store.requireMessage(id);
    const resolvedAgent = agent ?? existing.recipient;
    validateAgentId(resolvedAgent);
    const message = this.store.finishMessage(id, resolvedAgent, state, result);
    await this.dispatchNext(message.recipient);
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
    const requeued = this.store.requeueMessage(id, force);
    const message = await this.withTargetLock(requeued.recipient, () => this.attemptDelivery(id));
    return message;
  }

  async dispatchNext(recipient) {
    return this.withTargetLock(recipient, async () => {
      const next = this.store.nextQueued(recipient);
      if (!next) return undefined;
      if (next.mode === "next" && this.store.hasOpenMessage(recipient, next.id)) return next;
      return this.attemptDelivery(next.id);
    });
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
}
