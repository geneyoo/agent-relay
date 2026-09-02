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
```

`injected` means tmux accepted the paste and submit commands. It does not mean
the target application interpreted the input. Only the recipient's explicit
`accept` request establishes acceptance.

If the daemon stops while a message is `injecting`, it recovers that message as
`uncertain`. It never automatically repeats an uncertain payload. A forced
retry is an explicit at-least-once operation and recipients must deduplicate by
message ID.

## Operations

- `ping`
- `register`
- `send`
- `accept`
- `complete`
- `fail`
- `show`
- `inbox`
- `agents`
- `status`
- `retry`

The protocol is local coordination, not an authentication boundary. The Unix
socket is mode `0600`; processes running as the same Unix user can invoke it.
