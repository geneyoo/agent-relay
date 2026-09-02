import { assertRelay } from "./errors.js";

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MESSAGE_ID = /^msg_[0-9a-f]{32}$/;

export function validateAgentId(value, field = "agent") {
  assertRelay(typeof value === "string" && AGENT_ID.test(value), "invalid_agent", `${field} must match ${AGENT_ID}`);
  return value;
}

export function validateMessageId(value) {
  assertRelay(typeof value === "string" && MESSAGE_ID.test(value), "invalid_message_id", "invalid message ID");
  return value;
}

export function validateMode(value) {
  assertRelay(value === "now" || value === "next", "invalid_mode", "mode must be 'now' or 'next'");
  return value;
}

export function validateBody(value) {
  assertRelay(typeof value === "string", "invalid_body", "message body must be text");
  assertRelay(value.length > 0, "empty_body", "message body must not be empty");
  assertRelay(Buffer.byteLength(value, "utf8") <= 64 * 1024, "body_too_large", "message body exceeds 64 KiB");
  assertRelay(!value.includes("\0"), "invalid_body", "message body must not contain NUL bytes");
  return value;
}
