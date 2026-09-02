import os from "node:os";
import path from "node:path";

export function defaultSocketPath(env = process.env) {
  const runtimeRoot = env.XDG_RUNTIME_DIR || path.join(os.tmpdir(), `agent-relay-${process.getuid?.() ?? "user"}`);
  return path.join(runtimeRoot, "agent-relay.sock");
}

export function defaultStatePath(env = process.env) {
  const stateRoot = env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(stateRoot, "agent-relay", "relay.sqlite");
}
