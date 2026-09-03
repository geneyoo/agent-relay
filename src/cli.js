import fs from "node:fs";
import { spawn } from "node:child_process";

import { RelayClient } from "./client.js";
import { RelayDaemon } from "./daemon.js";
import { RelayError, assertRelay } from "./errors.js";
import { defaultSocketPath, defaultStatePath } from "./paths.js";

const HELP = `agent-relay: durable messaging for agents in tmux panes

Usage:
  relay daemon run [--socket PATH] [--state PATH]
  relay daemon ping [--socket PATH]
  relay join NAME
  relay start NAME -- COMMAND [ARG...]
  relay ask RECIPIENT MESSAGE [--accept-timeout SECONDS] [--timeout SECONDS]
  relay send RECIPIENT MESSAGE
  relay queue RECIPIENT MESSAGE
  relay ack MESSAGE_ID
  relay done MESSAGE_ID RESULT
  relay fail MESSAGE_ID RESULT
  relay cancel MESSAGE_ID [--force]
  relay result MESSAGE_ID
  relay show MESSAGE_ID
  relay inbox [--agent NAME] [--state STATE] [--include-body]
  relay peers
  relay whoami
  relay doctor
  relay status
  relay wait MESSAGE_ID [--for accepted|completed] [--timeout SECONDS]
  relay retry MESSAGE_ID --force
  relay instructions

Advanced:
  relay register NAME [--adapter auto|tmux|claude|codex] [--pane %N]
  relay agents
  relay accept MESSAGE_ID [--agent NAME]
  relay complete MESSAGE_ID RESULT [--agent NAME] [--stdin]

Global options:
  --socket PATH   Override the Unix socket path
  --json          Emit machine-readable JSON
  -h, --help      Show this help
`;

const AGENT_INSTRUCTIONS = [
  "Use agent-relay instead of tmux send-keys when communicating with another terminal agent.",
  'Run `relay peers` to discover available agents and `relay ask NAME "task"` when you need a response.',
  "",
  "When input begins with `[relay MESSAGE_ID from=NAME]`, it is a durable relay task.",
  "Immediately run the exact `relay ack` command in the envelope. Do not repeat work for a message already accepted or completed.",
  "Complete the task, then run the exact `relay done` command with a concise result, or `relay fail` with the reason.",
  "Never claim acknowledgement or completion without running the corresponding relay command.",
].join("\n");

function parseArgs(tokens) {
  const positional = [];
  const options = {};
  let rest = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") {
      rest = tokens.slice(index + 1);
      break;
    }
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const name = token.slice(2, equals === -1 ? undefined : equals);
    if (["json", "stdin", "force", "include-body", "help"].includes(name)) {
      options[name] = true;
      continue;
    }
    if (equals !== -1) {
      options[name] = token.slice(equals + 1);
      continue;
    }
    const value = tokens[index + 1];
    assertRelay(value !== undefined && value !== "--", "missing_option_value", `--${name} requires a value`);
    options[name] = value;
    index += 1;
  }
  return { positional, options, rest };
}

function socketFrom(options) {
  return options.socket || process.env.AGENT_RELAY_SOCKET || defaultSocketPath();
}

function clientFrom(options) {
  return new RelayClient({ socketPath: socketFrom(options) });
}

function tmuxCoordinates(options) {
  const paneId = options.pane || process.env.TMUX_PANE;
  const tmuxSocket = options["tmux-socket"] || process.env.TMUX?.split(",", 1)[0];
  assertRelay(paneId, "pane_required", "no tmux pane found; run inside tmux or pass --pane");
  assertRelay(tmuxSocket, "tmux_socket_required", "no tmux socket found; run inside tmux or pass --tmux-socket");
  return { paneId, tmuxSocket };
}

function availableTmuxCoordinates(options = {}) {
  const paneId = options.pane || process.env.TMUX_PANE;
  const tmuxSocket = options["tmux-socket"] || process.env.TMUX?.split(",", 1)[0];
  return paneId && tmuxSocket ? { paneId, tmuxSocket } : null;
}

async function identifyCurrentAgent(client, options = {}) {
  if (options.agent) return options.agent;
  const environmentAgent = process.env.AGENT_RELAY_AGENT || null;
  if (environmentAgent) return environmentAgent;
  const coordinates = availableTmuxCoordinates(options);
  if (!coordinates) return null;
  const agent = await client.identify(coordinates);
  return agent?.id ?? null;
}

async function senderFrom(client, options) {
  return options.from || await identifyCurrentAgent(client, options) || "human";
}

async function stdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function bodyFrom(parsed, startIndex, { allowEmpty = false } = {}) {
  if (parsed.options.stdin || (!process.stdin.isTTY && parsed.positional.length <= startIndex)) {
    const body = await stdinText();
    if (!allowEmpty) assertRelay(body.length > 0, "empty_body", "stdin contained no message body");
    return body;
  }
  const body = parsed.positional.slice(startIndex).join(" ");
  if (!allowEmpty) assertRelay(body.length > 0, "empty_body", "provide a message or use --stdin");
  return body;
}

function print(value, json = false) {
  if (json || typeof value !== "string") {
    process.stdout.write(`${JSON.stringify(value, null, json ? 0 : 2)}\n`);
  } else {
    process.stdout.write(`${value}\n`);
  }
}

function messageReached(message, target) {
  if (target === "accepted") return ["accepted", "completed", "failed"].includes(message.state);
  return message.state === "completed";
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForMessage(client, id, target, timeoutSeconds = 0) {
  assertRelay(target === "accepted" || target === "completed", "invalid_wait_target", "wait target must be accepted or completed");
  assertRelay(Number.isFinite(timeoutSeconds) && timeoutSeconds >= 0, "invalid_timeout", "timeout must be a non-negative number");
  const deadline = timeoutSeconds === 0 ? Infinity : Date.now() + timeoutSeconds * 1000;
  while (true) {
    const result = await client.show(id);
    if (messageReached(result, target)) return result;
    if (["failed", "cancelled"].includes(result.state)) {
      throw new RelayError("message_terminal", `${id} finished as ${result.state}${result.result ? `: ${result.result}` : ""}`);
    }
    if (Date.now() >= deadline) throw new RelayError("wait_timeout", `timed out waiting for ${id} to become ${target}`);
    await sleep(250);
  }
}

async function doctor(options) {
  const checks = [];
  const client = clientFrom(options);
  try {
    const ping = await client.ping();
    checks.push({ name: "daemon", ok: true, detail: `protocol ${ping.version}, pid ${ping.pid}` });
  } catch (error) {
    checks.push({ name: "daemon", ok: false, detail: error.message });
  }

  const coordinates = availableTmuxCoordinates(options);
  if (coordinates) {
    checks.push({ name: "tmux", ok: true, detail: coordinates.paneId });
    try {
      const agent = await client.identify(coordinates);
      checks.push(agent
        ? { name: "identity", ok: true, detail: `${agent.id} (${agent.adapter})` }
        : { name: "identity", ok: false, detail: "current pane has not joined; run relay join NAME from the agent" });
    } catch (error) {
      checks.push({ name: "identity", ok: false, detail: error.message });
    }
  } else {
    checks.push({ name: "tmux", ok: true, detail: "not in tmux; remote client mode" });
  }

  for (const [name, filename] of [
    ["codex instructions", `${process.env.HOME}/.codex/AGENTS.md`],
    ["claude instructions", `${process.env.HOME}/.claude/CLAUDE.md`],
  ]) {
    checks.push({ name, ok: fs.existsSync(filename), detail: filename });
  }

  const ok = checks.every((check) => check.ok);
  if (options.json) print({ ok, checks }, true);
  else {
    for (const check of checks) process.stdout.write(`${check.ok ? "ok" : "FAIL"}\t${check.name}\t${check.detail}\n`);
  }
  if (!ok) process.exitCode = 1;
}

async function runDaemon(parsed) {
  process.umask(0o077);
  const socketPath = socketFrom(parsed.options);
  const statePath = parsed.options.state || process.env.AGENT_RELAY_STATE || defaultStatePath();
  const daemon = new RelayDaemon({ socketPath, statePath });
  await daemon.listen();
  process.stdout.write(`agent-relay listening on ${socketPath}\n`);

  await new Promise((resolve, reject) => {
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      try {
        await daemon.close();
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function runRegisteredCommand(name, adapter, command, commandArgs, options) {
  assertRelay(command, "command_required", "relay start requires a command after --");
  const client = clientFrom(options);
  const coordinates = tmuxCoordinates(options);
  const child = spawn(command, commandArgs, {
    stdio: "inherit",
    env: {
      ...process.env,
      AGENT_RELAY_AGENT: name,
      AGENT_RELAY_SOCKET: socketFrom(options),
    },
  });

  const spawned = new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (error) => {
      if (error.code === "ENOENT") reject(new RelayError("command_not_found", `command not found: ${command}`));
      else reject(error);
    });
  });
  const exited = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve(signal ? 128 : (code ?? 1)));
  });

  await spawned;
  const deadline = Date.now() + Number(options["ready-timeout"] || 5000);
  let registered = false;
  let lastError;
  while (!registered && Date.now() < deadline) {
    try {
      await client.register({ id: name, adapter, ...coordinates });
      registered = true;
    } catch (error) {
      lastError = error;
      if (error.code !== "adapter_not_ready" && error.code !== "adapter_not_detected") break;
      await sleep(100);
    }
  }
  if (!registered) {
    child.kill("SIGTERM");
    throw lastError ?? new RelayError("adapter_not_ready", `${adapter} did not become ready`);
  }

  const exitCode = await exited;
  process.exitCode = exitCode;
}

export async function main(argv) {
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP);
    return;
  }

  const command = argv[0];
  const subcommand = argv[1];

  if (command === "daemon") {
    const parsed = parseArgs(argv.slice(2));
    if (subcommand === "run") return runDaemon(parsed);
    if (subcommand === "ping") {
      const result = await clientFrom(parsed.options).ping();
      print(result, parsed.options.json);
      return;
    }
    throw new RelayError("unknown_command", "use 'relay daemon run' or 'relay daemon ping'");
  }

  if (command === "instructions") {
    process.stdout.write(`${AGENT_INSTRUCTIONS}\n`);
    return;
  }

  const parsed = parseArgs(argv.slice(1));
  const client = clientFrom(parsed.options);

  switch (command) {
    case "join":
    case "register": {
      const id = parsed.positional[0];
      assertRelay(id, "agent_required", `${command} requires an agent name`);
      const result = await client.register({
        id,
        adapter: parsed.options.adapter || "auto",
        ...tmuxCoordinates(parsed.options),
      });
      print(parsed.options.json ? result : `joined as ${result.id} (${result.adapter}, ${result.paneId})`, parsed.options.json);
      return;
    }
    case "start": {
      const id = parsed.positional[0];
      assertRelay(id, "agent_required", "start requires an agent name");
      await runRegisteredCommand(id, parsed.options.adapter || "auto", parsed.rest[0], parsed.rest.slice(1), parsed.options);
      return;
    }
    case "ask":
    case "send":
    case "queue": {
      const recipient = parsed.positional[0];
      assertRelay(recipient, "recipient_required", `${command} requires a recipient`);
      const body = await bodyFrom(parsed, 1);
      if (command === "ask") {
        const peers = await client.agents();
        const peer = peers.find((candidate) => candidate.id === recipient);
        assertRelay(peer, "unknown_recipient", `${recipient} has not joined the relay`);
        assertRelay(peer.online, "recipient_offline", `${recipient} is not currently reachable; use relay send or relay queue for durable offline delivery`);
      }
      const result = await client.send({
        sender: await senderFrom(client, parsed.options),
        recipient,
        parentId: parsed.options.parent || null,
        mode: parsed.options.mode || (command === "queue" ? "next" : "now"),
        idempotencyKey: parsed.options.key || null,
        body,
      });
      if (command !== "ask") {
        print(parsed.options.json ? result : result.message.id, parsed.options.json);
        return;
      }

      if (!parsed.options.json) process.stderr.write(`relay: ${result.message.id} persisted; waiting for ${recipient}\n`);
      const acceptTimeout = Number(parsed.options["accept-timeout"] || 120);
      await waitForMessage(client, result.message.id, "accepted", acceptTimeout);
      const completed = await waitForMessage(client, result.message.id, "completed", Number(parsed.options.timeout || 0));
      print(parsed.options.json ? completed : (completed.result || `${completed.id} completed`), parsed.options.json);
      return;
    }
    case "ack":
    case "accept": {
      const id = parsed.positional[0];
      assertRelay(id, "message_required", `${command} requires a message ID`);
      const agent = await identifyCurrentAgent(client, parsed.options);
      assertRelay(agent, "agent_required", `${command} must run from the recipient's joined pane or use --agent NAME`);
      const result = await client.accept(id, agent);
      const acknowledgement = result.acceptedNow ? `acknowledged ${result.id}` : `${result.id} already ${result.state}`;
      print(parsed.options.json ? result : acknowledgement, parsed.options.json);
      return;
    }
    case "done":
    case "complete":
    case "fail": {
      const id = parsed.positional[0];
      assertRelay(id, "message_required", `${command} requires a message ID`);
      const resultBody = await bodyFrom(parsed, 1);
      const agent = await identifyCurrentAgent(client, parsed.options);
      assertRelay(agent, "agent_required", `${command} must run from the recipient's joined pane or use --agent NAME`);
      const result = command === "fail"
        ? await client.fail(id, resultBody, agent)
        : await client.complete(id, resultBody, agent);
      print(parsed.options.json ? result : `${result.state} ${result.id}`, parsed.options.json);
      return;
    }
    case "cancel": {
      const id = parsed.positional[0];
      assertRelay(id, "message_required", "cancel requires a message ID");
      const sender = await senderFrom(client, parsed.options);
      const result = await client.cancel(id, sender, parsed.options.force === true);
      print(parsed.options.json ? result : `cancelled ${result.id}`, parsed.options.json);
      return;
    }
    case "show": {
      const id = parsed.positional[0];
      assertRelay(id, "message_required", "show requires a message ID");
      print(await client.show(id), parsed.options.json);
      return;
    }
    case "result": {
      const id = parsed.positional[0];
      assertRelay(id, "message_required", "result requires a message ID");
      const result = await client.show(id);
      assertRelay(result.state === "completed", "result_not_ready", `${id} is ${result.state}`);
      print(parsed.options.json ? result : result.result, parsed.options.json);
      return;
    }
    case "inbox": {
      const agent = await identifyCurrentAgent(client, parsed.options);
      assertRelay(agent, "agent_required", "inbox requires a joined pane or --agent NAME");
      const limit = Number(parsed.options.limit || 50);
      print(await client.inbox(agent, {
        state: parsed.options.state || null,
        limit,
        includeBody: parsed.options["include-body"] === true,
      }), parsed.options.json);
      return;
    }
    case "peers":
    case "agents":
      {
        const agents = await client.agents();
        if (parsed.options.json) print(agents, true);
        else if (agents.length === 0) process.stdout.write("no agents have joined\n");
        else for (const agent of agents) process.stdout.write(`${agent.id}\t${agent.online ? "online" : "offline"}\t${agent.adapter}\t${agent.paneId}${agent.lastError ? `\t${agent.lastError}` : ""}\n`);
      }
      return;
    case "whoami": {
      const coordinates = availableTmuxCoordinates(parsed.options);
      assertRelay(coordinates, "tmux_required", "whoami must run from tmux");
      const agent = await client.identify(coordinates);
      assertRelay(agent, "not_joined", "this pane has not joined; run relay join NAME from the agent");
      print(parsed.options.json ? agent : agent.id, parsed.options.json);
      return;
    }
    case "doctor":
      await doctor(parsed.options);
      return;
    case "status":
      print(await client.status(), parsed.options.json);
      return;
    case "wait": {
      const id = parsed.positional[0];
      const target = parsed.options.for || "completed";
      assertRelay(id, "message_required", "wait requires a message ID");
      const timeoutSeconds = Number(parsed.options.timeout || 0);
      const result = await waitForMessage(client, id, target, timeoutSeconds);
      if (target === "completed" && result.state !== "completed") throw new RelayError("message_not_completed", `${id} finished as ${result.state}`);
      print(parsed.options.json ? result : `${result.id} ${result.state}`, parsed.options.json);
      return;
    }
    case "retry": {
      const id = parsed.positional[0];
      assertRelay(id, "message_required", "retry requires a message ID");
      const result = await client.retry(id, parsed.options.force === true);
      print(parsed.options.json ? result : `${result.id} ${result.state}`, parsed.options.json);
      return;
    }
    default:
      throw new RelayError("unknown_command", `unknown command: ${command}`);
  }
}

export { AGENT_INSTRUCTIONS, HELP };
