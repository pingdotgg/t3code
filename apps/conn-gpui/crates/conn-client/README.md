# conn-client

WebSocket and HTTP RPC transport talking to `conn-server` (`apps/conn-server`).

- **Uses:** `conn-wire` (Effect RPC framing, `Ack`, `Ping`/`Pong`, `frame_parts`) and `conn-contract` (typed `rpc::*` schemas, `ORCHESTRATION_PROTOCOL_VERSION`).
- **Must not depend on:** `gpui` or `gpui-kit`.
- **References:** `apps/conn-server/crates/conn-wire/src/lib.rs`, `apps/conn-server/crates/conn-server/tools/effect-client.mjs`, `.refs/threadbear/desktop/client/src/runner.rs`.
