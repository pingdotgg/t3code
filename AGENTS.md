# T3 Code

T3 Code is a minimal GUI for coding agents. A Node WebSocket server wraps provider CLIs and agents (Codex, Claude Code, Cursor, Grok, OpenCode, Antigravity, Kiro) and serves web, desktop, and mobile clients.

You can think of T3 Code as an open source "bring-your-own-subscription" alternative to apps like Claude Desktop, Codex App, Cursor Glass and Conductor.

> **This checkout is `t3code-lockeddown`, a hardened fork.** It runs against proprietary company code, under one rule upstream does not hold: no code and no prompts leave the machine except through an authorized provider harness. Read [This is a locked-down fork](#this-is-a-locked-down-fork) before merging anything from upstream.

## What makes T3 Code special?

We have over 500,000 users who love T3 Code. It's important we maintain the things they love as we continue to iterate on the product. Here's a brief list of the things we can never compromise on.

### 1. Open at the core

T3 Code is truly open. We share our roadmap, we share how we think about things, and of course we share all our code. A large number of our users run forks. We work in the open, and should strive to stay that way.

### 2. Performance without compromise

Lots of apps have gotten bogged down with bad tech decisions and "slop". We have not, and we're proud of the performance of T3 Code. We regularly audit for performance regressions, often caused by sending too much data over websockets, css animations causing gpu spikes, lists being hard to render, and more. Make sure all changes are considerate of performance impact.

### 3. Remote ready

The architecture of T3 Code's websocket layer (npx t3) enables a lot of awesome remote features. These have become core to the product. Whether users are connecting directly over their local network, using Tailscale, or leaning in fully with T3 Connect (our tunnel solution, also in this repo), we need to make sure new features are properly supported.

### 4. Multi-surface

T3 Code has 3 key app surfaces: **web**, **desktop**, and **mobile**.

**Web** is kind of two surfaces, as we have the public facing "app.t3.codes" as well as locally hosting the web app through the `npx t3` command. Both need to be supported by all new features where reasonable.

**Desktop** is the main surface most users install first. It's a full Electron app that bundles the server runner as well. The desktop app can also be used as the host server, allowing remote connections from app.t3.codes or the mobile app.

**Mobile** is a React Native app for both iOS and Android, available on the App Store and Google Play. The mobile app allows for connecting to any T3 Code server to control work remotely.

## A note from Theo

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

Of note: Most T3 Code contributions will come from T3 Code itself, often controlled remotely. This means you should be careful about accessing data, killing dev servers, and other things that may damage the T3 Code instance that the contributor is using.

## A small glossary

We need to be on the same page with terminology. When communicating, use this language:

- **you** means the agent reading this file and changing T3 Code.
- **we, us, and maintainers** mean Theo, Julius and the people building T3 Code. These are who you are talking to now.
- **user** means the person using T3 Code to direct coding agents.
- **agent** means the coding agent a user runs inside T3 Code. Depending on context, that may also include you.
- **provider** means the agent runtime or harness T3 Code talks to, such as Codex, Claude, Cursor, or OpenCode.
- **client** means the web, desktop, or mobile UI.
- **environment** means one running T3 server and the machine, filesystem, provider credentials, and state it owns.
- **project** means an environment-local workspace record rooted at a directory.
- **thread** means the durable conversation and work history for a project.
- **turn** means one user-to-agent cycle, including follow-up work such as checkpointing.
- **T3 home** means the base data directory. Runtime state normally lives below its userdata directory.

## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs several other dev servers at once. Kill only a PID you captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your worktree.
2. **Writing to the live install.** `~/.t3/userdata` is the developer's real T3 Code database, in use while you work. Reading it and copying from it are fine, and a good way to get real test data (see Test data). Never start a server against it, never open it read-write, never clean it up.
3. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Dev is single-origin and Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`. Setting them bakes localhost into the bundle and silently breaks every remote browser.

## Hit every surface

The most common defect in this repo is a change that works on the path you tested and is missing everywhere else. Before calling frontend work done, walk this list and say which entries applied:

- **Entry points.** A behavior reachable from the chat view is usually also reachable from Settings, the command palette, and a keybinding. Fixing one is not fixing the feature.
- **Clients.** Web, desktop (wraps web, adds Electron shell/IPC), and mobile (React Native, separate navigation). Shared logic lives in `packages/client-runtime`
- **Providers.** Codex, Claude, Cursor, Grok, OpenCode, Antigravity, and Kiro each have an adapter. Provider-shaped features need a decision per adapter, even if the decision is "not supported here".
- **Agents.** A capability a user can trigger is usually one an agent should reach through MCP tools, and scheduled tasks run the same paths. That only works when it is a service method, not handler code.
- **Contracts.** Anything crossing the wire is typed in `packages/contracts`. Change the schema and the server, web, mobile, and desktop all follow.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Snooze needs unsnooze. Close needs reopen. A one-way door is a bug.
- **Connection modes.** Local, remote/relay, and tunnel behave differently. Multi-device and multi-environment cases are real.
- **Docs.** Check whether the change makes existing guidance inaccurate. Apply the [documentation rules](#documentation) before adding anything.

## Dev servers

- `vp i` installs. Worktrees get this from the t3.json setup script; if module resolution looks broken, it probably did not run.
- Setup runs in the background. While `.t3/setup-running` names a live PID, wait for it and do not run `vp i`. It ends with `.t3/setup-done` or `.t3/setup-failed` (with the error tail). With no marker at all, setup never ran here, so run `vp i` yourself.
- `vp run dev` starts server and web. In a worktree, state defaults to that worktree's gitignored `.t3`, which deliberately outranks an ambient `T3CODE_HOME` so you cannot land on shared state by accident. An explicit `--home-dir` still wins.
- Ports derive from the worktree path and are stable across restarts, but read the real ones from the `[dev-runner]` line since occupied ports shift.
- Sharing over the tailnet is three steps: run `vp run dev --share` in the background, wait for the `pairingUrl:` line in its output, then give that full URL to an unpaired browser. Do not wire up `tailscale serve` by hand, open the URL yourself, or consume the user's pairing link. A browser with the reusable dev cookie can use the bare origin. If a normal one-time token was consumed, mint a fresh one with `node apps/server/src/bin.ts pair`. It carries standard scopes, while the startup URL carries admin scopes needed for Connections settings.
- To reuse web dev auth across worktrees, configure one fixed `T3CODE_DEV_AUTH_TOKEN` in the main checkout's gitignored `.env`. The `t3.json` setup links that file into worktrees. Never commit or publish the token or a startup URL. See [Reusable dev credential](docs/operations/development.md#reusable-dev-credential).
- Stop what you started, by the PID you tracked. See rule 1.
- Need a second checkout? `git worktree add` it next to this worktree, not in `/tmp`. Remove it when done.

## This is a locked-down fork

`mahruskazi/t3code-lockeddown` is a fork of `pingdotgg/t3code` that exists for one reason: **it is safe to point at proprietary company code and data.** The agents running inside this app read confidential repositories, credentials sit in the environments it connects to, and everything an agent sees passes through this server.

Upstream is a healthy, fast-moving open source project with a large contributor base and bot-authored commits. That is good for upstream's users and it is exactly why we do not track it blindly: every line we merge gains the same access to that data as the lines we wrote ourselves.

### The rule

**No code and no prompts leave this machine, except through an authorized provider harness.**

The authorized path is the one the product exists for: a provider CLI — Codex, Claude Code, Cursor, Grok, OpenCode, Kiro, Pi, Muse, fx — sending a turn to its own model API under the operator's own subscription. That is a deal the operator already made with that vendor deliberately, and it is the only channel that may carry source code, diffs, file contents, terminal output, or prompt text off this machine.

Everything else is a leak, including the well-meant kind: analytics, crash reporting, "anonymous" usage pings, remote log shipping, a debug endpoint, a prefetch, a provider adapter that quietly widens what it puts in a payload. Intent does not enter into it. A host we did not choose receiving bytes we did not review is the failure, whether it got there by an attacker, a contributor, or a dependency.

Two things follow, and they are why the invariants below exist:

- **Code we did not choose must not run here.** Anything fetched and executed gets the same access to the data as our own code, so a runtime download is an egress path with extra steps.
- **The rule binds the merged tree, not our commits.** Upstream code ships into the same process with the same access. That is what the audit process below is for.

### Where data legitimately goes

Every outbound path this fork has, and what it may carry. A path that is not on this list is a finding.

| Path                                                                                          | Carries code or prompts                                                         | Status                                                                                                                                       |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider harnesses (Codex, Claude Code, Cursor, Grok, OpenCode, Kiro, Pi, Muse, fx)           | Yes — this is the authorized harness                                            | The product. Claude and Cursor run in-process via their vendors' SDKs, not spawned CLIs. See the notes below.                                |
| Codex `/feedback` upload (OpenAI, through the Codex CLI)                                      | Yes — the whole thread plus Codex's own logs                                    | Opt-in per invocation; the user types `/feedback` in a Codex thread. See the note below.                                                     |
| Source-control hosts (GitHub, GitLab, Bitbucket, Azure DevOps, Forgejo/Gitea, GitCafe)        | Yes — but to the repo's own remote, under the operator's credentials            | Authorized. Includes the PR media proxy, which keeps the token on GitHub hosts (`apps/server/src/assets/GitHubMediaFetch.ts`)                |
| T3 Connect relay (`app.t3.codes` plus a cloudflared tunnel)                                   | Yes — the entire session                                                        | Opt-in per environment via `t3 connect`, never on by default. See the note below.                                                            |
| `t3 triage` and in-app triage (public issue on `pingdotgg/t3code`)                            | Yes — logs, DB contents, terminal output                                        | **Removed** — invariant 4                                                                                                                    |
| PostHog analytics                                                                             | Event metadata                                                                  | **Removed** — invariant 1                                                                                                                    |
| Mobile crash reports (`expo-observe`, relay to Axiom)                                         | Error messages and stacks, which can quote thread content                       | **Removed** — invariant 1 (`apps/mobile/src/features/observability/observe.ts`, `[fork:lockdown]`)                                           |
| npm registry or GitHub release archives, at runtime                                           | No, but pulls executable code onto the machine                                  | **Removed** — invariants 2 and 3                                                                                                             |
| ACP Registry agents (`cdn.agentclientprotocol.com`, then archives, npm, PyPI)                 | Yes — the agent it installs runs every turn                                     | **Removed** — invariant 2                                                                                                                    |
| Managed Codex and Antigravity installs (GitHub releases, `dl.google.com`)                     | No, but are executables                                                         | Pinned version, sha256 in the source, fetched only when the operator picks managed setup. See the note below                                 |
| Headless preview browser (Chrome for Testing, `storage.googleapis.com`)                       | No, but is an executable                                                        | Pinned version, sha256 in the source, fetched the first time the server-side browser is used (`apps/server/src/preview/PreviewBrowser.ts`)   |
| Link and tab favicons (Google's `s2/favicons`)                                                | No — but every public hostname that appears in a chat link or browser tab       | **Removed** — `faviconUrlForOrigin` returns nothing (`packages/shared/src/favicon.ts`, `[fork:lockdown]`)                                    |
| Provider update checks (`registry.npmjs.org`, Homebrew, `api.meta.ai`, `downloads.claude.ai`) | No — a package name and the installed channel                                   | Version lookups, gated by the provider-update-check setting (`packages/provider-core/src/server/maintenanceResolver.ts`)                     |
| T3 release lookup (`registry.npmjs.org/t3/<version>`, or the configured npm registry)         | No — a version number                                                           | Read-only server check behind "update everything" (`apps/server/src/cloud/npmRelease.ts`)                                                    |
| Browser-panel address bar search (`duckduckgo.com` by default, or the chosen engine)          | Whatever the user types into the address bar that is not a URL                  | User-typed only; agents navigate by URL (`packages/shared/src/preview.ts`)                                                                   |
| Codex ChatGPT sign-in (`auth.openai.com`, `api.openai.com/v1/models`)                         | No — an OAuth token and the model list                                          | Operator-triggered, for managed Codex setup (`apps/server/src/provider/CodexChatGptAuth.ts`)                                                 |
| CLIProxyAPI usage source (operator's own hub)                                                 | No — quota reads and the Codex reset-credit claim, through the hub              | Operator-configured URL, off by default (`apps/server/src/usage/cliproxyApi.ts`)                                                             |
| Provider account usage (Anthropic, Cursor, xAI, OpenCode, Google)                             | No — reads each CLI's saved login and asks that same vendor for quota and usage | Automatic with provider status checks; Cursor's Keychain read is opt-in; the Claude reset-credit claim is user-triggered. See the note below |
| GitHub release list (`api.github.com`)                                                        | No — release metadata                                                           | Read-only fetch by the mobile app's server-update check (`apps/mobile/src/features/settings/environment-maintenance.ts`)                     |
| `cloudflared` binary download                                                                 | No, but is an executable                                                        | Pinned version, sha256-verified, fetched only when the operator turns on T3 Connect (`packages/shared/src/relayClient.ts`)                   |
| litellm pricing table (`raw.githubusercontent.com`, `api.github.com` fallback)                | No — a rates JSON, cached for a day                                             | Read-only fetch (`apps/server/src/usage/UsageService.ts`)                                                                                    |
| Model classification manifest (`raw.githubusercontent.com`)                                   | No — a list of current model slugs, cached for an hour                          | Read-only fetch, gated by the provider-update-check setting (`apps/server/src/provider/ModelManifest.ts`)                                    |
| Open VSX theme search (`open-vsx.org`)                                                        | No — a theme query from the web client                                          | Read-only fetch (`apps/web/src/openVsxThemes.ts`)                                                                                            |
| OTLP traces, metrics and logs export                                                          | No — span metadata and log lines, including workspace and worktree paths        | Operator-configured, off by default. See the note below (`apps/server/src/observability/Observability.ts`)                                   |
| Managed-policy update mirror (the `feedUrl` an administrator sets in the machine policy)      | No, but the desktop app installs the builds it serves                           | Off unless a machine policy sets it; the desktop updater follows it, the server's self-update never downloads. See the note below            |
| Hosted app auth (`app.t3.codes`, Clerk)                                                       | No — account identity                                                           | Only on the hosted-web and relay paths                                                                                                       |
| Linked environments (another T3 server you link)                                              | Yes — `delegate_task` sends the task prompt, and it runs on that machine        | Labs beta, off by default on both ends; each link is paired and approved by the user. See the note below                                     |
| Guest links (a guest's browser, over T3 Connect)                                              | Yes — the shared thread's history, replies, files and command output            | Labs beta, off by default, and needs T3 Connect. See the note below                                                                          |
| EAS cloud simulators (`api.expo.dev`) and Simlock gateways                                    | Whatever the agent installs on or shows the device: app builds, screens         | Operator-added device hosts only, with the operator's Expo token or gateway (`apps/server/src/device/EasDeviceHost.ts`)                      |
| GitHub star check (`api.github.com`, the server's GitHub login)                               | No — whether that account starred `pingdotgg/t3code`                            | Web client asks once after five prompts (`apps/web/src/components/GitHubStarPrompt.tsx`)                                                     |
| Orbit broker (the local Orbit daemon, `http://127.0.0.1:<port>/internal/t3/tool`)             | Yes — prompts, ticket text and notes an agent passes, but only to this machine  | Off unless `T3CODE_ORBIT_BROKER_TOKEN_FILE` is set; loopback enforced in code. See the note below (`apps/server/src/mcp/OrbitBroker.ts`)     |

**The Claude harness is a library, not a subprocess.** Upstream moved the Claude provider from a
spawned `claude` CLI to `@anthropic-ai/claude-agent-sdk` running inside the server process
(`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`). The destination is unchanged — Anthropic, under
the operator's own subscription, carrying the turn — so it stays the authorized path. What changed is
the shape: the server now makes those HTTPS calls itself rather than handing them to a separate
process, so the harness boundary is a dependency version rather than a process boundary. The SDK's
bundled platform binaries are removed by `pnpm-workspace.yaml` overrides and the user's own Claude
executable is always supplied, so no vendored binary ships. Treat an SDK bump as provider-adapter
surface in the audit: read the diff for widened payloads, not just for a version number.

**Cursor is a library too.** Upstream's Cursor provider runs `@cursor/sdk` in the server process
(`packages/provider-cursor/src/server/CursorAgentSdk.ts`) and talks to `api2.cursor.sh` under the
operator's Cursor login, so it is the same authorized-harness shape as Claude. The SDK bundles a
Statsig client; it is constructed with `disableLogging`, `disableStorage` and
`networkConfig.preventAllNetworkTraffic`, bootstrapped from Cursor's own API, so nothing reaches
Statsig's hosts. Its platform package (sandbox helper, ripgrep, tree-sitter) arrives at install time from
the lockfile, not at runtime. Treat an SDK bump like a Claude SDK bump: re-check that Statsig
configuration and any new host in its bundle.

**Managed Codex and Antigravity installs are pinned downloads.** Choosing managed setup for a Codex or
Antigravity instance downloads that vendor's own harness binary (`CodexInstallation.ts`,
`antigravityRelease.ts`) from a URL and sha256 written in the source, the same shape as `cloudflared`.
The bytes are fixed by a reviewed commit, which is what separates them from the ACP Registry, whose
content a third party picks at fetch time. A bump changes those constants; read them in the audit.
The server-side headless browser (`apps/server/src/preview/PreviewBrowser.ts`) is the same shape, a
pinned Chrome for Testing build, except that it installs on first use, so an agent driving the browser
can trigger the download.

**Webhook automations take input from anyone holding the URL.** A scheduled task can be triggered by
`/api/hooks/<hookId>/<token>`, directly or through the T3 Connect relay. The token is the only
credential unless the operator adds a signature check, and the request body can be templated into the
agent's prompt. Nothing flows back to the sender, but creating one hands that sender a way to start an
agent run on this machine, so treat it as an access decision like T3 Connect.

**Codex `/feedback` is a deliberate upload, not a turn.** Sending `/feedback` in a Codex thread calls the Codex app-server's `feedback/upload`, which posts that thread's transcript to OpenAI with `includeLogs: true` and returns an id to quote at OpenAI support. It rides the authorized harness and goes to the vendor whose CLI already sees every turn in that thread, which is why it is not a fifth invariant — but the logs are wider than a turn, and nothing about the payload is reviewable from here. Treat invoking it on a proprietary thread the way you would treat pasting that thread into a vendor support ticket, because that is what it is. Nothing sends it automatically: no code path reaches `uploadFeedback` without the user typing the command.

**T3 Connect is the open one.** This fork has not disabled it, and it is the one available path that would carry everything — code, prompts, diffs, terminal output — through a third party. It takes a deliberate `t3 connect` to start, so nothing leaks by accident, but enabling it on a machine holding proprietary code is an authorization decision, not a convenience. Local network and Tailscale reach the same clients without it. If we ever decide the relay is out of bounds here, that becomes a fifth invariant with a choke point and a tripwire, like the four below.

**OTLP export is the other operator switch.** Setting `otlpTracesUrl`, `otlpMetricsUrl` or `otlpLogsUrl` makes the server forward its spans, metrics or log records to that URL on an interval, alongside the local `server.trace.ndjson` it always writes. The spans carry operation names, provider kind, model names, thread and turn ids, and attachment counts — not prompt text, file contents, diffs, or terminal output. They do carry `terminal.cwd`, `checkpoint.cwd`, and `git.cwd`, so a collector learns the paths of the repositories worked on here, which is enough to identify projects and clients. Nothing filters span attributes; the only redaction in the pipeline covers HTTP header names. The settings are empty by default and are set from `settings.json` or `T3CODE_OTLP_*`, never from the Settings UI, which only reports whether export is on. Upstream also honors the standard `OTEL_EXPORTER_OTLP_*` variables; this fork ignores them unless `T3CODE_OTEL_STANDARD_ENV=true` (`packages/shared/src/otelEnvironment.ts`, `[fork:lockdown]`), because a machine-wide endpoint set for some other tool would otherwise start shipping this server's telemetry without anyone deciding to. Pointing them at a collector on a machine holding proprietary code is an authorization decision, the same shape as T3 Connect.

**Provider account usage reads the CLIs' logins.** Upstream's usage limits read each provider CLI's
saved credential — `~/.claude/.credentials.json`, Cursor's `auth.json` or macOS Keychain entry, `~/.grok/auth.json`,
OpenCode's `auth.json` — and call that vendor's own account endpoints (`api.anthropic.com/api/oauth/usage`,
`api2.cursor.sh` and `cursor.com`, `cli-chat-proxy.grok.com`, `opencode.ai`, and for Antigravity Google's
`cloudcode-pa.googleapis.com` after refreshing its token at `oauth2.googleapis.com`). The credential goes back to the vendor that
issued it and the response is quota and token counts; no code or prompt text is sent. The Claude reset-credit claim
spends a credit on the account, so it only ever runs when the user asks.

**The desktop app can now read your browser's cookies.** Upstream added a browser-import feature
(`apps/desktop/src/preview/BrowserImport/`) that decrypts Chromium, Firefox and Safari cookie
databases and writes them into the in-app preview browser's Electron partition. It reaches the OS
credential store through `@napi-rs/keyring` and, on Linux, a small libsecret helper we build from
source (`native/browser-secret/main.c`). Nothing leaves the machine: the cookies move from one local
store to another, and macOS still shows its keychain prompt. It is on this page because the preview
browser is remotely drivable — once real session cookies live in it, anyone who can drive this
environment can reach the sites those cookies authenticate. That is an access decision, the same
shape as T3 Connect and OTLP, not a leak.

**Linked environments and guest links move threads off this machine.** A linked environment is
another T3 server the user pairs with this one; `delegate_task` runs a task there, so its prompt
and the work it does live on that machine. A guest link opens one thread to whoever holds the URL,
through T3 Connect. Both are Labs betas that are off by default, and both are access decisions of
the same shape as T3 Connect, not leaks. `t3 up` (`apps/server/src/cli/up.ts`) preselects T3 Connect
on a fresh machine upstream; here it starts with Connect off unless `--connect` is given
(`[fork:lockdown]`), so `t3 up --headless` never turns on the relay by itself.

**A managed policy can repoint the desktop updater.** Upstream added machine policies
(`/etc/t3code/policy.json`, the Windows registry, or a macOS configuration profile; read by
`apps/server/src/policy/ManagedPolicy.ts` and `apps/desktop/src/app/DesktopManagedPolicy.ts`).
Only an administrator of the machine can write one, and most of what it does narrows access:
it can turn off telemetry, T3 Connect, remote clients and updates. Its `updates.feedUrl` is the
exception: the desktop app's updater then downloads and installs builds from that mirror. The
server's self-update ignores the mirror here and still runs only a provisioned runtime
(`pinnedRuntime.ts`, `[fork:lockdown]`). Setting a feed URL is an access decision, the same shape
as T3 Connect.

**The Orbit broker stays on this machine.** Orbit is the operator's local planning daemon, and this
fork's `orbit` MCP tool forwards an agent's fixed planning operations to it with T3-verified
environment, thread and provider-session identity. That body can hold whatever the agent passes:
thread prompts, ticket text and progress notes, plus those identifiers. With
`T3CODE_ORBIT_BROKER_TOKEN_FILE` unset, the tool is not advertised and Codex approval policy is
unchanged. When set, the file must be owner-only (no group or other bits) and its credential is read
per call, never placed in a prompt, log or transcript. The destination is fixed to `127.0.0.1`;
`T3CODE_ORBIT_PORT` only accepts a port number. `loopbackOnly` refuses any other URL before it
reaches the transport, and the transport is `node:http` with its own agent because `fetch` would
follow a 307 to another host with the body, and honor `NODE_USE_ENV_PROXY`. Providers other than
Codex (host attestation) and Claude (SDK hook) cannot separate a native child from its parent, so
they get `orbit_context` only. Orbit is responsible for what it does with the data afterward, and
the token file is readable by any process running as this OS user, including an unsandboxed agent's
shell. Tripwires: `OrbitBrokerEgress.test.ts` (real redirect and env proxy) and `OrbitBroker.test.ts`.

**Upstream's `cursor-hygiene-webhook` workflow is not carried here.** It POSTs the full GitHub event
payload — PR titles and bodies, issue and discussion text — to a Cursor webhook on every push, PR,
issue and discussion. It no-ops without its two secrets, so it was inert, but it forwards this
repository's activity to a third party the moment anyone sets them. Deleted on sync; delete it again
if a future merge brings it back.

### The invariants

The rule above is enforced in review. These four leak paths are closed in code instead, so they cannot come back quietly. They are invariants, not preferences. Restoring any of them is a regression no matter how the change arrives — an upstream merge, a dependency bump, a "harmless" revert. Every touch point carries a `[fork:lockdown]` marker:

```
git grep -n "fork:lockdown"   # every lockdown touch point, at any time
```

1. **No telemetry leaves the machine.** `apps/server/src/telemetry/AnalyticsService.ts` binds the live layer to the no-op service, so the PostHog client is never constructed, no flush fiber runs, no identity file is read, and no environment variable can turn sending back on. Server start does not read provider logins for owner ids (`serverRuntimeStartup.ts`). The mobile app's crash reporter never dispatches and its native endpoint is `.invalid` (`apps/mobile/src/features/observability/observe.ts`, `app.config.ts`). Tripwires: `AnalyticsService.test.ts` enables telemetry in config and asserts zero outbound requests; `observe.test.ts` asserts crash reports never dispatch.
2. **No executable code arrives from the network at runtime.** `apps/server/src/cloud/pinnedRuntime.ts` is the single choke point covering server self-update and boot-service installs. Upstream downloads a `pingdotgg/t3code` GitHub release archive on demand (it used to `npm install t3@<version>`); this fork reuses a complete runtime already on disk and hard-errors otherwise, so an update can only ever run a build we provisioned. Upstream's `t3 update` command, which does the same from the CLI, is not registered. Device support (`apps/server/src/device/DeviceToolchain.ts` and `sshDeviceScript.ts`) npm-installs `expo-device-hub` and `agent-device` upstream; here it uses a provisioned install or fails. Upstream's ACP Registry provider reads the public registry at `cdn.agentclientprotocol.com` and downloads the agent it names, as an archive or an `npx`/`uvx` package; here the live catalog (`layerFromHost` in `packages/provider-acp-registry/src/server/AcpRegistrySupport.ts`) refuses every registry operation, and only the Local command source, an executable the operator installed, launches. Tripwires: `pinnedRuntime.test.ts` (a process runner and HTTP client that die on any call), `selfUpdate.test.ts`, `binCli.test.ts` (`update` absent), `DeviceToolchain.test.ts`, `sshDeviceScript.test.ts` and `AcpRegistryLockdown.test.ts`.
3. **Remote hosts run our build, never a published one.** Upstream's SSH launcher downloads and runs a GitHub release archive for the client's version (it used to fall back to `npx t3@<version>`). This fork removes the download path entirely (`REMOTE_RUNNER_SCRIPT` in `packages/ssh/src/tunnel.ts`): the runner execs the `t3` on the remote PATH or fails with provisioning instructions. Tripwire: `tunnel.test.ts` asserts the generated scripts contain no npm, npx, curl, wget or release-archive path, and runs the real runner against a sandboxed home. See below for how provisioning works.
4. **Diagnostic bundles never leave the machine.** Upstream ships `t3 triage` (`apps/server/src/cli/triage.ts`), which seeds a local coding agent to investigate the state database, provider event log, and terminal logs, then file the findings as a public issue on `pingdotgg/t3code`. Here that evidence _is_ the proprietary material, and upstream's redaction step covers credentials and home paths but not source, prompt text, or repo identities. This fork does not register the command and does not carry its playbook or issue template. Upstream's in-app version ("Triage an issue" in the command palette) goes through `apps/server/src/triage/TriageService.ts`, which here refuses every request; the server does not advertise the `triage` capability, so web and mobile hide the entry, and the boot-error screen no longer suggests `npx t3 triage`. Tripwires: `binCli.test.ts` asserts `triage` is absent from the CLI; `TriageService.test.ts` asserts the service refuses.

Pi is an upstream provider, Usage tab included. The fork carries one Pi change on top: background subagents and structured user input (`packages/provider-pi/src/server/backgroundSubagents.ts`, `userInput.ts`), with Lineage rows for agents that have no child thread.

### Auditing an upstream merge

Upstream is not hostile, but it is a large public codebase we do not review as it lands. Treat every sync as a supply-chain event: **nothing merges unaudited.** The point is not to re-review upstream's engineering, it is to answer one question — does anything here move our data somewhere new, or run code we did not choose?

Work from the last audited sync commit, not from ahead/behind counts. Upstream rewrote `main`'s history in August 2026, so parts of it appear twice under different SHAs and `git cherry` reports every fork commit as unique. Record the sync commit in the merge message so the next audit has a real starting point.

```
git fetch upstream
git log --no-merges --format='%h %an %s' <last-sync>..upstream/main
git diff <last-sync>..upstream/main
```

Read the whole diff at least at file-name level, then look hard at:

- **New or bumped dependencies.** `package.json` and `pnpm-lock.yaml` additions are the highest-risk item in any sync — a new transitive package is code we never read, running with our access. Justify every addition, and check `postinstall`/`prepare` scripts on anything new.
- **New outbound network calls.** Grep the diff for `fetch(`, `http://`, `https://`, new hostnames, analytics or error-reporting SDKs. Any new destination has to earn a row in the table above or it does not merge. A crash reporter is telemetry wearing a different hat.
- **The invariant files themselves.** Anything under `apps/server/src/telemetry/`, `apps/server/src/cloud/`, or `packages/ssh/`, plus the CLI registration in `apps/server/src/binCli.ts`. Conflicts here are expected and always resolve toward the fork.
- **Anything that reads outside the workspace.** Environment variables, `~/.t3` state, secrets, SSH config, git credentials — especially where the value then flows into a request body, a log line, or a provider prompt.
- **Provider adapters.** A new endpoint or a widened prompt payload changes where our source code gets sent. The harness is authorized; an adapter sending more than the turn to somewhere else is not.
- **CI and build config.** `.github/workflows`, build scripts, and Electron entitlements can exfiltrate or weaken the shipped app without touching product code.
- **Auth, pairing, and permission paths.** Anything that widens who can connect, or what a connected client may do, is a data-access change.

Then, before pushing the merge:

- Run the tripwires: the telemetry, pinned-runtime, self-update, tunnel, CLI-registration, and Orbit broker egress tests above. They are the automated half of this audit and they must pass on the merged tree, not just on the fork's side.
- Confirm `git grep -n "fork:lockdown"` still finds every marker — a vanished marker means an upstream hunk overwrote a lockdown edit.
- If something in the diff is unclear, it does not merge until it is understood. "Probably fine" is not an audit result.

### Remote environments (Coder / SSH)

This fork is deployed to remote SSH hosts (e.g. Coder workspaces) from the local checkout, never from the published npm package. Provisioning works like this:

- `scripts/setup-remote-t3.sh <ssh-host> [remote-dir]` rsyncs this checkout to the remote, builds `apps/server/dist/bin.mjs` there (mise-pinned node 24 + repo pnpm, `--frozen-lockfile`), and installs a `~/.local/bin/t3` shim pointing at that build. The launcher finds the shim via its `command -v t3` branch.
- The script is idempotent: re-run it after changing the fork, then disconnect and reconnect the environment in the desktop app so the launcher restarts the server from the new build. The launch script now calls `t3 __ssh-helper` on the remote, so a host provisioned before that command existed must be re-provisioned before it will connect.
- Do not reintroduce the npm install fallback — it would silently swap this fork's server for the upstream published one on any unprovisioned host, which is invariant 3.
- The remote host needs mise (`curl -fsSL https://mise.run | sh`) and a C toolchain for node-pty; everything else the script handles.

## Test data

An empty database is a bad test. Seed your worktree's `.t3` with a copy of real data instead of pointing at live state:

- The first `vp run dev` in a worktree does this for you when its database is missing and the source is at most 500 MiB. Larger sources warn and dev starts with an empty database. `--no-seed` or `T3CODE_DEV_SEED=0` skips seeding. Manual migration still accepts larger sources and may use substantial disk space before pruning.
- Run `vp run migrate-dev-db` with your dev server stopped to refresh. It rebuilds `<worktree>/.t3/userdata/statev2.sqlite` from a read-only snapshot of `~/.t3/userdata/statev2.sqlite`, the developer's real data. It keeps recent projects and their stopped threads, and drops scheduled tasks, pending work, auth sessions, and links to other environments, so your dev server never runs the developer's agents or reaches their other machines. Raise `--projects` and `--threads-per-project` for more data.
- Refresh `statev2.sqlite`, not `state.sqlite`. The server copies the V1 `state.sqlite` only when `statev2.sqlite` is missing.
- Bring `secrets` and `settings.json` only if the flow under test needs them.
- Copy in, never symlink. Data flows one way: into your sandbox, never back out.

## Verifying

- Before you push, run `vp run check:changed`. It runs CI's fast checks for changed files: format, lint, knip, typecheck of affected packages and dependents, tests beside changes, and the cross-file checks those miss. CI still runs the full test suites.
- While you iterate, run `vp test run <files>`. For big files, add `-t "<name>"`.
- Use `vp run typecheck`; it caches per package. Each package runs `effect-tsgo tsrs --noEmit`, the Rust TypeScript 7 checker with Effect's diagnostics built in. There is no `typescript` package to run.
- Run `node -e` snippets from `apps/server` or the owning package. `effect` does not resolve from the repo root.
- Test behavior that can break, such as orchestration and event-sourcing, provider protocol translation, auth and permission guards, persistence and migrations, external-format parsing, race fixes, and the logic a bug fix changed. Leave out tests for what types already guarantee, trivial logic, copy text, smoke runs, mock-call mirrors, callback wiring, and props rendered to static markup.
- Extend before you add. When an existing test or table covers the behavior, add a row or an assertion there. Write a new `it` only when no case fits.
- Test at one layer: the lowest one that fails on `main`. Do not repeat the case in a wrapper test, at each call site, or in web and mobile copies of the same logic.
- [Testing](docs/internals/testing.md) carries these same test rules, plus review guidance, for review bots. Change both together.
- **Do not run repo-wide checks.** No `vp check`, no `vp run -r test`, no `vp run -r typecheck` unless I ask. CI owns the full suite.
- Backend behavior changes ship with focused tests for that behavior.
- Proof for a bug fix depends on the bug. Logic, data, state, and protocol bugs get a failing test first (the fewest that fail on `main` for that reason, in an existing case of the module's test file where one fits), then the fix. Purely visual bugs (spacing, colour, alignment, a layout shift) get before/after captures as their proof and no test: do not add UI tests for nitpicks, and do not ask for one in review when a capture already shows it. A server-only fix with no visible surface ships the test plus a short runtime transcript.
- The server is event-sourced, and side effects run after the command commits. In tests, drain the effect worker (`OrchestrationEffectWorkerV2.drain`) or await the specific persisted event or `Deferred` that marks the milestone. Never wait on sleeps or polling. A test that needs a timeout to pass is wrong. Concretely:
  - `it.effect` runs on a `TestClock`; `Effect.sleep` only advances through `TestClock.adjust`. `it.live` is wall-clock and only for subprocess or network fixtures.
  - No `yieldNow` or `sleep` polling loops. Await the `Deferred`, take from the `Queue`, or drain the worker.
  - No per-test timeout argument or `retry`. The project timeout is the ceiling, and flaky tests are fixed, not retried.
  - No `performance.now()` or `Date.now()` deltas. Assert on events and counts, not elapsed time.
  - Browser tests assert through `expect.element` or `vi.waitFor`, never `requestAnimationFrame` or `transitionend`.
  - `vi.mock` factories must not spread a real module that pulls in Shiki or the diff workers.
  - `it.skip` and friends need a tracking issue on the line above: `// quarantine: #1234 <why>`.
  - Lint enforces this: `t3code/no-test-timeout-or-unreasoned-skip`, `t3code/no-frame-waits-in-browser-tests`, `t3code/no-wall-clock-in-tests`, `t3code/no-real-time-wait-in-tests`, `t3code/no-polling-loop-in-tests`.
- Web browser tests are `*.browser.test.tsx` or `*.browser.test.ts` and render with `await using screen = await render(...)` from `apps/web/test/render.tsx`. `t3code/require-disposable-render` errors on the old patterns.
  - Acquire what the test drives after mounting (fake timers it advances, spies it sets up after mounting) after the render, so it disposes before the unmount. Anything the first render reads comes before it.
  - A helper that renders and then waits or clicks puts the screen in an `AsyncDisposableStack` and `move()`s it out only on success, so a failed wait still unmounts.
  - `rerender` needs a fresh element on every call.
  - No lifecycle hooks and no module-level mutable state. Shared mock state that `vi.mock` factories read is reset by a `setup()` call at the top of the test.
  - `router` is on by default. Pass `router: false` only with a one-line comment saying why.

  ```tsx
  it("saves on Enter", async () => {
    const onSave = vi.fn();
    using _now = vi.spyOn(Date, "now").mockReturnValue(0);
    await using screen = await render(<TitleEditor onSave={onSave} />, { router: "/threads/1" });
    await userEvent.type(screen.getByRole("textbox"), "Title{Enter}");
    expect(onSave).toHaveBeenCalledWith("Title");
  });
  ```

- User-visible frontend changes should get one integrated pass in a real client: `test-t3-app` for web, `test-t3-mobile` for mobile. The primary agent does this once after integrating. Subagents do not launch their own dev servers.

- Real agent turns cost money. To watch a turn stream through the pipeline and UI, use the free `Replay (dev)` provider that `vp run dev` registers; [test-t3-app](.agents/skills/test-t3-app/SKILL.md) shows how to start one. Use a real provider only when the change depends on that provider's behavior, and then pick its cheapest model, such as Haiku for Claude or Luna for Codex.

For mobile verification, a missing or outdated native client is an install step, not a blocker. Run `vp run mobile:install <ios|android> [device-id]` on the device host before starting Metro; it targets the only booted simulator or connected Android device when the id is omitted. It installs the dev client for this checkout's native fingerprint from the shared cache in seconds and builds only when no machine has built it yet, so prefer it over `expo run:*`, `xcodebuild`, or `gradlew`, which rebuild from scratch. Its stdout is one JSON line; build output goes to the log it names. See `test-t3-mobile` for the full workflow.

## Evals

`evals/` checks how real models behave with T3 Code's model-facing text: agent instructions, MCP tool descriptions and schemas, and generated titles. Before you change that text, read [evals/README.md](evals/README.md) and run the evals it names. When you fix a model behavior bug, add a case that fails before the fix.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- If `origin` is git.cafe, follow [GitCafe mirror](docs/operations/development.md#gitcafe-mirror-optional): push to `origin`, open and track PRs with `cafe` and their git.cafe URLs, and keep `gh` for merging.
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- UI changes need before/after images. Motion or timing needs a short video.
- Upload PR evidence to GitHub. Never commit PR-only screenshots or assets such as `.github/pr-assets/`.
- One request is one PR. Split it only when the maintainer asks. Outside contributions follow the stricter [one problem per PR](CONTRIBUTING.md#one-problem) rule.
- When babysitting: call `watch_pull_request` and end your turn. T3 Code wakes you on checks, comments, or conflicts. Do not poll or sleep. Verify each bot finding against the source, fix real ones, dismiss false positives with a written reason. Stay quiet when nothing is new. Stop when the bots are green on the latest commit.

## Documentation

Most code changes do not need an internal documentation change. Agents can read the code.

- `docs/internals/` is for architectural decisions and their reasons, constraints that span components, and implementation traps that are hard to discover from the source. Before adding a paragraph, ask what a maintainer would get wrong without it. If reading the relevant code answers the question, leave it out.
- Do not document every feature, enumerate fields or methods, narrate control flow, maintain file catalogs, or append PR summaries. Types, tests, and code already record the implementation. The glossary defines shared vocabulary; it is not a feature index.
- A local reason the code can't show goes in a short nearby code comment. Use an internal doc when the reasoning crosses boundaries or needs context the code cannot carry well. Link to the relevant source instead of copying it.
- When a documented decision or constraint changes, rewrite or remove the affected text. Do not append another account of the new behavior. A new internal page needs a distinct, durable reason to exist.
- `docs/user/` helps users accomplish tasks. Give each major feature a concise section explaining what it does, how to start, and anything unintuitive. A settings path is useful; descriptions of visible buttons, icons, layouts, animations, or every UI state are not. Before adding text, ask what task or decision it helps the user with.
- Keep user docs in the shipped product's voice, without implementation details or contributor tooling. Update the relevant feature section when how to use it changes. A UI tweak does not need a documentation entry, and a new control does not need its own page.
- `docs/operations/` holds maintainer setup, release, and debugging procedures. Keep instructions for operating an installed T3 Code server in the user guides.

## Plans and work artifacts

- Do not commit implementation plans, research notes, or agent scratch files. Keep temporary working material outside the worktree. `.plans/` is gitignored only as a safety net for legacy tooling.
- Track active maintainer work in the GitHub issue or project item that owns it. External proposals follow `CONTRIBUTING.md` and belong in Ideas discussions.
- A merged PR is the implementation record. Close or update its tracking item when the work lands; do not preserve a second checklist in the repository.

## How it works

Clients send typed WebSocket requests. The server turns them into _commands_. The _orchestrator_ (`apps/server/src/orchestration-v2/Orchestrator.ts`) serializes commands and decides _events_ without doing any I/O. The _event sink_ commits those events, the _projections_ the UI reads, the _command receipt_, and _outbox_ effects in one transaction. The _effect worker_ then runs the effects, such as starting a provider turn or capturing a checkpoint, and feeds results back as commands. Provider CLIs run as subprocesses; per-provider _adapters_ translate their native protocols into orchestration events. Each turn ends with a _checkpoint_, a hidden git ref, so the app can diff and restore.

Architecture and its constraints: `docs/internals/overview.md`. Glossary: `docs/internals/glossary.md`

## Where code lives

- `apps/server` - WebSocket, orchestration, providers, checkpointing. Effect-heavy: read [Effect services](docs/internals/effect-services.md) before adding server code, and `.repos/effect/LLMS.md` for the Effect library itself.
- `apps/web` - React/Vite UI. `apps/desktop` wraps it, `apps/mobile` is React Native, `apps/marketing` is the site.
- `packages/contracts` - Effect/Schema contracts plus small derived helpers. No heavy runtime logic.
- `packages/shared` - shared runtime utils, subpath exports, no barrel.
- `packages/client-runtime` - client code shared by web and mobile.
- `.repos/` - vendored read-only references. Prefer their patterns over invented ones. Never edit or import from them. Sync with `vpr sync:repos` when bumping the matching dependency. If it is missing (sparse checkout), read a file with `git show origin/main:.repos/<path>`.

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Client mutations use `createEnvironmentRpcCommand`. Add protected methods to `CLIENT_GUARDED_RPC_SCOPES` in contracts and use the command's `permissionAtom` for UI availability. Grants are checked at execution against the destination environment; the server remains authoritative. Keep raw RPC clients inside `rpc/`, and extend the permission behavior tests when adding a protected method.
- Server features are services; transports stay thin. A `ws.ts` RPC handler, HTTP route, or MCP tool decodes input, calls one service method, and maps errors. See [Effect services](docs/internals/effect-services.md).
- `apps/web/src/components/ui` exports own their look. Pick a `variant` or `size`; do not restyle one with `className`. If none fits and the look is a generic concept, add a variant to the component; a look that belongs to one feature stays in that feature's own component, not in `components/ui`. Layout classes (width, flex, margin, position) belong on the parent. `shadcn/no-restyle` fails lint on violations. See [Web UI](docs/internals/web-ui.md).
- Reusable Effect functions use `Effect.fn("Service.operation")` with a stable span name, not a
  function wrapping `Effect.gen`. Keep `Effect.gen` for inline programs and layer construction.
  Use `Effect.fnUntraced` only when spans would be too frequent (stream chunks, per-event
  projection, tight loops) or duplicate an existing tracing boundary; explain that choice nearby.
  Named `Effect.fn` creates a span; the unnamed form does not. Preserve existing span names and
  options, and pass combinators as additional function-builder arguments.
- Inferred types over annotations. `any` is the enemy.
- Default to no comment. Write one only for a constraint, an external quirk, or an invariant the code can't show, in one line where you can and four at most. Don't restate names or signatures, narrate steps, record history, or explain the fix you just made; the PR carries that. `t3code/no-low-value-comments` enforces the length cap and the mechanical cases.
- React effects are for synchronizing with something outside React. Derive in render and act in handlers instead of syncing state, but don't hide real lifecycle work in refs or stores to dodge one. The `t3code/no-unreasoned-state-sync` lint rule reports every effect; one that stays states its reason with `// oxlint-disable-next-line t3code/no-unreasoned-state-sync -- <why>`.
- Our users drive agents all day and notice a dropped frame, a lying spinner, and a stale label. No continuously repainting animations; they peg the GPU on high-refresh displays.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.

## Additional tips

- Security is important, but should not be over-indexed on, especially for dev mode/maintainer-only features.
