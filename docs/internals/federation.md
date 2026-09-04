# Federation (server-to-server) protocol v1

> For maintainers. Using T3 Code? See [docs/user/tailcat.md](../user/tailcat.md).

Federation lets one T3 environment start and observe runs on another, over Tailcat, with
explicit pairing and per-peer scopes. It is a small, versioned HTTP protocol between two
servers, not a general RPC bridge: a peer can only do what an endpoint exists for, and only
what the owner granted.

Code: `apps/server/src/federation/` (`FederationService`, `FederationIdentity`,
`FederationPeerStore`, `FederationTransport`, `runProjection`, `http.ts`), contracts in
[`packages/contracts/src/federation.ts`](../../packages/contracts/src/federation.ts).

## Identity

Each environment already has an Ed25519 key pair in its secret store (used for T3 Connect).
Federation reuses it: `environmentId` plus the public key form the identity, shown to users as
a fingerprint (`aaaa·bbbb·cccc·dddd`). The public key is pinned at pairing time; a peer that
later presents a different key is rejected.

## Pairing

1. Owner B creates a **peer code** (`federation.createPeerCode`, WS RPC, needs `access:write`).
   It is a pairing link with subject `federation-peer-code`, and the code
   `t3c://peer/<base64url(json)>` carries B's `environmentId`, public key, label, Tailcat
   address and port, the token, the scopes B offers, and the expiry (5 minutes, single use).
   Creating the code opens B's Tailcat pairing window like a connection code does.
2. Owner A pastes it (`federation.addPeer` with the scopes A grants B). A opens a Tailcat
   forward to B and calls `POST /api/federation/pair` with the token, its own identity, label,
   version, capabilities, Tailcat endpoint, granted scopes, and its Tailcat node key.
3. B consumes the token, checks the protocol version, records A as a peer (with the scopes B
   offered on that code), trusts A's node key on its Tailcat listener, and answers with its
   identity, capabilities, the granted scopes, its endpoint, and its own node key. A verifies
   the identity matches the code, stores B, and trusts B's node key too so B can call back.

Both sides end up with `grantedScopes` (what I let the peer do here) and `allowedScopes`
(what the peer lets me do there). Removing a peer deletes it, revokes its federation sessions,
and drops the transport; the other side learns on its next call.

## Authentication of calls

Peer calls use ordinary T3 sessions with a marker scope, so authorization is independent of the
transport:

1. `POST /api/federation/challenge { environmentId }` → nonce (2-minute TTL).
2. The caller signs `{ iss: <its id>, aud: <peer id>, jti: <nonce> }` as an EdDSA JWT
   (`typ: t3-federation-auth+jwt`, 2-minute max age).
3. `POST /api/federation/token { environmentId, assertion }` → the peer verifies the signature
   against the pinned key, consumes the nonce, and issues a one-hour session with subject
   `federation:<peerId>` and scope `federation:peer`.

Every other endpoint runs behind the normal session middleware and then `authorizePeer`,
which requires the `federation:` subject, the marker scope, an existing peer record, and the
specific `FederationScope` the endpoint needs. Federation sessions are refused at the `/ws`
upgrade, so a peer can never reach the client RPC surface. Clients hold sessions per peer and
refresh them once on a 401.

## Scopes

`environment.read`, `projects.read`, `runs.start`, `runs.read`, `runs.cancel`,
`artifacts.read`. Defaults are the read scopes plus `runs.start`/`runs.cancel`; owners pick per
code and per `addPeer`.

## Endpoints

| Method / path                                  | Scope              | Purpose                                |
| ---------------------------------------------- | ------------------ | -------------------------------------- |
| `POST /api/federation/pair`                    | token              | Redeem a peer code                     |
| `POST /api/federation/challenge`, `…/token`    | none (identity)    | Session bootstrap                      |
| `GET /api/federation/hello`                    | `environment.read` | Version, label, capabilities           |
| `GET /api/federation/projects`                 | `projects.read`    | Projects available to run on           |
| `POST /api/federation/runs`                    | `runs.start`       | Start a run (creates a thread + turn)  |
| `GET /api/federation/runs/:threadId`           | `runs.read`        | Run status                             |
| `GET /api/federation/runs/:threadId/events`    | `runs.read`        | Summarised events after a sequence     |
| `POST /api/federation/runs/:threadId/cancel`   | `runs.cancel`      | Interrupt the turn                     |
| `GET /api/federation/runs/:threadId/artifacts` | `artifacts.read`   | Artifact refs (turn diffs) with origin |
| `GET …/artifacts/:turnId/diff`                 | `artifacts.read`   | One turn diff                          |

A peer can only see runs it started (`inboundRuns` in `federation.json`), never the rest of the
environment's threads. Runs execute with the target project's default model and `runtimeMode:
"auto"` unless the request says otherwise, and they are ordinary threads on the executing
environment: visible in its own UI, checkpointed, resumable there.

## Capability negotiation

`FederationHello` and the pair response carry `protocolVersion` and a `capabilities` list.
Version mismatch fails pairing with `protocol-incompatible` and a message naming both versions.
Callers check `remoteCapabilities` before offering an action; unknown capabilities are ignored.

## Owner-side state and UX

The CLI in `apps/server/src/cli/peer.ts` (`t3 peer code|add|list|remove|projects|run`) drives
the same owner operations over a WS RPC session minted against the running server, mirroring
how `t3 pair` discovers it. `t3 remote tailcat …` (`apps/server/src/cli/remote.ts`) covers the
Tailcat remote-access side over the HTTP `tailcat` group.

`federation.json` in the state directory holds peers, inbound runs, and tracked remote runs
(with a bounded event tail). The owner's clients subscribe to `federation.subscribePeers` and
`federation.subscribeRemoteRuns`; a poller syncs active remote runs every two seconds and goes
idle when none are active. Every remote run and artifact carries the executing
`environmentId` so the UI always states the execution location.
