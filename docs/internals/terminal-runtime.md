# Terminal runtime

The environment server owns terminal processes, retained output history, and
session lifecycle. Web and desktop clients attach to the same server-owned
session over the environment RPC connection. Desktop must not replace this
with a renderer-owned PTY: reconnect, remote access, and multi-client attach
all depend on the environment remaining authoritative.

## Output path

PTY output follows this path:

```text
PTY callback
  -> ordered process-event drain
  -> bounded retained-history append
  -> live terminal output event
  -> coalesced history persistence
```

Live output events contain only the new PTY data. A full retained-history
snapshot is materialized only when a client attaches or when the coalescing
persistence worker writes the latest state.

Retained history uses an incremental bounded line buffer. Appending one PTY
chunk may scan and allocate for that new chunk, but it must not split, join, or
copy the entire retained history for every callback. Empty lines, incomplete
final lines, trailing newlines, and the configured line limit are preserved
exactly when history is materialized.

This is a performance invariant, not an implementation detail to discard
during refactors. Measure sustained-output changes against a full retained
history so terminal throughput does not regress unnoticed.

## Persistence and transport changes

History persistence is keyed by terminal session and coalesces pending writes.
The worker reads the newest bounded-history state after its debounce instead
of receiving a newly materialized full string for every PTY callback. Clear,
restart, close, and final flush operations still force the latest state to
disk before their lifecycle boundary completes.

If measurements later justify a binary terminal data channel, keep snapshots,
lifecycle commands, and PTY ownership on the environment server. Do not share
the terminal data channel with port-forward payloads: a bulk TCP transfer must
not head-of-line block interactive terminal input or output.
