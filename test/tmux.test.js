import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TmuxDelivery } from "../src/tmux.js";

const tmuxAvailable = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;

function tmux(socketPath, args) {
  return spawnSync("tmux", ["-S", socketPath, ...args], { encoding: "utf8" });
}

test("tmux adapter pastes the envelope and submits Enter separately", { skip: !tmuxAvailable }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-relay-tmux-"));
  const socketPath = path.join(directory, "tmux.sock");
  const fixture = path.resolve("test/fixtures/line-reader.mjs");
  const command = `${process.execPath} ${fixture}`;
  const created = tmux(socketPath, ["new-session", "-d", "-s", "relay-test", command]);
  assert.equal(created.status, 0, created.stderr);

  t.after(() => {
    tmux(socketPath, ["kill-server"]);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const paneResult = tmux(socketPath, ["list-panes", "-t", "relay-test", "-F", "#{pane_id}"]);
  assert.equal(paneResult.status, 0, paneResult.stderr);
  const paneId = paneResult.stdout.trim();

  const delivery = new TmuxDelivery();
  const fingerprint = await delivery.inspect({ tmuxSocket: socketPath, paneId });
  await delivery.deliver(
    {
      id: "reviewer",
      adapter: "claude",
      tmuxSocket: socketPath,
      paneId,
      panePid: fingerprint.panePid,
      paneCommand: fingerprint.paneCommand,
    },
    {
      id: `msg_${"a".repeat(32)}`,
      sender: "coordinator",
      recipient: "reviewer",
      mode: "now",
      body: "Line one\nLine two with 'quotes' and $dollars",
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 100));
  const captured = tmux(socketPath, ["capture-pane", "-p", "-J", "-t", paneId, "-S", "-100"]);
  assert.equal(captured.status, 0, captured.stderr);
  assert.match(captured.stdout, /RECEIVED:\[relay id=msg_a{32} from=coordinator mode=now\]/);
  assert.match(captured.stdout, /RECEIVED:Line one/);
  assert.match(captured.stdout, /RECEIVED:Line two with 'quotes' and \$dollars/);
  assert.match(captured.stdout, /RECEIVED:\[\/relay\]/);
});
