import assert from "node:assert/strict";
import test from "node:test";

import { RelayError } from "../src/errors.js";
import { TmuxDelivery } from "../src/tmux.js";

const MESSAGE = {
  id: `msg_${"a".repeat(32)}`,
  sender: "coordinator",
  recipient: "worker",
  mode: "now",
  body: "Do the bounded task",
};

const AGENT = {
  id: "worker",
  adapter: "codex",
  tmuxSocket: "/tmp/fake-tmux.sock",
  paneId: "%7",
  panePid: 4242,
  paneCommand: "codex",
};

test("a paste failure is uncertain because bytes may have reached the pane", async () => {
  const calls = [];
  const delivery = new TmuxDelivery({
    runCommand: async (_socketPath, args) => {
      calls.push(args);
      if (args[0] === "display-message") {
        return { stdout: "%7\t4242\tcodex\n", stderr: "" };
      }
      if (args[0] === "paste-buffer") {
        throw new RelayError("tmux_timeout", "paste-buffer timed out after delivery");
      }
      return { stdout: "", stderr: "" };
    },
  });

  await assert.rejects(
    delivery.deliver(AGENT, MESSAGE),
    (error) => error.code === "tmux_timeout" && error.mayHaveReachedPane === true,
  );
  assert.deepEqual(calls.map((args) => args[0]), [
    "display-message",
    "load-buffer",
    "paste-buffer",
    "delete-buffer",
  ]);
});

test("a load failure is definitive because no paste was attempted", async () => {
  const delivery = new TmuxDelivery({
    runCommand: async (_socketPath, args) => {
      if (args[0] === "display-message") {
        return { stdout: "%7\t4242\tcodex\n", stderr: "" };
      }
      throw new RelayError("buffer_load_failed", "load failed");
    },
  });

  await assert.rejects(
    delivery.deliver(AGENT, MESSAGE),
    (error) => error.code === "buffer_load_failed" && error.mayHaveReachedPane === false,
  );
});
