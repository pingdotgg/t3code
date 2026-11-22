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
on mini (WireGuard); CI cannot reach the Gateway. Orbit group 6200 adds that route; until it is
released, `--fetch` fails and the pin comes from Orbit's `docs-site` branch
(`docs/openapi.json`, built by `bin/docs-openapi`).

To take a new Orbit release: `--fetch`, commit `openapi.json`, `openapi.source` and `src/`, and
fix the compile errors in the callers.

## What the generator changes in its copy

- `$ref`s point at `#/definitions/` for typify.
- Value checks (`pattern`, lengths, bounds, `format`) and `x-*` keys are dropped. The Gateway
  validates them; strings stay `String` and numbers `i64`.
- An untyped `{"type": "object"}` becomes `serde_json::Value`, marked `TODO(6200)` in the docs
  of the type and the operation.
- The document names no auth (`securitySchemes`). Routes under `/api/v1/conn/managed/` get
  `AuthKind::ManagedBearer`, the rest `WireGuardPeer` (`TODO(6200)`). The generator fails once
  the document sets `security`, so the mapping is written then.

## Known gaps of the current document (Orbit group 6200)

The gaps listed in #227 hold here as generated: untyped `data` on many operations, few
`required` lists (most fields are `Option`), free strings for status fields, managed bodies
that copy the broadcasting-auth body, and `Error.details` typed as an object although the
Gateway can send `[]` (such an error answer does not decode yet).
