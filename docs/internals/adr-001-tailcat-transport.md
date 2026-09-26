# ADR 001: Tailcat as a transport

Status: accepted (2026-09). Owners: T3 Code maintainers.

## Context

Users want to reach a T3 server on another machine without a VPN, tailnet, port forwarding,
or T3 Connect. Tailcat (a small open-source point-to-point tunnel CLI) can do that.

## Decisions

1. **Tailcat is a transport, not an auth system.** It exposes the existing loopback listener;
   T3 pairing, sessions, scopes, and RPC are unchanged, and the listener admits any Tailcat
   node. Rationale: one trust model, no second place where access is granted or revoked.
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
6. **No transport allowlist.** Tailcat reads `--allow` only at startup, so gating by node key
   restarts the listener, dropping every tunnel, whenever a device pairs or a code lapses.
   Rationale: an earlier revision did this, and each pairing disconnected every other device
   for tens of seconds; the gate enforced nothing T3 auth does not already.

## Consequences

- Web and mobile cannot open Tailcat tunnels themselves; they recognise codes and point to the
  desktop app. T3 Connect remains the path for those surfaces.
- Anyone who learns a server's Tailcat address can reach its unauthenticated endpoints, as on a
  LAN; everything else needs a T3 session.
- Bumping the Tailcat pin is a reviewed manifest change with CI verification.
