import { spawn } from "node:child_process";

import { RelayError, assertRelay } from "./errors.js";

const COMMAND_TIMEOUT_MS = 5000;

class DeliveryError extends RelayError {
  constructor(code, message, mayHaveReachedPane = false) {
    super(code, message);
    this.mayHaveReachedPane = mayHaveReachedPane;
  }
}

function tmuxArgs(socketPath, args) {
  return ["-S", socketPath, ...args];
}

function runTmux(socketPath, args, { input = undefined, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("tmux", tmuxArgs(socketPath, args), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new RelayError("tmux_timeout", `tmux command timed out: ${args[0]}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        finish(new RelayError("tmux_missing", "tmux is not installed or not on PATH"));
        return;
      }
      finish(error);
    });
    child.on("close", (code, signal) => {
      if (code === 0) {
        finish(null, { stdout, stderr });
        return;
      }
      const reason = stderr.trim() || `exit ${code ?? "unknown"}${signal ? ` (${signal})` : ""}`;
      finish(new RelayError("tmux_failed", `tmux ${args[0]} failed: ${reason}`));
    });

    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}

function envelopeFor(message) {
  return [
    `[relay id=${message.id} from=${message.sender} mode=${message.mode}]`,
    `First run: relay accept ${message.id} --agent ${message.recipient}`,
    "",
    message.body,
    "",
    `When finished: relay complete ${message.id} --agent ${message.recipient} --stdin`,
    "[/relay]",
  ].join("\n");
}

export class TmuxDelivery {
  async inspect({ tmuxSocket, paneId }) {
    assertRelay(typeof tmuxSocket === "string" && tmuxSocket.startsWith("/"), "invalid_tmux_socket", "tmux socket must be absolute");
    assertRelay(/^%\d+$/.test(paneId), "invalid_pane", "invalid tmux pane ID");
    const { stdout } = await runTmux(tmuxSocket, [
      "display-message",
      "-p",
      "-t",
      paneId,
      "#{pane_id}\t#{pane_pid}\t#{pane_current_command}",
    ]);
    const [actualPaneId, pidText, paneCommand] = stdout.trim().split("\t");
    const panePid = Number(pidText);
    assertRelay(actualPaneId === paneId && Number.isSafeInteger(panePid) && panePid > 0 && paneCommand, "invalid_pane_fingerprint", `could not fingerprint tmux pane ${paneId}`);
    return { paneId: actualPaneId, panePid, paneCommand };
  }

  async deliver(agent, message) {
    let fingerprint;
    try {
      fingerprint = await this.inspect(agent);
    } catch (error) {
      throw new DeliveryError(error.code ?? "pane_unavailable", error.message, false);
    }
    if (fingerprint.panePid !== agent.panePid) {
      throw new DeliveryError("stale_registration", `pane ${agent.paneId} no longer matches the registered process`, false);
    }
    if (agent.adapter !== "tmux" && fingerprint.paneCommand !== agent.paneCommand) {
      throw new DeliveryError("stale_registration", `pane ${agent.paneId} now runs ${fingerprint.paneCommand}, not ${agent.paneCommand}`, false);
    }

    const bufferName = `relay_${message.id.slice(4)}`;
    const envelope = envelopeFor(message);
    try {
      await runTmux(agent.tmuxSocket, ["load-buffer", "-b", bufferName, "-"], { input: envelope });
    } catch (error) {
      throw new DeliveryError(error.code ?? "buffer_load_failed", error.message, false);
    }

    try {
      await runTmux(agent.tmuxSocket, ["paste-buffer", "-p", "-d", "-b", bufferName, "-t", agent.paneId]);
    } catch (error) {
      try {
        await runTmux(agent.tmuxSocket, ["delete-buffer", "-b", bufferName]);
      } catch {
        // Best-effort cleanup after a definitive paste failure.
      }
      throw new DeliveryError(error.code ?? "paste_failed", error.message, false);
    }

    try {
      await runTmux(agent.tmuxSocket, ["send-keys", "-t", agent.paneId, "Enter"]);
    } catch (error) {
      throw new DeliveryError(error.code ?? "submit_failed", error.message, true);
    }
    return { bytes: Buffer.byteLength(envelope, "utf8") };
  }
}

export { DeliveryError, envelopeFor };
