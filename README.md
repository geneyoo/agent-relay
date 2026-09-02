# agent-relay

`agent-relay` is a small, headless message relay for coding agents running in
tmux panes. It keeps tmux as the terminal and Claude Code or Codex as the agent.
It adds durable delivery state, pane naming, acknowledgements, completion
reports, and safe serialization around tmux input.

It is deliberately not an agent harness. It does not create worktrees, choose
models, approve tools, manage Git, maintain semantic memory, or provide a UI.

## Requirements

- Node.js 24 or later
- tmux
- Linux or macOS

There are no package dependencies. SQLite is provided by Node.

## Install

```bash
npm install -g .
```

Start the daemon directly while evaluating it:

```bash
relay daemon run
```

For a persistent Ubuntu service:

```bash
mkdir -p ~/.config/systemd/user
cp contrib/systemd/agent-relay.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now agent-relay
```

An administrator can enable user lingering so the service starts before an SSH
login:

```bash
sudo loginctl enable-linger "$USER"
```

## Join agents

Ask each existing Claude or Codex agent to run one command:

```bash
relay join coordinator
relay join reviewer
```

The relay detects the tmux pane and provider. Once joined, commands issued by
that agent automatically carry its relay identity.

For a new agent, join and launch it together:

```bash
relay start coordinator -- codex
relay start reviewer -- claude
```

`relay start` does not intercept the terminal. It registers the current pane,
sets `AGENT_RELAY_AGENT` for child tool calls, and launches the requested CLI
with inherited standard input and output. Registration waits until tmux reports
Claude or Codex in the foreground, preventing recovered work from
being delivered into the shell during startup.

Check discovery at any time:

```bash
relay whoami
relay peers
relay doctor
```

## Ask another agent

The normal coordinator operation is synchronous and returns only the worker's
result:

```bash
relay ask reviewer "Review the authentication change"
```

The relay persists and injects the task, waits up to 30 seconds for an explicit
acknowledgement, waits for completion, and prints the result. Use `--timeout`
to bound the work itself.

## Send asynchronously

`send` injects immediately and prints only the durable message ID:

```bash
message_id=$(relay send reviewer "Review the authentication change")
relay wait "$message_id"
relay result "$message_id"
```

Use `queue` when the task must wait behind another open relay task:

```bash
relay queue reviewer "Run this after the current relay task"
```

Use stdin for arbitrary or multiline content:

```bash
printf '%s' 'Review the authentication change.' |
  relay send reviewer --stdin
```

The recipient follows the commands embedded in the delivered envelope:

```bash
relay ack msg_...
relay done msg_... "Review complete; found one race condition"
# or
relay fail msg_... "Blocked by a missing dependency"
```

`send` attempts immediate terminal injection. A terminal adapter cannot prove
that an application semantically steered its active turn; only the explicit
`ack` establishes acceptance.

From another machine, use the existing SSH trust path rather than exposing a
new network service:

```bash
printf '%s' 'Run the focused tests.' |
  ssh devbox relay send reviewer --stdin
```

## Agent instruction

Run `relay instructions` and add the resulting behavioral rule to each agent's
user-level instructions. The rule teaches agents to discover peers with
`relay peers`, coordinate with `relay ask`, acknowledge incoming work with
`relay ack`, and finish with `relay done` or `relay fail`.

## Storage and security

- Socket: `$XDG_RUNTIME_DIR/agent-relay.sock`
- Database: `$XDG_STATE_HOME/agent-relay/relay.sqlite`, or
  `~/.local/state/agent-relay/relay.sqlite`
- Socket and database permissions: owner-only
- No TCP listener and no WebSocket in protocol v1

Message bodies and results are operational data and are never stored in this
Git repository. The Unix account is the trust boundary for protocol v1.

## Development

```bash
npm run check
npm test
```

The wire contract is documented in [docs/protocol.md](docs/protocol.md).
