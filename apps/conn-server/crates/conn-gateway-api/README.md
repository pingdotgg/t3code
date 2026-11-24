# conn-gateway-api

Typed Orbit Gateway operations for Conn, generated from the Gateway's OpenAPI document. Plan:
nckrtl/conn#227. An Orbit API change then fails Conn's build, not a request at run time.

| File | What it is |
| --- | --- |
| `openapi.json` | The pinned Gateway document, byte for byte as published. Never edit it. |
| `openapi.source` | Where the pin came from: URL, Orbit commit, sha256. |
| `operations.txt` | The operations Conn calls, by `operationId`. Only these are generated. |
| `src/types.rs` | Generated serde types (typify) for every schema those operations use. |
| `src/ops.rs` | Generated: one struct per operation, implementing `GatewayOperation`. |
| `src/bin/gen.rs` | The generator, behind the `gen` feature. |

No HTTP client. A caller builds an operation value and sends it through its own transport:

```rust
use conn_gateway_api::{GatewayOperation, ops::OperationShow};

let op = OperationShow { operation: 42, after_sequence: None };
let target = op.path_and_query(); // "/api/v1/operations/42"
// send OperationShow::METHOD to target with your client, then:
// OperationShow::decode_success(status, &body) or OperationShow::decode_error(status, &body)
```

## Generate

```sh
cargo run -p conn-gateway-api --features gen              # regenerate from the pin
cargo run -p conn-gateway-api --features gen -- --check   # CI: fail when src/ or the digest is stale
CONN_UNSEALED=1 cargo run -p conn-gateway-api --features gen -- --fetch https://gateway.orbit
```

`--fetch` reads `GET /api/v1/openapi.json` with the system `curl`, checks the body against
`X-Orbit-OpenAPI-SHA256`, then writes `openapi.json` and `openapi.source` and regenerates. Run it
on mini (WireGuard); CI cannot reach the Gateway.

To take a new Orbit release: `--fetch`, commit `openapi.json`, `openapi.source` and `src/`, and
fix the compile errors in the callers.

## What the generator changes in its copy

- `$ref`s point at `#/definitions/` for typify.
- Value checks (`pattern`, lengths, bounds, `format`) and `x-*` keys are dropped. The Gateway
  validates them; strings stay `String` and numbers `i64`.
- An untyped `{"type": "object"}` becomes `serde_json::Value`, marked `TODO(6200)` in the docs
  of the type and the operation.
- Auth comes from each route's `security`, else the document's: `managedTargetBearer` gives
  `AuthKind::ManagedBearer`, the document's default `wireguardPeer` gives `WireGuardPeer`. Any
  other scheme fails the generator, and so does a `/api/v1/conn/managed/` route without the
  managed bearer.
- `ADDED_FIELDS` in the generator makes fields a newer Gateway added optional, with a default,
  so answers from older live Gateways still decode (`ConnEnvironment.is_primary_agent` and
  `roles`, release 2214). Drop an entry once every Gateway serves the field.

## The current document

The Gateway document of release 2214 closed the gaps listed in #227: it types every schema the
listed operations use (no `TODO(6200)` remains), lists `required` fields, documents `security`,
and allows `[]` for an empty `Error.details`.
