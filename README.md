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

## Register agents

From inside each tmux pane, either register an existing CLI:

```bash
relay register coordinator --adapter codex
relay register reviewer --adapter claude
```

Or register and launch it together:

```bash
relay start coordinator --adapter codex -- codex
relay start reviewer --adapter claude -- claude
```

`relay start` does not intercept the terminal. It registers the current pane,
sets `AGENT_RELAY_AGENT` for child tool calls, and launches the requested CLI
with inherited standard input and output. Registration waits until tmux reports
the expected agent command in the foreground, preventing recovered work from
being delivered into the shell during startup.

## Send and track work

Use stdin for arbitrary or multiline messages:

```bash
printf '%s' 'Review the authentication change.' |
  relay send reviewer --from coordinator --mode now --stdin
```

The result includes a message ID. The target acknowledges it:

```bash
relay accept msg_... --agent reviewer
```

Then records completion:

```bash
printf '%s' 'Review complete; found one race condition.' |
  relay complete msg_... --agent reviewer --stdin
```

The sender can wait without scraping terminal output:

```bash
relay wait msg_... --for accepted --timeout 30
relay wait msg_... --for completed
relay show msg_...
```

`--mode next` waits behind another open relay message. `--mode now` attempts
immediate terminal injection. A terminal adapter cannot prove that an
application semantically steered its active turn; only explicit acceptance
does that.

From another machine, use the existing SSH trust path rather than exposing a
new network service:

```bash
printf '%s' 'Run the focused tests.' |
  ssh devbox relay send reviewer --mode now --stdin
```

## Agent instruction

Run `relay instructions` and add the resulting behavioral rule to each agent's
user-level instructions. The rule requires an agent to execute `relay accept`
before work and `relay complete` or `relay fail` afterward.

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
