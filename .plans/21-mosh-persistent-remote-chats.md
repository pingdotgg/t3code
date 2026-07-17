# Mosh-managed persistent remote chats

## Product outcome

Let a desktop user add a machine on their tailnet, start or reuse T3 Code there through a
mosh-managed control session, and keep using its chats across laptop sleep, network changes, and
temporary connection loss. The remote T3 server remains the execution and persistence boundary;
the client reconnects to its ordinary HTTP/WebSocket API over Tailscale.

## Transport constraint

Mosh is a roaming terminal protocol, not a TCP tunnel. It cannot forward the T3 HTTP/WebSocket
port. Using mosh as a drop-in replacement for `ssh -L` would therefore be incorrect.

The access and launch paths must remain separate:

```text
desktop -- mosh/SSH bootstrap --> remote launcher + persistent T3 server
desktop -- Tailscale HTTPS/WSS or tailnet IP --> remote T3 server
```

Mosh supplies a connection-drop-proof control plane. Tailscale supplies the stable data plane.
Chat durability comes from the remote server's existing persisted thread/event state, not from a
second local chat database.

## Existing seams to extend

- `packages/ssh` already owns host discovery, authentication, remote launcher scripts, and the
  managed server state directory under `~/.t3/ssh-launch`.
- `packages/tailscale` already reads local Tailscale status and normalizes MagicDNS/Tailnet
  endpoints, but currently describes only the local machine.
- `apps/desktop` owns process spawning, remote bootstrap, saved-environment metadata, and IPC.
- `packages/client-runtime` owns the single retry loop, cached thread projections, and durable
  subscription replacement. Mosh must not introduce another reconnect owner.
- The web renderer already presents `connecting`, `reconnecting`, `offline`, and cached thread
  state. It needs richer launch/access status, not a parallel connection stack.

## Domain changes

Introduce a desktop-managed remote profile whose launch and access metadata are explicit:

```ts
type DesktopManagedRemoteTarget = {
  ssh: DesktopSshEnvironmentTarget
  launch: "ssh" | "mosh"
  access: {
    kind: "tailscale"
    endpointPreference: "https" | "tailnet-ip"
    magicDnsName?: string
    tailnetIpv4?: string
  }
}
```

Persist stable Tailscale identity (MagicDNS name, with Tailnet IP fallback), not a temporary local
forward port. Preserve the current SSH profile as a migration-compatible access method.

## Implementation phases

### 1. Remote endpoint discovery

- Add a remote probe script, executed through the existing authenticated SSH bootstrap, that reads
  `tailscale status --json` on the target.
- Normalize the remote MagicDNS name and Tailnet IPv4 using shared `packages/tailscale` parsing.
- Determine whether Tailscale Serve already routes to the selected remote T3 port.
- If the user opts in, configure `tailscale serve` remotely with the same semantics as
  `t3 serve --tailscale-serve`; never silently replace unrelated Serve configuration.
- Return both launch metadata and candidate direct endpoints from desktop IPC.

### 2. Mosh control-session manager

- Add a `packages/mosh` package with command resolution, capability probing, typed failures, and a
  scoped process manager.
- Bootstrap over SSH because mosh itself requires an initial SSH exchange and SSH already owns
  password/host-key UX.
- Start `mosh --ssh=<resolved ssh invocation> -- <host> -- sh -lc <launcher>` with an explicit UDP
  port range and locale-safe output framing.
- Reuse the existing idempotent remote runner/state scripts; the managed T3 process must outlive the
  mosh client and be reusable after desktop restart.
- Treat mosh process loss as control-plane degradation. Do not tear down a healthy WebSocket
  connection or remote server.
- Re-establish the mosh session on demand for health checks, upgrades, log retrieval, or restart.

### 3. Client connection profile

- Add a managed-remote connection target/profile alongside `SshConnectionTarget`.
- Its resolver asks the desktop gateway to ensure the remote server/control plane, then authorizes
  against the direct Tailscale endpoint.
- Let `EnvironmentSupervisor` retain sole ownership of retry/backoff and cached thread continuity.
- Classify failures separately: local mosh missing, remote mosh-server missing, Tailscale offline,
  remote endpoint unavailable, authentication blocked, and server upgrade required.
- Keep retrying transient network/access failures forever with the existing capped backoff.

### 4. UX

- Add “Mosh + Tailscale” to Add Environment, with discovered SSH hosts and an advanced manual target.
- Preflight both machines and show actionable install/setup errors before saving.
- Present launch and access independently: for example “Remote server running · Tailscale
  reconnecting” or “Chat available from cache · remote machine unreachable”.
- Keep the conversation visible and composer draft intact during disconnects.
- Queue only commands that already have server-supported idempotency metadata; otherwise disable
  send with a clear reconnect state rather than risking duplicate prompts.
- Offer explicit actions for Retry, Re-open control session, View remote logs, and Switch endpoint.

### 5. Verification

- Unit-test command construction without shell interpolation, endpoint parsing, persisted-profile
  migration, and failure classification.
- Integration-test remote launcher reuse and server survival after killing the mosh client.
- Exercise Wi-Fi changes, suspend/resume, Tailscale loss/restore, UDP blockage, remote reboot,
  desktop restart, server upgrade, and authentication revocation.
- Verify an in-progress provider run continues remotely while the client is disconnected and its
  events reconcile exactly once after reconnect.
- Run `vp check` and `vp run typecheck`.

## First implementation slice

Build remote Tailscale endpoint discovery and the typed managed-remote profile first. This proves
the required direct data path before adding mosh process lifecycle. Then reuse the existing remote
launcher scripts from the mosh manager and add the UX after the resolver is covered by deterministic
tests.
