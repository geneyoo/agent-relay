import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RelayClient } from "../src/client.js";
import { RelayDaemon } from "../src/daemon.js";

const tmuxAvailable = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;

function tmux(socketPath, args) {
  return spawnSync("tmux", ["-S", socketPath, ...args], { encoding: "utf8" });
}

test("public CLI completes a durable task delivered through a real tmux pane", { skip: !tmuxAvailable }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-relay-e2e-"));
  const relaySocket = path.join(directory, "relay.sock");
  const tmuxSocket = path.join(directory, "tmux.sock");
  const daemon = new RelayDaemon({
    socketPath: relaySocket,
    statePath: path.join(directory, "relay.sqlite"),
  });

  try {
    await daemon.listen();
    const fixture = path.resolve("test/fixtures/relay-agent.mjs");
    const relayBin = path.resolve("bin/relay.js");
    const command = `env AGENT_RELAY_BIN=${relayBin} AGENT_RELAY_SOCKET=${relaySocket} ${process.execPath} ${fixture}`;
    const created = tmux(tmuxSocket, ["new-session", "-d", "-s", "relay-e2e", command]);
    assert.equal(created.status, 0, created.stderr);

    const paneResult = tmux(tmuxSocket, ["list-panes", "-t", "relay-e2e", "-F", "#{pane_id}"]);
    assert.equal(paneResult.status, 0, paneResult.stderr);
    const paneId = paneResult.stdout.trim();

    const client = new RelayClient({ socketPath: relaySocket });
    await client.register({
      id: "fixture-worker",
      adapter: "tmux",
      tmuxSocket,
      paneId,
    });
    const sent = await client.send({
      sender: "coordinator",
      recipient: "fixture-worker",
      body: "Complete the deterministic fixture",
    });
    assert.equal(sent.message.state, "injected");

    let completed;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const current = await client.show(sent.message.id);
      if (current.state === "completed") {
        completed = current;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(completed, `message ${sent.message.id} did not complete`);
    assert.equal(completed.result, "fixture completed");
    assert.deepEqual(completed.events.map((event) => event.type), [
      "message_queued",
      "delivery_started",
      "message_injected",
      "message_accepted",
      "message_completed",
    ]);
  } finally {
    tmux(tmuxSocket, ["kill-server"]);
    await daemon.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
