# 24 — Codex Onboarding: In-App Install + Login

## Goal

Let a non-technical tutor get **Codex** working entirely from inside the app —
no terminal, no `npm`, no `codex login` at a shell. They click a card, watch a
progress bar while Codex installs, sign in with their ChatGPT subscription (or an
API key), and see "Connected as …". No prerequisites on their machine.

Scope is **Codex only** for this iteration. Claude and Cursor reuse the same card
shell later, but their install/login mechanics differ (Cursor is not npm) and are
explicitly out of scope here. See *Future iterations* at the end.

## Strategic context

t3code was built assuming a developer installs the coding CLIs and runs their
login flows from a terminal. Our audience is tutors who will never open a
terminal. So the whole "go to a shell and run `codex login`" assumption has to be
absorbed into the desktop app.

The good news, after auditing the repo: **almost all the infrastructure already
exists.** This plan is mostly *wiring*, not new subsystems.

- **Detection** already exists: provider snapshots report `installed`, `version`,
  and `auth.status` (`apps/server/src/provider/providerSnapshot.ts`,
  `CodexProvider.ts:436`).
- **Install machinery** already exists: `providerMaintenance.ts` +
  `providerMaintenanceRunner.ts` shell out to `npm i -g @openai/codex@latest`
  (`CodexDriver.ts:61`) with timeouts + locking. It is wired today for *updates*;
  we extend it to *first install*.
- **Login API already exists in the protocol**: the Codex app-server (which we
  already spawn and talk to over JSON-RPC — `CodexProvider.ts:298-326`) exposes a
  structured login surface: `account/login/start`, `account/login/cancel`, and a
  pushed `account/login/completed` notification (`schema.gen.ts:34162`,
  `effect-codex-app-server/client.ts:40`). **No PTY, no output scraping, no secret
  handling** — Codex writes the token to `~/.codex/auth.json` itself.
- **Default Codex instance already exists**: the registry seeds one default
  instance per built-in driver at startup
  (`ProviderInstanceRegistryHydration.ts`, `defaultInstanceIdForDriver`), so there
  is always a Codex app-server to receive the login call.
- **Command plumbing has a precedent to copy**: `server.updateProvider` flows
  contracts → ws handler → runner → web (`rpc.ts:267`, `ws.ts:1029`,
  `ipc.ts:1070`, `apps/web/src/localApi.ts`). The new login command follows the
  same path.

Operative constraint: **ship fast, copy proven patterns.** Do not invent new
transport, new process management, or new secret storage.

> **Decision on file:** we are **not** doing a pre-build protocol spike. The
> `account/login/*` methods are generated from the Codex protocol spec but never
> yet exercised in this app, and we install `@openai/codex@latest` (unpinned), so
> there is a residual risk the shipped binary doesn't implement them. We accept
> that risk and treat the embedded log pane (Part C) + the API-key fallback
> (Part B3) as the safety net. If `account/login/start` returns "method not
> found" at runtime, fall back to driving `codex login` in a PTY (the terminal
> infra — `terminal/Layers/NodePTY.ts` + `ThreadTerminalDrawer.tsx` — already
> exists); that becomes a follow-up, not a blocker.

## Settled decisions

| # | Question | Decision |
|---|----------|----------|
| D1 | Where does the app run? | **Desktop app** on the tutor's own machine (`apps/desktop`). Has local shell + filesystem; install + login happen locally. |
| D2 | Install mechanism | **Bundled Node runtime** → install `@openai/codex` into an **app-private prefix**, prepend that dir to the spawn `PATH` (the app already resolves command paths via `resolveCommandPath`). Tutor needs no Node/Homebrew. |
| D3 | Auth methods to support | **Both**: ChatGPT-subscription OAuth (default) **and** API key (fallback). |
| D4 | OAuth variant (happy path) | **Localhost-callback first, device-code fallback.** Try `{type:"chatgpt"}` (opens `authUrl`, Codex's local callback completes); if no completion within a timeout, switch to `{type:"chatgptDeviceCode"}` (show `userCode` + `verificationUrl`). |
| D5 | Login UX shell | **Hybrid**: clean card + progress/sign-in UI by default; a **collapsible log pane** as the diagnostic safety net (reuse xterm/`ThreadTerminalDrawer`). |
| D6 | Completion detection | **Snapshot-driven.** On `account/login/completed` (or success of the start call for API key), refresh the Codex provider snapshot; the existing snapshot stream pushes `auth.status: "authenticated"` and the card reacts. No new push channel. |
| D7 | Where the card lives | **Both** first-run onboarding **and** Settings → Providers. One card component, rendered in two places. |
| D8 | Secret handling | **None by us.** Codex persists tokens/keys in `~/.codex/auth.json`. We never store or transit the secret beyond passing an API key straight into `account/login/start`. |
| D9 | Multi-CLI switching | **Out of scope / already modeled.** `composerDraftStore.activeProvider` (`composerDraftStore.ts:269`) + per-session `providerInstanceId` already let each session pick a provider. Adding Codex now just makes its instance authenticated; no global "mode" toggle to build. |

## Part A — Install Codex on the tutor's behalf

**A1. App-private install prefix + PATH.**
Define one app-owned directory (e.g. under the app's userData) as the global npm
prefix for provider CLIs. Install with the bundled Node:
`node <bundled-npm> install -g --prefix <appPrefix> @openai/codex@latest`.
Prepend `<appPrefix>/bin` to the `env.PATH` used when the server spawns provider
processes (the spawn env already flows through `ProviderInstanceEnvironment` /
`resolveSpawnCommand` in `CodexProvider.ts`). Verify `resolveCommandPath`
(`@t3tools/shared/shell`) picks up the binary from there.

**A2. Reuse the maintenance runner for first install.**
`providerMaintenanceRunner.ts` already spawns the install/update command with a
timeout (`UPDATE_TIMEOUT_MS`), output capture, and a lock key. Generalize its
"update" action to also serve "install when not present" — the command is the
same `npm i -g @openai/codex@latest`; only the surrounding label/UX differs.
Surface progress as command output streamed to the card (coarse-grained is fine:
"Installing…" with a spinner/indeterminate bar; npm gives limited progress).

**A3. Detection drives card state.**
The card's three states come straight from the existing snapshot:
`installed=false` → "Install"; `installed=true, auth!=authenticated` → "Sign in";
`auth=authenticated` → "Connected as …". No new detection code.

## Part B — Login, fully structured over the existing JSON-RPC channel

All three sub-flows call `account/login/start` on the Codex app-server via the
typed client `request` (`effect-codex-app-server/client.ts:40`) on the
already-spawned instance. Wrap them behind one server-side service (mirror
`ProviderMaintenanceRunner`'s shape) and one WS RPC.

**B1. OAuth — localhost callback (default).**
`request("account/login/start", {type:"chatgpt"})` → `{authUrl, loginId}`.
Open `authUrl` in the tutor's browser via Electron `shell.openExternal` (desktop)
/ `window.open` (web dev). Codex's own localhost callback captures the token and
emits `account/login/completed {success}`. On success → refresh snapshot (D6).

**B2. OAuth — device-code fallback (D4).**
If `account/login/completed` does not arrive within a timeout (port blocked /
redirect failed), call `account/login/cancel` then
`request("account/login/start", {type:"chatgptDeviceCode"})` →
`{userCode, verificationUrl, loginId}`. Show "Go to `verificationUrl` and enter
`userCode`". Same completion handling.

**B3. API key (fallback path).**
A form field → `request("account/login/start", {type:"apiKey", apiKey})` →
returns immediately. Refresh snapshot. (Key goes straight to Codex; we don't
retain it.)

**B4. Completion → UI update (D6).**
Subscribe to the `account/login/completed` notification on the instance's client
(the client already routes server→client notifications). On it, trigger a
snapshot refresh; the existing snapshot change stream flips the card to
"Connected as …" using `codexAccountEmail` / `codexAccountAuthLabel`
(`CodexProvider.ts:436`). No new web push plumbing.

## Part C — Wiring + UX shell

**C1. Contracts (`packages/contracts`).**
Add a WS RPC `server.startProviderLogin` (and `server.cancelProviderLogin`)
mirroring `WsServerUpdateProviderRpc` (`rpc.ts:267`): payload = `{provider,
instanceId, method: "chatgpt" | "chatgptDeviceCode" | "apiKey", apiKey?}`,
success = the start response (`authUrl` | `userCode`+`verificationUrl` | ack),
error union incl. authorization error. Register in the RPC group (`rpc.ts:684`)
and add to the desktop IPC surface (`ipc.ts:1069`). Keep contracts schema-only.

**C2. Server (`apps/server/src/ws.ts`).**
Add a handler next to `serverUpdateProvider` (`ws.ts:1029`) delegating to the new
login service; reuse the same auth scope wiring as
`WS_METHODS.serverUpdateProvider` (`ws.ts:150`). Put the
`account/login/*` calls in a new module under `apps/server/src/provider/`
(e.g. `CodexLogin.ts`) so the logic is testable and not inlined in `ws.ts`
(per AGENTS.md: extract shared logic, no local shortcuts).

**C3. Web (`apps/web/src`).**
- `localApi.ts` / `rpc/serverState.ts`: add the client calls.
- New `ProviderOnboardingCard.tsx`: the three-state card (Install → Sign in →
  Connected), progress bar, sign-in button / device-code panel / API-key form,
  and a collapsible log pane (D5) reusing the xterm component from
  `ThreadTerminalDrawer`.
- Render the card in onboarding **and** in `settings/SettingsPanels.tsx` (D7),
  near the existing provider update UI (`ProviderUpdateLaunchNotification.tsx`).

**C4. Desktop (`apps/desktop`).**
Implement `shell.openExternal` for `authUrl`/`verificationUrl`. Ensure the
bundled Node + app-private prefix (A1) are packaged and on the spawn PATH.

## Out of scope (this iteration)

- Claude and Cursor onboarding (Cursor is not npm — needs its own installer).
- Multi-account / multiple Codex instances (the default instance is enough now).
- Provider switching UX (already modeled — D9).
- Pre-build protocol spike (explicitly declined — see callout above).

## Future iterations

1. **Claude card** — npm `@anthropic-ai/claude-code`; reuse Part C shell, new
   login mechanics.
2. **Cursor card** — standalone installer (`cursor.com/install`) into the same
   app prefix; `cursor-agent login` mechanics.
3. **Account switching UI** in Settings once 2+ providers are authenticated.
4. **PTY login fallback** if any provider lacks a structured login API.

## Acceptance

- A machine with **no Node and no Codex** can: open the app → click the Codex
  card → watch install complete → sign in via browser (or device code, or API
  key) → see "Connected as <email>".
- `vp check` and `vp run typecheck` pass (AGENTS.md task-completion gate).
- No secret is stored or logged by app code; `~/.codex/auth.json` is the only
  credential sink.
