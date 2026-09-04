# Terminal runtime

The environment server owns terminal processes, retained output history, and
session lifecycle. Web, desktop, and mobile clients attach to the same
server-owned session over the environment RPC connection. The desktop renderer
does not own a separate PTY. Clients can reconnect to a running PTY or share
it with another client.

## Output path

PTY output follows this path:

```text
PTY callback
  -> ordered process-event drain
  -> bounded retained-history append
  -> live terminal output event
  -> coalesced history persistence
```

Live output events contain only the new PTY data. Full retained history is
materialized only when the server returns a snapshot or when the coalescing
persistence worker writes the latest state.

Retained history uses an incremental bounded line buffer. Appending one PTY
chunk may scan and allocate for that new chunk, but it must not split, join, or
copy the entire retained history for every callback. Empty lines, incomplete
final lines, trailing newlines, and the configured line limit are preserved
exactly when history is materialized.

Discard each line's string reference as soon as the line leaves retained
history. Array compaction can run later.

The server's line limit does not limit the byte size of retained history.
Shared web and mobile client state currently retains at most 512 KiB. A server
byte limit would change persisted scrollback and needs a separate retention
decision.

Measure sustained-output changes against a full retained history so terminal
throughput does not regress unnoticed.

## Persistence

History persistence is keyed by terminal session and coalesces pending writes.
The worker reads the newest bounded-history state after its debounce instead
of receiving a newly materialized full string for every PTY callback. Clear,
restart, close, and final flush operations still force the latest state to
disk before their lifecycle boundary completes.
