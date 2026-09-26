# Provider status stream consumer

Build with `node ../../bin/t3-extension.mjs build .`, then check `.t3-extension`.
Install into a disposable runtime with the `t3.providers/read` grant and a
project grant. Subscribe to `example.providers-status/read` through the public
SDK API facade; this package relays the host's typed stream.

Each frame is a full snapshot of the environment's provider instances:
identity, lifecycle and capability flags. `displayName` is a display label
capped by the host projection — identity is `instanceId`/`driver`. Cancel the
stream when it is no longer needed.
