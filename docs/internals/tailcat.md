# Tailcat Transport

> For maintainers. Using T3 Code? See [docs/user/tailcat.md](../user/tailcat.md).

Tailcat is a transport underneath T3, never a trust boundary of its own. A T3 server exposes
its loopback HTTP/WebSocket listener through `tailcat serve`; a client runs `tailcat forward`
and gets `http://127.0.0.1:<port>`, which then goes through the ordinary descriptor fetch,
pairing, session, and RPC path. Everything T3 already knows about auth and scopes applies
unchanged. The only thing Tailcat adds is _who may open a tunnel at all_, and T3 drives that
allowlist from its own pairing state.

## Pieces

| Piece                              | Where                                                                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime supervisor                 | [`packages/tailcat/src/runtime.ts`](../../packages/tailcat/src/runtime.ts) (`TailcatRuntime`)                                           |
| Address / node-key helpers         | [`packages/tailcat/src/address.ts`](../../packages/tailcat/src/address.ts)                                                              |
| Pinned version, checksums, license | [`native/tailcat/manifest.json`](../../native/tailcat/manifest.json), `native/tailcat/README.md`                                        |
| Server remote access               | [`apps/server/src/tailcat/TailcatRemoteAccess.ts`](../../apps/server/src/tailcat/TailcatRemoteAccess.ts)                                |
| Server HTTP + RPC surface          | `apps/server/src/tailcat/http.ts`, `tailcat.*` methods in `apps/server/src/ws.ts`                                                       |
| Desktop forward manager            | [`apps/desktop/src/tailcat/DesktopTailcatEnvironment.ts`](../../apps/desktop/src/tailcat/DesktopTailcatEnvironment.ts)                  |
| Desktop client identity            | [`apps/desktop/src/tailcat/DesktopTailcatIdentity.ts`](../../apps/desktop/src/tailcat/DesktopTailcatIdentity.ts)                        |
| Connection code format             | [`packages/shared/src/t3ConnectionCode.ts`](../../packages/shared/src/t3ConnectionCode.ts)                                              |
| Client connection model            | `TailcatConnectionTarget` in [`packages/client-runtime/src/connection/model.ts`](../../packages/client-runtime/src/connection/model.ts) |
| Wire contracts                     | [`packages/contracts/src/tailcat.ts`](../../packages/contracts/src/tailcat.ts)                                                          |

## Runtime resolution

`TailcatRuntime` resolves one executable, in order: the `T3CODE_TAILCAT_BINARY` override, the
bundled candidates (`resources/tailcat/<platform-key>/`, `apps/server/dist/tailcat/…`,
`native/tailcat/dist/…` in a checkout), then a `tailcat` on `PATH`. Every candidate is
version-checked against the pinned manifest with `tailcat version`; a build outside the
compatible range fails with `version-incompatible` rather than running. The resolution is
cached per process and reported in `TailcatRuntimeInfo` (`source`, `version`, `pinnedVersion`,
`compatible`) so the UI and diagnostics can say exactly which binary is in use.

The runtime never downloads anything. Binaries are fetched at build time by
`scripts/fetch-tailcat.ts` from the pinned upstream release (or built from the pinned source
on macOS, which upstream does not publish), verified against `manifest.json` checksums, and
staged into the desktop `extraResources` and the CLI dist. Bumping the pin is
`node scripts/fetch-tailcat.ts --update <version>` followed by a review of the manifest diff.

## Server: remote access lifecycle

`TailcatRemoteAccess` owns one `tailcat serve` child at a time.

```text
disabled ──enable──▶ starting ──listenAddr──▶ ready ──allowlist change──▶ restarting ──▶ ready
    ▲                    │                       │
    └──────disable───────┴──── exit / error ─────┴──▶ error ──backoff──▶ starting
                                                          (permanent) ──▶ unavailable
```

- **Identity.** The server's Tailcat private key lives in the 0700 secrets directory as a 0600
  file, generated with `genkey --fixed-region` so the address stays stable across restarts.
  `regenerateIdentity` replaces it (new address, every saved connection elsewhere breaks by
  design).
- **Enable state** is persisted in `<stateDir>/tailcat-remote-access.json` together with the
  trusted peers. `t3 serve --tailcat` sets it; the Settings toggle sets it too. The listener
  starts once the HTTP server has bound, using the real loopback port, and never binds anything
  but `127.0.0.1` itself: Tailcat is the only thing that reaches that port from outside.
- **Allowlist** is derived, never edited by hand: while an unconsumed, unexpired connection code
  exists the listener runs with `--allow` open (pairing window); otherwise it runs with exactly
  the trusted peers' node keys (or `--allow=none` when there are none). Tailcat evaluates the
  allowlist only at startup, so every change restarts the child. Existing forwards do not
  survive that restart; clients reconnect through the connection supervisor, which re-creates
  the forward.
- **Trust** is recorded during the ordinary `/oauth/token` exchange: when the redeemed bootstrap
  credential was issued as a Tailcat connection code and the client sent its node key
  (`client_tailcat_node_key`), the key becomes a trusted peer linked to the session it created.
  Revoking the peer revokes those sessions and relocks the listener; a plain session revocation
  leaves transport trust in place until the peer is revoked.
- **Failures** are typed (`TailcatFailureCode`), kept as `lastError`, and retried with jittered
  exponential backoff (1s → 30s). A missing, non-executable, or incompatible binary is
  permanent (`unavailable`) and stops retrying until settings change.

## Client: connection target and desktop forwards

A saved Tailcat environment persists the logical endpoint (`address`, `remotePort`) as a
`TailcatConnectionTarget` plus a bearer credential. It never persists the ephemeral local port.
The resolver broker asks the platform's `TailcatEnvironmentGateway` to `prepare` the
connection; on desktop that is the main process:

1. reserve a loopback port,
2. materialise the encrypted client key to a 0600 temp file,
3. spawn `tailcat forward <address> <port>:<remotePort>` and wait for the listener,
4. probe `/.well-known/t3/environment` through it (readiness), then delete the temp key,
5. hand `http://127.0.0.1:<port>` to the renderer.

An `ensure` on a live, healthy forward returns immediately; a forward whose readiness probe
fails is replaced. A forward that exits by itself is restarted with backoff up to eight times,
after which the client supervisor's own retries take over. Diagnostics (`status`, pid, restart
count, path probe from `tailcat ping`, redacted recent output) are available per connection.

The client identity is generated once per desktop install and stored with Electron's
`safeStorage` (Keychain, DPAPI, libsecret/kwallet). Where no encryption backend exists it falls
back to a 0600 file and logs that it did. Web and mobile have no Tailcat gateway: connection
codes are recognised and redirected to the desktop app.

## Connection code

`t3c://tailcat/<base64url(json)>` with `{ v: 1, transport: "tailcat", address, port,
environmentId, name, serverVersion, pairingToken, expiresAt }`. The only secret is the pairing
token, which is a normal single-use, five-minute pairing link with subject
`tailcat-connection-code`. Codes are safe to show as QR and safe to paste into a chat you trust
for five minutes; they never contain a reusable credential or a private key. Parsing is in
`packages/shared/src/t3ConnectionCode.ts`, and `redactT3ConnectionCode` exists for logs.

## Threat model

Assets: the server's Tailcat private key (stable address, reachable by trusted peers), the
client's private key (transport access to every server that trusts it), pairing tokens,
session tokens, and the allowlist.

| Threat                                      | Mitigation                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Attacker learns the Tailcat address         | Locked mode: connections from unknown node keys never complete a handshake. Address alone grants nothing.                |
| Attacker obtains a connection code          | Single use, five-minute TTL, revocable from the pairing-links list; consuming it needs the code before the owner does.   |
| Attacker connects during the pairing window | The window is open only while a code is unconsumed; they still need a valid pairing credential to get a session.         |
| Stolen client private key                   | Transport access only; T3 sessions are separate. Revoke the trusted peer on each server; regenerate the client identity. |
| Stolen server private key                   | Attacker can impersonate the server address. `regenerateIdentity` rotates it; the identity file is 0600 in a 0700 dir.   |
| Compromised or malicious Tailcat binary     | Pinned version, checksums verified at build time, no runtime downloads, version check at startup, override is opt-in.    |
| Server accidentally exposed on 0.0.0.0      | Tailcat serves the loopback listener; enabling Tailcat never changes the bind host.                                      |
| Secrets in logs or diagnostics              | Runtime output is redacted (`redactTailcatOutputLine`), codes are redacted, private keys are never read into logs.       |
| Relay (DERP) observing traffic              | Tailcat's transport is end-to-end encrypted; the relay sees ciphertext. T3 auth runs inside it.                          |

Out of scope: a compromised machine on either end, and DoS against the DERP relays.

## Diagnostics and observability

Structured logs: `Tailcat listener ready/stopped`, `Tailcat allowlist changed`, `Trusted a
Tailcat peer`, `Tailcat forward ready/exited`, all with pids, ports, and fingerprints, never
keys. Spans: `TailcatRuntime.*`, `TailcatRemoteAccess.*`, `desktop.ipc.tailcatEnvironment.*`.
The UI's "Copy diagnostics" gathers `TailcatRemoteAccessState` (server) or
`TailcatConnectionDiagnostics` (client), both secret-free by construction. No usage metrics
are collected for Tailcat beyond the existing connection-method analytics dimension
(`connectionMethod: "tailcat"`).

## Known upstream limitations (Tailcat v0.5.0)

- `--allow` is read once at startup; changing trust restarts the listener and drops tunnels.
- An existing `forward` process stays alive but stops passing traffic after the remote
  `serve` restarts; readiness probes and restarts handle this.
- Denied clients time out silently; T3 surfaces that as "not trusted or offline".
- Upstream releases ship Linux and Windows only; macOS is built from the pinned source.
- Without `--fixed-region` the address changes with the chosen relay region; the server
  identity always uses a fixed region.
- `printpub` on a missing key file mints an ephemeral key instead of failing; the runtime
  checks the file exists first.
