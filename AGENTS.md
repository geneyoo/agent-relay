# Agent Instructions

`agent-relay` is a headless, repository-agnostic message transport for coding
agents already running in tmux panes.

## Invariants

- Keep tmux and the selected agent CLI as the user interface. Do not add a web,
  desktop, or terminal UI.
- Persist every message before attempting delivery.
- Never equate successful terminal injection with recipient acceptance.
- Recover an interrupted injection as `uncertain`; never automatically replay
  a possibly delivered payload.
- Treat message IDs and idempotency keys as the duplicate-delivery boundary.
- Use argument arrays and stdin for tmux interaction. Never interpolate message
  bodies, pane IDs, or socket paths into shell source.
- Bind locally through an owner-only Unix socket. Do not add a TCP listener by
  default.
- Do not manage Git branches, worktrees, models, approvals, prompts, memory, or
  agent permissions.
- Runtime messages, results, sockets, and databases must remain outside the
  source tree.

## Development

Run both checks before handing off a change:

```bash
npm run check
npm test
```

Add a denial-path test for every new delivery, identity, filesystem, or process
boundary. Preserve compatibility with Node.js 24 and later on Linux and macOS.
