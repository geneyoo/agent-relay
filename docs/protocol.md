# Relay protocol v1

The CLI and daemon exchange one newline-delimited JSON request and response per
Unix-socket connection. The default socket is
`$XDG_RUNTIME_DIR/agent-relay.sock`. Requests and responses are limited to 2
MiB; individual message bodies and results are limited to 64 KiB.

Successful response:

```json
{"ok":true,"result":{}}
```

Failure response:

```json
{"ok":false,"error":{"code":"stable_code","message":"description"}}
```

The durable message states are:

```text
queued -> injecting -> injected -> accepted -> completed
                    |                         -> failed
                    -> uncertain
queued ---------------------------------------------> cancelled
uncertain/injected -- explicit forced sender cancel -> cancelled
```

`injected` means tmux accepted the paste and submit commands. It does not mean
the target application interpreted the input. Only the recipient's explicit
`accept` request establishes acceptance.

If the daemon stops while a message is `injecting`, it recovers that message as
`uncertain`. It never automatically repeats an uncertain payload. A forced
retry is an explicit at-least-once operation and recipients must deduplicate by
message ID.

A new `send` persists first and returns its original `queued` snapshot without
waiting for tmux. An exact idempotent replay returns that message's current
snapshot. Delivery advances in the background. The client supplies an
idempotency key when the caller omits one and may repeat a timed-out request
once with the exact same key. Reusing a key with any different recipient,
parent, mode, or body is rejected as `idempotency_conflict`.

Only a message's declared recipient may `accept`, `complete`, or `fail` it, and
the protocol request must name that agent explicitly. Only its original sender
may `cancel` it. Queued cancellation is definitive; cancelling `injected` or
`uncertain` work requires an explicit force flag because the text may already
be visible. Accepted work cannot be cancelled by this transport.

The SQLite database uses `PRAGMA user_version` for ordered schema migrations.
The current schema version is `1`; a daemon refuses to open a database created
by a newer incompatible version.

## Operations

- `ping`
- `register`
- `identify`
- `send`
- `accept`
- `complete`
- `fail`
- `cancel`
- `show`
- `inbox`
- `agents`
- `status`
- `retry`

`agents` includes an ephemeral `online` Boolean produced by probing the stored
tmux pane identity. Registration remains durable metadata; `online` is only a
current reachability observation.

The protocol is local coordination, not an authentication boundary. The Unix
socket is mode `0600`; processes running as the same Unix user can invoke it.
