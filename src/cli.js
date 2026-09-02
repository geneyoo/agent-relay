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
  relay register NAME [--adapter tmux|claude|codex] [--pane %N]
  relay start NAME [--adapter tmux|claude|codex] -- COMMAND [ARG...]
  relay send RECIPIENT [MESSAGE] [--from NAME] [--mode now|next] [--stdin]
  relay accept MESSAGE_ID [--agent NAME]
  relay complete MESSAGE_ID [RESULT] [--agent NAME] [--stdin]
  relay fail MESSAGE_ID [RESULT] [--agent NAME] [--stdin]
  relay show MESSAGE_ID
  relay inbox [--agent NAME] [--state STATE] [--include-body]
  relay agents
  relay status
  relay wait MESSAGE_ID [--for accepted|completed] [--timeout SECONDS]
  relay retry MESSAGE_ID --force
  relay instructions

Global options:
  --socket PATH   Override the Unix socket path
  --json          Emit machine-readable JSON
  -h, --help      Show this help
`;

const AGENT_INSTRUCTIONS = `When input begins with [relay id=...], treat it as a durable relay message.
First run the exact "relay accept" command included in the envelope. Do not repeat work for a message that is already accepted or completed. Complete the requested work, then send a concise result through the included "relay complete" command using --stdin. If the work cannot be completed, use "relay fail" instead. Never claim relay acceptance or completion without running the corresponding command.`;

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

function agentFrom(options) {
  return options.agent || process.env.AGENT_RELAY_AGENT;
}

function tmuxCoordinates(options) {
  const paneId = options.pane || process.env.TMUX_PANE;
  const tmuxSocket = options["tmux-socket"] || process.env.TMUX?.split(",", 1)[0];
  assertRelay(paneId, "pane_required", "no tmux pane found; run inside tmux or pass --pane");
  assertRelay(tmuxSocket, "tmux_socket_required", "no tmux socket found; run inside tmux or pass --tmux-socket");
  return { paneId, tmuxSocket };
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
      if (error.code !== "adapter_not_ready") break;
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
    case "register": {
      const id = parsed.positional[0];
      assertRelay(id, "agent_required", "register requires an agent name");
      const result = await client.register({
        id,
        adapter: parsed.options.adapter || "tmux",
        ...tmuxCoordinates(parsed.options),
      });
      print(parsed.options.json ? result : `${result.id} -> ${result.paneId} (${result.adapter})`, parsed.options.json);
      return;
    }
    case "start": {
      const id = parsed.positional[0];
      assertRelay(id, "agent_required", "start requires an agent name");
      await runRegisteredCommand(id, parsed.options.adapter || "tmux", parsed.rest[0], parsed.rest.slice(1), parsed.options);
      return;
    }
    case "send": {
      const recipient = parsed.positional[0];
      assertRelay(recipient, "recipient_required", "send requires a recipient");
      const body = await bodyFrom(parsed, 1);
      const result = await client.send({
        sender: parsed.options.from || process.env.AGENT_RELAY_AGENT || "human",
        recipient,
        parentId: parsed.options.parent || null,
        mode: parsed.options.mode || "next",
        idempotencyKey: parsed.options.key || null,
        body,
      });
      print(parsed.options.json ? result : `${result.message.id} ${result.message.state}${result.created ? "" : " (existing)"}`, parsed.options.json);
      return;
    }
    case "accept": {
      const id = parsed.positional[0];
      const agent = agentFrom(parsed.options);
      assertRelay(id, "message_required", "accept requires a message ID");
      assertRelay(agent, "agent_required", "accept requires --agent or AGENT_RELAY_AGENT");
      const result = await client.accept(id, agent);
      print(parsed.options.json ? result : `${result.id} ${result.state}`, parsed.options.json);
      return;
    }
    case "complete":
    case "fail": {
      const id = parsed.positional[0];
      const agent = agentFrom(parsed.options);
      assertRelay(id, "message_required", `${command} requires a message ID`);
      assertRelay(agent, "agent_required", `${command} requires --agent or AGENT_RELAY_AGENT`);
      const resultBody = await bodyFrom(parsed, 1, { allowEmpty: true });
      const result = command === "complete"
        ? await client.complete(id, agent, resultBody)
        : await client.fail(id, agent, resultBody);
      print(parsed.options.json ? result : `${result.id} ${result.state}`, parsed.options.json);
      return;
    }
    case "show": {
      const id = parsed.positional[0];
      assertRelay(id, "message_required", "show requires a message ID");
      print(await client.show(id), parsed.options.json);
      return;
    }
    case "inbox": {
      const agent = agentFrom(parsed.options);
      assertRelay(agent, "agent_required", "inbox requires --agent or AGENT_RELAY_AGENT");
      const limit = Number(parsed.options.limit || 50);
      print(await client.inbox(agent, {
        state: parsed.options.state || null,
        limit,
        includeBody: parsed.options["include-body"] === true,
      }), parsed.options.json);
      return;
    }
    case "agents":
      print(await client.agents(), parsed.options.json);
      return;
    case "status":
      print(await client.status(), parsed.options.json);
      return;
    case "wait": {
      const id = parsed.positional[0];
      const target = parsed.options.for || "completed";
      assertRelay(id, "message_required", "wait requires a message ID");
      assertRelay(target === "accepted" || target === "completed", "invalid_wait_target", "--for must be accepted or completed");
      const timeoutSeconds = Number(parsed.options.timeout || 0);
      assertRelay(Number.isFinite(timeoutSeconds) && timeoutSeconds >= 0, "invalid_timeout", "timeout must be a non-negative number");
      const deadline = timeoutSeconds === 0 ? Infinity : Date.now() + timeoutSeconds * 1000;
      while (true) {
        const result = await client.show(id);
        if (messageReached(result, target)) {
          if (target === "completed" && result.state !== "completed") {
            throw new RelayError("message_not_completed", `${id} finished as ${result.state}`);
          }
          print(parsed.options.json ? result : `${result.id} ${result.state}`, parsed.options.json);
          return;
        }
        if (["failed", "cancelled"].includes(result.state)) {
          throw new RelayError("message_terminal", `${id} finished as ${result.state}`);
        }
        if (Date.now() >= deadline) throw new RelayError("wait_timeout", `timed out waiting for ${id} to become ${target}`);
        await sleep(250);
      }
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
