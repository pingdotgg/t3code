# ADR 001: Tailcat as a transport, and federation on top of it

Status: accepted (2026-09). Owners: T3 Code maintainers.

## Context

Users want to reach a T3 server on another machine without a VPN, tailnet, port forwarding,
or T3 Connect. Tailcat (a small open-source point-to-point tunnel CLI) can do that with a
per-device allowlist. Some users also want a run started on one machine to execute on another.

## Decisions

1. **Tailcat is a transport, not an auth system.** It exposes the existing loopback listener;
   T3 pairing, sessions, scopes, and RPC are unchanged. Tailcat's allowlist is derived from T3
   pairing state, never edited independently. Rationale: one trust model, no second place
   where access can be granted.
2. **The connection model gets a fifth target.** `TailcatConnectionTarget` persists the logical
   endpoint (address + remote port); local ports are always ephemeral. Rationale: the same
   supervisor, retries, and UI as SSH, and no stale ports in saved state.
3. **Connection codes are T3-owned.** `t3c://tailcat/…` embeds a single-use pairing token,
   never a private key. Rationale: sharable by QR/paste with bounded blast radius.
4. **Bundled, pinned runtime.** Version and checksums live in `native/tailcat/manifest.json`;
   binaries are fetched at build time, macOS is built from the pinned source, and the runtime
   never downloads. An override env var and a version-checked `PATH` fallback exist for
   unsupported platforms. Rationale: supply-chain hygiene and identical behaviour across
   installs.
5. **Server identity uses a fixed relay region** so the address is stable; **client identity
   is encrypted with the OS keychain** and only materialised to a 0600 temp file while a
   `tailcat` process starts. Rationale: strongest storage available without changing Tailcat.
6. **Trust changes restart the listener.** Tailcat reads its allowlist at startup, so relocks
   restart the child and drop tunnels; clients reconnect via the supervisor. Rationale: correct
   over convenient; the interruption is a few hundred milliseconds and only on trust changes.
7. **Federation is an explicit versioned protocol**, authenticated with the existing Ed25519
   environment identity, authorised by ordinary T3 sessions with a `federation:peer` marker
   scope and per-peer `FederationScope`s, and confined to the federation HTTP group. Rationale:
   no arbitrary remote RPC, no new key material, scopes independent of transport.
8. **Federation runs are ordinary threads on the executing environment.** Peers see only runs
   they started; artifacts are turn diffs with origin identity. Rationale: reuse orchestration
   and checkpoints instead of inventing a remote-execution model.

## Consequences

- Web and mobile cannot open Tailcat tunnels themselves; they recognise codes and point to the
  desktop app. T3 Connect remains the path for those surfaces.
- A relock briefly drops every Tailcat client; UX copy explains reconnection.
- Bumping the Tailcat pin is a reviewed manifest change with CI verification.
- Federation is desktop/web owner-driven over WS RPC; a CLI (`t3 peer`) covers headless use.
