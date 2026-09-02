import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { RelayError, assertRelay } from "./errors.js";
import { validateAgentId, validateBody, validateMessageId, validateMode } from "./validation.js";

const MESSAGE_STATES = new Set([
  "queued",
  "injecting",
  "injected",
  "uncertain",
  "accepted",
  "completed",
  "failed",
  "cancelled",
]);

function now() {
  return new Date().toISOString();
}

function messageId() {
  return `msg_${randomBytes(16).toString("hex")}`;
}

function parseDetails(value) {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

function mapMessage(row, includeBody = true) {
  if (!row) return undefined;
  const message = {
    id: row.id,
    sender: row.sender,
    recipient: row.recipient,
    parentId: row.parent_id ?? undefined,
    mode: row.mode,
    state: row.state,
    idempotencyKey: row.idempotency_key ?? undefined,
    attempts: row.attempts,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    injectedAt: row.injected_at ?? undefined,
    acceptedAt: row.accepted_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    result: row.result ?? undefined,
  };
  if (includeBody) message.body = row.body;
  return message;
}

function mapAgent(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    adapter: row.adapter,
    tmuxSocket: row.tmux_socket,
    paneId: row.pane_id,
    panePid: row.pane_pid,
    paneCommand: row.pane_command,
    generation: row.generation,
    registeredAt: row.registered_at,
    updatedAt: row.updated_at,
    lastError: row.last_error ?? undefined,
  };
}

export class RelayStore {
  constructor(filename) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    try {
      fs.chmodSync(filename, 0o600);
    } catch {
      // Some in-memory and special SQLite paths cannot be chmodded.
    }
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        adapter TEXT NOT NULL,
        tmux_socket TEXT NOT NULL,
        pane_id TEXT NOT NULL,
        pane_pid INTEGER NOT NULL,
        pane_command TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 1,
        registered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        parent_id TEXT,
        mode TEXT NOT NULL CHECK (mode IN ('now', 'next')),
        body TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'injecting', 'injected', 'uncertain', 'accepted', 'completed', 'failed', 'cancelled')),
        idempotency_key TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        injected_at TEXT,
        accepted_at TEXT,
        completed_at TEXT,
        result TEXT,
        UNIQUE(sender, idempotency_key),
        FOREIGN KEY(parent_id) REFERENCES messages(id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS messages_recipient_state_created
        ON messages(recipient, state, created_at);

      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT,
        type TEXT NOT NULL,
        at TEXT NOT NULL,
        details TEXT,
        FOREIGN KEY(message_id) REFERENCES messages(id)
      ) STRICT;
    `);
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  event(messageIdValue, type, details = undefined) {
    this.db.prepare("INSERT INTO events(message_id, type, at, details) VALUES (?, ?, ?, ?)")
      .run(messageIdValue ?? null, type, now(), details === undefined ? null : JSON.stringify(details));
  }

  recoverInterruptedDeliveries() {
    return this.transaction(() => {
      const interrupted = this.db.prepare("SELECT id FROM messages WHERE state = 'injecting'").all();
      const timestamp = now();
      const update = this.db.prepare(`
        UPDATE messages
        SET state = 'uncertain', updated_at = ?, last_error = ?
        WHERE id = ? AND state = 'injecting'
      `);
      for (const row of interrupted) {
        update.run(timestamp, "daemon restarted during injection", row.id);
        this.event(row.id, "delivery_uncertain", { reason: "daemon_restart" });
      }
      return interrupted.length;
    });
  }

  registerAgent({ id, adapter, tmuxSocket, paneId, panePid, paneCommand }) {
    validateAgentId(id);
    assertRelay(typeof adapter === "string" && adapter.length > 0 && adapter.length <= 64, "invalid_adapter", "adapter is required");
    assertRelay(typeof tmuxSocket === "string" && tmuxSocket.startsWith("/"), "invalid_tmux_socket", "tmux socket must be an absolute path");
    assertRelay(typeof paneId === "string" && /^%\d+$/.test(paneId), "invalid_pane", "tmux pane must look like %12");
    assertRelay(Number.isSafeInteger(panePid) && panePid > 0, "invalid_pane_pid", "tmux pane PID must be a positive integer");
    assertRelay(typeof paneCommand === "string" && paneCommand.length > 0 && paneCommand.length <= 256, "invalid_pane_command", "tmux pane command is required");

    const timestamp = now();
    this.db.prepare(`
      INSERT INTO agents(id, adapter, tmux_socket, pane_id, pane_pid, pane_command, registered_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        adapter = excluded.adapter,
        tmux_socket = excluded.tmux_socket,
        pane_id = excluded.pane_id,
        pane_pid = excluded.pane_pid,
        pane_command = excluded.pane_command,
        generation = agents.generation + 1,
        registered_at = excluded.registered_at,
        updated_at = excluded.updated_at,
        last_error = NULL
    `).run(id, adapter, tmuxSocket, paneId, panePid, paneCommand, timestamp, timestamp);
    this.event(null, "agent_registered", { id, adapter, tmuxSocket, paneId, panePid, paneCommand });
    return this.getAgent(id);
  }

  getAgent(id) {
    validateAgentId(id);
    return mapAgent(this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id));
  }

  listAgents() {
    return this.db.prepare("SELECT * FROM agents ORDER BY id").all().map(mapAgent);
  }

  setAgentError(id, error = null) {
    this.db.prepare("UPDATE agents SET last_error = ?, updated_at = ? WHERE id = ?").run(error, now(), id);
  }

  createMessage({ sender, recipient, parentId = null, mode = "next", body, idempotencyKey = null }) {
    validateAgentId(sender, "sender");
    validateAgentId(recipient, "recipient");
    validateMode(mode);
    validateBody(body);
    if (parentId !== null) validateMessageId(parentId);
    assertRelay(idempotencyKey === null || (typeof idempotencyKey === "string" && idempotencyKey.length > 0 && idempotencyKey.length <= 256), "invalid_idempotency_key", "idempotency key must contain 1-256 characters");

    return this.transaction(() => {
      if (idempotencyKey !== null) {
        const existing = this.db.prepare("SELECT * FROM messages WHERE sender = ? AND idempotency_key = ?")
          .get(sender, idempotencyKey);
        if (existing) return { message: mapMessage(existing), created: false };
      }

      const id = messageId();
      const timestamp = now();
      this.db.prepare(`
        INSERT INTO messages(
          id, sender, recipient, parent_id, mode, body, state,
          idempotency_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
      `).run(id, sender, recipient, parentId, mode, body, idempotencyKey, timestamp, timestamp);
      this.event(id, "message_queued", { sender, recipient, parentId, mode });
      return { message: this.getMessage(id), created: true };
    });
  }

  getMessage(id, { includeBody = true } = {}) {
    validateMessageId(id);
    return mapMessage(this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id), includeBody);
  }

  requireMessage(id) {
    const message = this.getMessage(id);
    if (!message) throw new RelayError("message_not_found", `message ${id} does not exist`);
    return message;
  }

  listInbox(agent, { state = null, limit = 50, includeBody = false } = {}) {
    validateAgentId(agent);
    assertRelay(Number.isSafeInteger(limit) && limit > 0 && limit <= 500, "invalid_limit", "limit must be between 1 and 500");
    if (state !== null) {
      assertRelay(MESSAGE_STATES.has(state), "invalid_state", `unknown message state: ${state}`);
      return this.db.prepare("SELECT * FROM messages WHERE recipient = ? AND state = ? ORDER BY created_at LIMIT ?")
        .all(agent, state, limit).map((row) => mapMessage(row, includeBody));
    }
    return this.db.prepare("SELECT * FROM messages WHERE recipient = ? ORDER BY created_at DESC LIMIT ?")
      .all(agent, limit).map((row) => mapMessage(row, includeBody));
  }

  nextQueued(recipient) {
    validateAgentId(recipient);
    return mapMessage(this.db.prepare(`
      SELECT * FROM messages
      WHERE recipient = ? AND state = 'queued'
      ORDER BY CASE mode WHEN 'now' THEN 0 ELSE 1 END, created_at
      LIMIT 1
    `).get(recipient));
  }

  hasOpenMessage(recipient, exceptId = null) {
    validateAgentId(recipient);
    const row = this.db.prepare(`
      SELECT id FROM messages
      WHERE recipient = ?
        AND state IN ('injecting', 'injected', 'uncertain', 'accepted')
        AND (? IS NULL OR id != ?)
      LIMIT 1
    `).get(recipient, exceptId, exceptId);
    return Boolean(row);
  }

  markInjecting(id) {
    return this.transition(id, ["queued"], "injecting", "delivery_started", {
      attemptsDelta: 1,
      clearError: true,
    });
  }

  markInjected(id) {
    return this.transition(id, ["injecting"], "injected", "message_injected", {
      timestampField: "injected_at",
      clearError: true,
    });
  }

  markDeliveryFailure(id, { uncertain, error }) {
    return this.transition(id, ["injecting"], uncertain ? "uncertain" : "queued", uncertain ? "delivery_uncertain" : "delivery_deferred", {
      error,
    });
  }

  acceptMessage(id, agent) {
    validateAgentId(agent);
    const existing = this.requireMessage(id);
    assertRelay(existing.recipient === agent, "wrong_recipient", `${agent} is not the recipient of ${id}`);
    if (["accepted", "completed", "failed"].includes(existing.state)) return existing;
    return this.transition(id, ["injected", "uncertain"], "accepted", "message_accepted", {
      timestampField: "accepted_at",
      details: { agent },
    });
  }

  finishMessage(id, agent, state, result) {
    validateAgentId(agent);
    assertRelay(state === "completed" || state === "failed", "invalid_finish_state", "finish state must be completed or failed");
    assertRelay(typeof result === "string" && Buffer.byteLength(result, "utf8") <= 64 * 1024, "result_too_large", "result exceeds 64 KiB");
    const existing = this.requireMessage(id);
    assertRelay(existing.recipient === agent, "wrong_recipient", `${agent} is not the recipient of ${id}`);
    if (existing.state === state) return existing;
    return this.transition(id, ["accepted"], state, state === "completed" ? "message_completed" : "message_failed", {
      timestampField: "completed_at",
      result,
      details: { agent },
    });
  }

  requeueMessage(id, force) {
    const existing = this.requireMessage(id);
    if (existing.state === "queued") return existing;
    assertRelay(force === true, "retry_requires_force", "retrying an injected or uncertain message requires --force");
    return this.transition(id, ["injected", "uncertain"], "queued", "message_requeued", {
      details: { forced: true },
    });
  }

  transition(id, fromStates, toState, eventType, options = {}) {
    validateMessageId(id);
    assertRelay(MESSAGE_STATES.has(toState), "invalid_state", `unknown target state: ${toState}`);
    return this.transaction(() => {
      const current = this.requireMessage(id);
      assertRelay(fromStates.includes(current.state), "invalid_transition", `cannot move ${id} from ${current.state} to ${toState}`);
      const timestamp = now();
      const fields = ["state = ?", "updated_at = ?"];
      const params = [toState, timestamp];
      if (options.attemptsDelta) fields.push(`attempts = attempts + ${Number(options.attemptsDelta)}`);
      if (options.timestampField) {
        assertRelay(["injected_at", "accepted_at", "completed_at"].includes(options.timestampField), "invalid_timestamp_field", "invalid timestamp field");
        fields.push(`${options.timestampField} = ?`);
        params.push(timestamp);
      }
      if (options.clearError) fields.push("last_error = NULL");
      if (Object.hasOwn(options, "error")) {
        fields.push("last_error = ?");
        params.push(options.error);
      }
      if (Object.hasOwn(options, "result")) {
        fields.push("result = ?");
        params.push(options.result);
      }
      params.push(id);
      this.db.prepare(`UPDATE messages SET ${fields.join(", ")} WHERE id = ?`).run(...params);
      this.event(id, eventType, options.details);
      return this.requireMessage(id);
    });
  }

  events(id) {
    validateMessageId(id);
    return this.db.prepare("SELECT * FROM events WHERE message_id = ? ORDER BY sequence").all(id).map((row) => ({
      sequence: row.sequence,
      type: row.type,
      at: row.at,
      details: parseDetails(row.details),
    }));
  }

  status() {
    const states = Object.fromEntries([...MESSAGE_STATES].map((state) => [state, 0]));
    for (const row of this.db.prepare("SELECT state, COUNT(*) AS count FROM messages GROUP BY state").all()) {
      states[row.state] = Number(row.count);
    }
    return { agents: this.listAgents(), messages: states };
  }
}
