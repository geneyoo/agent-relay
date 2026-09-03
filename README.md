# agent-relay

> Durable agent-to-agent messaging for coding agents running in tmux.

`agent-relay` lets existing Claude Code and Codex sessions send tasks to one
another without replacing tmux as their interface. Every task is saved before
delivery, explicitly accepted by its recipient, and finished with a durable
result.

## How it works

```text
   +-------------+          +------------------+          +-------------+
   |   Agent A   |          |   agent-relay    |          |   Agent B   |
   |   sender    |          |  durable postbox |          |   worker    |
   +------+------+          +--------+---------+          +------+------+
          |                          |                           |
          |  1. Send task            |                           |
          |------------------------->|                           |
          |                          |                           |
          |  2. Return saved ID      |                           |
          |<-------------------------|                           |
          |                          |                           |
          |                          |  3. Deliver task + ID     |
          |                          |-------------------------->|
          |                          |                           |
          |                          |  4. Acknowledge task      |
          |                          |<--------------------------|
          |                          |                           |
          |                          |        ...work happens... |
          |                          |                           |
          |                          |  5. Complete with result  |
          |                          |<--------------------------|
          |                          |                           |
          |  6. Return result        |                           |
          |<-------------------------|                           |
          |                          |                           |
```

Think of it as a reliable post office for terminal agents: save the task,
deliver it, confirm who accepted it, and carry the result back.

## At a glance

| Property | What it means |
| --- | --- |
| Durable first | Messages are persisted before terminal delivery is attempted. |
| Identity-bound | Acknowledgement and completion must come from the registered recipient. |
| Recovery-safe | An interrupted delivery becomes `uncertain` and is never blindly replayed. |
| Headless | tmux and the selected agent CLI remain the entire user interface. |
| Local by default | The daemon listens on an owner-only Unix socket, not TCP. |
| Dependency-free | Runtime support comes from Node.js, including SQLite. |

## Quick start

### Requirements

- Node.js 24 or later
- tmux
- Linux or macOS

### Install and run

```bash
npm install -g .
relay daemon run
```

For a persistent Ubuntu user service:

```bash
mkdir -p ~/.config/systemd/user
cp contrib/systemd/agent-relay.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now agent-relay
```

An administrator can optionally start the service before SSH login:

```bash
sudo loginctl enable-linger "$USER"
```

### Connect two agents

In two existing Claude Code or Codex sessions, run:

```bash
relay join coordinator
relay join reviewer
```

The relay detects each tmux pane and provider. Commands issued by that session
then carry its registered relay identity.

To register and launch a new session in one step:

```bash
relay start coordinator -- codex
relay start reviewer -- claude
```

`relay start` does not intercept the terminal. It registers the pane, sets
`AGENT_RELAY_AGENT` for child tool calls, and launches the requested CLI with
inherited input and output. Registration waits until tmux reports Claude or
Codex in the foreground, preventing recovered work from being delivered into
the shell during startup.

### Send a task

From the coordinator session:

```bash
relay ask reviewer "Review the authentication change"
```

`ask` returns the worker's result after the task has been explicitly accepted
and completed.

## Choose a workflow

| Command | Use it when |
| --- | --- |
| `relay ask` | The sender should wait for acknowledgement and the final result. |
| `relay send` | The task should be delivered now without making the sender wait. |
| `relay queue` | The task must wait behind another open task for that recipient. |

### Ask and wait

```bash
relay ask reviewer "Review the authentication change"
```

The durable message ID is created before terminal injection finishes. `ask`
waits up to 120 seconds for acknowledgement, then waits for completion. Change
those limits with `--accept-timeout` and `--timeout`.

A timeout stops only the caller's wait. It does not cancel the durable task.

### Send without waiting

```bash
message_id=$(relay send reviewer "Review the authentication change")
relay wait "$message_id"
relay result "$message_id"
```

`send` schedules immediate injection and prints the durable message ID. Its
initial snapshot may still say `queued`; use `relay show`, `relay wait`, or
`relay ask` to observe later states.

### Queue work

```bash
relay queue reviewer "Run this after the current relay task"
```

Queued work is scheduled again after daemon restart or recipient
re-registration. If obsolete work blocks a queue, its original sender can
withdraw it:

```bash
relay cancel msg_...                 # queued and not delivered
relay cancel msg_... --force         # injected/uncertain; may be visible
```

Cancellation is not remote process termination. Accepted work cannot be
cancelled through the relay; coordinate with the recipient and let it report a
truthful terminal result.

### Send multiline input

Use stdin for arbitrary or multiline content:

```bash
printf '%s' 'Review the authentication change.' |
  relay send reviewer --stdin
```

## Recipient protocol

Every delivered task includes the commands needed to accept and finish it:

```bash
relay ack msg_... --agent reviewer
relay done msg_... "Review complete; found one race condition" --agent reviewer

# Or report a failure:
relay fail msg_... "Blocked by a missing dependency" --agent reviewer
```

Successful tmux injection does not prove that an agent accepted the task. Only
the recipient's explicit, identity-bound `ack` does that.

The client assigns an idempotency key and retries one lost response with the
same key, so a response timeout does not create a duplicate.

## Discover and diagnose

```bash
relay whoami
relay peers
relay doctor
```

`relay peers` probes each registered pane and reports it as `online` or
`offline`. A remembered registration alone is not treated as proof that its
pane still exists.

## Use it over SSH

Use the machine's existing SSH trust path instead of exposing a new network
service:

```bash
printf '%s' 'Run the focused tests.' |
  ssh devbox relay send reviewer --stdin
```

## Teach agents the protocol

Run `relay instructions` and add its output to each agent's user-level
instructions. It teaches agents to:

- discover peers with `relay peers`;
- coordinate with `relay ask`;
- accept incoming work with `relay ack`; and
- finish with `relay done` or `relay fail`.

## Storage and security

| Resource | Location or behavior |
| --- | --- |
| Socket | `$XDG_RUNTIME_DIR/agent-relay.sock` |
| Database | `$XDG_STATE_HOME/agent-relay/relay.sqlite` or `~/.local/state/agent-relay/relay.sqlite` |
| Permissions | Socket and database are owner-only. |
| Network | No TCP listener or WebSocket in protocol v1. |

The daemon takes exclusive ownership of the Unix socket before opening or
recovering the database. Possibly delivered tmux pastes recover as `uncertain`
and are never replayed automatically.

Message bodies, results, sockets, and databases remain outside this Git
repository. The Unix account is the trust boundary for protocol v1.

## Scope

`agent-relay` is deliberately a message transport, not an agent harness. It
does **not** create worktrees, choose models, approve tools, manage Git,
maintain semantic memory, or provide another UI.

## Development

```bash
npm run check
npm test
```

The wire contract is documented in [docs/protocol.md](docs/protocol.md).
