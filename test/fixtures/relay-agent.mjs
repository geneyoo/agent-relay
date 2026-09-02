import { execFile } from "node:child_process";
import readline from "node:readline";
import { promisify } from "node:util";

const run = promisify(execFile);
const relayBin = process.env.AGENT_RELAY_BIN;
const socketPath = process.env.AGENT_RELAY_SOCKET;
let messageId;
let handled = false;

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  const match = line.match(/^\[relay (msg_[0-9a-f]{32}) from=/);
  if (match) messageId = match[1];
  if (line !== "[/relay]" || !messageId || handled) return;
  handled = true;
  try {
    await run(process.execPath, [relayBin, "ack", messageId, "--socket", socketPath]);
    await run(process.execPath, [relayBin, "done", messageId, "fixture completed", "--socket", socketPath]);
    process.stdout.write(`E2E:DONE:${messageId}\n`);
  } catch (error) {
    process.stderr.write(`E2E:ERROR:${error.stderr || error.message}\n`);
  }
});
