# gcp-memorystore-redis

A fixed-window rate limiter on Cloud Run, counting in Memorystore for
Redis. Each key gets 5 hits per 60-second window; after that the API
answers `429` until the window resets.

| Route              | Returns                                                                     |
| ------------------ | --------------------------------------------------------------------------- |
| `POST /hit/:key`   | `200` (or `429` + `retry-after` once over the limit) with the counter below |
| `GET /count/:key`  | the counter, without counting a hit                                         |

```json
{
  "key": "user-42",
  "count": 6,
  "limit": 5,
  "remaining": 0,
  "limited": true,
  "resetInSeconds": 41
}
```

A hit is one Redis round trip: `SET key 0 EX 60 NX` starts the window
(the TTL is only set when the key is new), `INCR` counts the hit and keeps
the TTL, and `TTL` reports the time left. When the key expires the
window starts over.

## Architecture

- `GCP.Redis.Instance` `Counters` — BASIC tier (one node, no replica),
  1 GiB, Redis AUTH on, on the project's `default` network, in
  the stack's region.
- `GCP.Function` `Api` — public Cloud Run service
  (`invokerIamDisabled: true`) with Direct VPC egress onto the `default`
  network and subnet (`template.vpcAccess`, `PRIVATE_RANGES_ONLY`).

Memorystore only has a private IP. Direct VPC egress gives each revision
an interface on the network, so traffic to private ranges (the Redis IP)
goes through the VPC and everything else leaves the normal way. There is
no Serverless VPC Access connector to create or pay for.

## Bindings

| Binding                              | Role | Injects                                   |
| ------------------------------------ | ---- | ----------------------------------------- |
| `GCP.Redis.ReadWriteRedis(counters)` | none | `redis://:AUTH@host:port` for `Counters`  |

Memorystore has no data-plane IAM: RESP authenticates with the
instance's AUTH string, so the binding grants the runtime service
account no role. At deploy time Alchemy reads the instance's private IP,
port, and AUTH string (`instances.getAuthString`, with the deployer's
credentials) and carries the URL to the service through its runtime
context. The client is `alchemy/Redis`, so `get`, `set`, `incr`,
`expire`, `pipeline`, and `send` behave the same as on any other Redis
provider. `GCP.Redis.ReadRedis` / `WriteRedis` (with `*Http` layers) are
the narrower clients.

## Deploy

Credentials come from your alchemy profile: run `alchemy profile` once and pick GCP (*Service account JSON* for a key file, or *Stored* for an access token or key kept in `~/.alchemy/credentials`, plus a default region), then deploy with `--profile <name>`.

```sh
pnpm deploy --profile <name>
```

Creating the instance takes about four minutes; the service deploys
once it is ready.

```sh
curl -X POST "$URL/hit/user-42"
curl "$URL/count/user-42"
```

## Test

```sh
ALCHEMY_PROFILE=<name> bun test
```

Deploys the stack, checks the instance out of band (READY, BASIC, 1 GiB,
AUTH on, private IP), hits a key until it is rate limited — asserting the
count, the window TTL, and the `429` — then destroys the stack and checks
that the instance and the service are gone. Needs Docker (the
service image is built locally). Expect around 15 minutes, most of it
Memorystore create and delete.

## Destroy

```sh
pnpm destroy --profile <name>
```

Deletes the service, its image repository and service account, and the
Redis instance. Deleting the instance also takes several minutes;
`destroy` waits until it is gone.
