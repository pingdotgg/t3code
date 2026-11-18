# Managed access (Orbit Node grants)

The target side of Orbit's "Managed grant revocation" contract (`docs/reference/conn.md` in
Orbit, Conn integration item 4). Code: `crates/conn-server/src/managed/`.

## What runs

`serve --managed-provision <file>` starts a second listener, the **managed ingress**. The file
and the service credential it names must be mode 0600 and owned by the server's user
(`managed/provision.rs` has the format). Its environment ID must equal this state directory's
environment ID, or the server exits. With managed provisioning the server prints no startup
pairing code; its native listener is the restricted fixture path.

| Part | File | Does |
| --- | --- | --- |
| Authority | `authority.rs` | Applied revision, lease, provisional and confirmed fenced sets, admitted edges, open handlers, owed ACKs. No I/O; every rule has a test. |
| Gateway | `gateway.rs` | `POST /api/v1/conn/managed/{authority,introspect,ack,realtime,broadcasting/auth}` over HTTPS that trusts the lab CA only. 2 s per call. |
| Notices | `notices.rs` | Reverb (Pusher protocol 7) on `private-conn-target.{id}.{generation}`, signed by the Gateway. A notice only restricts. |
| Ingress | `ingress.rs` | Managed tickets, `/ws`, shell and thread snapshots, a read-only preview of a provisioned tab. Everything else: 403. |
| Gate | `mod.rs`, `session.rs`, `routes/preview.rs` | One handler per socket, stream or request, registered before the upgrade. Checked before every dispatch and every frame; its close ends the socket. |

The probe runs every second, one at a time; a notice or a known later revision probes at
once. The lease ends 3 s after the send time of the last applied probe. A failed probe, a
wrong generation, a missing revision, an expired lease or a closed notice link fails closed
for all managed access. Recovery is a snapshot behind a barrier, with a live lease.

The `reader` profile: exactly `orchestration:read` and `terminal:read`, and the methods
`orchestration.subscribeShell`, `orchestration.subscribeThread`, `terminal.observe` and
`subscribeTerminalMetadata`. A managed token never falls through to native auth, and a
native credential is refused on the managed ingress.

## Lab measurements (loopback, fake Gateway, `cargo test managed -- --nocapture`)

| Case | Measured |
| --- | --- |
| Removal with notice: commit to client close | 0–1 ms |
| Removal with notice: commit to ACK (`observed`) | 1–2 ms |
| Notice dropped: commit to client close | about 990 ms (next probe) |
| Explicit authority failure: fault to fence | about 990 ms (next probe) |
| Silent partition: last confirmed probe to fence | about 3,000 ms (lease), never earlier than 2 s |

## Readings where the contract is open

Each is the fail-closed reading.

- A closed Reverb link is a "closed control connection": managed access fails closed and
  reopens only with the link up and a fresh snapshot.
- An introspection the Gateway cannot answer (transport, timeout, bad reply) is a failed
  check: fail closed, unless a snapshot barrier already dropped that introspection.
- Every managed path needs a managed principal, including discovery and health.
- The "known test tab" is the provisioning's `previewTabs` list; empty refuses every preview.
- `peer_address` is the TCP peer's IP, IPv4-mapped addresses unwrapped.
- Realtime `url` must be `wss://` or `https://`; the socket path is `{url}/app/{key}`.
- Owed revisions in the first snapshot of a process are acknowledged `recovered`. Later,
  a revision whose fence this process observed is `observed`, also after a fail-closed
  recovery.
- "Blocks every managed admission, dispatch and output" is a pause: handlers stay
  registered and send nothing until a probe applies the head, or the lease ends and they
  close. A revision named by an introspection that the target has not applied pauses the
  same way. Only a verified probe ends a pause; a later notice never does.
- An introspection refused for the caller (`conn.managed_token_invalid`,
  `conn.managed_peer_mismatch`, `conn.managed_direct_edge_required`) refuses that caller.
  Any other refusal means the target lost its authority: everything fails closed.
- A managed ticket redeems only for its own edge, before its deadline (checked where the
  handler registers), and only if the edge was not fenced since it was minted. The session
  then carries the token's principal and expiry.
- The fence also holds at the byte level: every managed socket is a `FencedIo`
  (`managed/conn.rs`) that carries the handlers of its connection. A fenced handler makes
  the socket refuse every write and read, so nothing Hyper or the WebSocket still buffers
  reaches the peer; a paused one holds writes. Each managed HTTP response ends its
  connection (`Connection: close`), and a handler stays registered until its connection is
  gone, so `handlers_closed_at` means no handler and no sendable byte remain. RPC call
  tasks hold the session's registration too, and closes are bounded.
- A token's expiry is enforced as a target monotonic deadline, without the target's wall
  clock: the last applied probe's monotonic send time plus (expiry − its `server_time`).
  Each verified probe recomputes every open handler's deadline from its Gateway expiry, so
  a Gateway clock that moves ahead ends tokens sooner, idle or not. Ticket lifetimes are
  monotonic too. The reported offset interval is widened by a millisecond each side for
  truncation. Close times are the fence's wall time plus elapsed
  monotonic time, so a wall clock step never puts a close before its fence.
- `/broadcasting/auth` answers the bare Pusher object `{"auth": …}`; every other target
  route answers `{"data": …}`. A target refusal on any route (`/ack` included) fails
  closed at once. An authority reply without a
  readable `server_time` or without its `owed` list is incomplete: it fails closed.
- An introspected revision pauses everything until a probe applies it; notices never end
  that pause. It stays known even when a notice names it: no probe may disprove
  that notice, and a later head below it fails closed. A snapshot below the applied
  revision never reopens. Closed, the target retries on the probe timer, never faster.
- A pause also holds HTTP reads and preview attachments; only a fence refuses them. A
  preview attachment asks the gate again once it holds the tab's lock.
- Admission is stricter than "revision not greater than applied": the Gateway must have
  read the token at exactly the applied revision (an older read is introspected again).
  So a reply read before a removal the target applied can never admit the removed edge,
  and a confirmed fence is needed only until the edge's handlers drain and its revision
  settles; it is forgotten then. This departs from the contract's "confirmed fences never
  end" to keep memory bounded, with the same safety. Pending notices are bounded (1,024,
  and 1,024 edges each); a flood fails closed. Protected files must have exactly mode
  0600 (no special bits).
- Unspent managed tickets live with the authority (at most 256): a fence of an edge
  deletes its tickets in the same step as it closes its handlers, for good, and a
  fail-closed deletes them all. A redemption keeps its ticket reserved in the pool until
  the handler registers, so a fence during its introspection still cancels it. A Gateway answer may be up to 8 MiB: the contract does not
  page a snapshot's owed rows yet, so a very long offline backlog beyond that keeps the
  target closed (open point for the contract owner).
- Settled revision records are pruned after their ACK, or when a fresh verified reply no
  longer owes them (a lost ACK answer). Each applied probe narrows the Gateway-to-target clock offset bounds from
  `server_time` and the probe's send and receive times.

## Not proven here

The real Gateway, Reverb and lab CA (no lab Gateway yet: Orbit group 5870), the media fence
in a lab test (the preview needs a browser; the session gate tests cover its gate), terminal
streams in the lab (the lab has no terminal manager), and the NAT-mode proxy's caller
address. Legacy peer-link, held and device-paired credentials stay as they are on the native
ingress.
