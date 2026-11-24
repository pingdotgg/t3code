# T3 Code

T3 Code is a minimal GUI for coding agents. A Node WebSocket server wraps provider CLIs and agents (Codex, Claude Code, Cursor, Grok, OpenCode, Antigravity, Kiro, Pi, Muse Code, fx) and serves web, desktop, and mobile clients.

You can think of T3 Code as an open source "bring-your-own-subscription" alternative to apps like Claude Desktop, Codex App, Cursor Glass and Conductor.

## What makes T3 Code special?

We have over 500,000 users who love T3 Code. It's important we maintain the things they love as we continue to iterate on the product. Here's a brief list of the things we can never compromise on.

### 1. Open at the core

T3 Code is truly open. We share our roadmap, we share how we think about things, and of course we share all our code. A large number of our users run forks (our MIT license covers source code only, not T3 Code's trademarks or branding; see [TRADEMARK.md](TRADEMARK.md)). We work in the open, and should strive to stay that way.

### 2. Performance without compromise

Lots of apps have gotten bogged down with bad tech decisions and "slop". We have not, and we're proud of the performance of T3 Code. We regularly audit for performance regressions, often caused by sending too much data over websockets, css animations causing gpu spikes, lists being hard to render, and more. Make sure all changes are considerate of performance impact.

### 3. Remote ready

The architecture of T3 Code's websocket layer (`t3`) enables a lot of awesome remote features. These have become core to the product. Whether users are connecting directly over their local network, using Tailscale, or leaning in fully with T3 Connect (our tunnel solution, also in this repo), we need to make sure new features are properly supported.

### 4. Multi-surface

T3 Code has 3 key app surfaces: **web**, **desktop**, and **mobile**.

**Web** is kind of two surfaces, as we have the public facing "app.t3.codes" as well as locally hosting the web app through the `t3` command. Both need to be supported by all new features where reasonable.

**Desktop** is the main surface most users install first. It's a full Electron app that bundles the server runner as well. The desktop app can also be used as the host server, allowing remote connections from app.t3.codes or the mobile app.

**Mobile** is a React Native app for both iOS and Android, available on the App Store and Google Play. The mobile app allows for connecting to any T3 Code server to control work remotely.

## A note from Theo

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

Of note: Most T3 Code contributions will come from T3 Code itself, often controlled remotely. This means you should be careful about accessing data, killing dev servers, and other things that may damage the T3 Code instance that the contributor is using.

## Terminology

- **you** = the agent reading this file. **we / us / maintainers** = Theo, Julius, and the people building T3 Code. **user** = person driving coding agents in T3 Code. **agent** = coding agent running inside T3 Code.
- Domain terms (environment, project, thread, turn, provider, checkpoint, etc.): [00_glossary.md](docs/internals/00_glossary.md).

## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs several other dev servers at once. Kill only a PID you captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your worktree.
2. **Writing to the live install.** `~/.t3/userdata` is the developer's real T3 Code database, in use while you work. Reading or copying from it is fine. Never start a server against it, never open it read-write, never clean it up.
3. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Dev is single-origin and Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`. Setting them bakes localhost into the bundle and silently breaks every remote browser.

## Hit every surface

The most common defect in this repo is a change that works on the path you tested and is missing everywhere else. Before calling frontend work done, walk this list and say which entries applied:

- **Entry points.** Chat view, Settings, command palette, and keybindings. Fixing one is not fixing the feature.
- **Clients.** Web, desktop (Electron shell/IPC), and mobile (React Native). Shared logic lives in `packages/client-runtime`.
- **Providers.** Every provider adapter needs a decision, even if the decision is "not supported here".
- **Agents.** Capabilities a user triggers should be service methods reachable by MCP tools and scheduled tasks, not inline handler code.
- **Contracts.** Wire changes go in `packages/contracts` so server, web, mobile, and desktop follow.
- **Reverse states.** Every way in needs a way out and a way to see it (snooze/unsnooze, close/reopen). A one-way door is a bug.
- **Connection modes.** Local, remote/relay, and tunnel; multi-device and multi-environment.
- **Languages.** Translate user-facing copy in `apps/{web,mobile}/src/i18n/translations` (`vp run i18n:generate` / `vp run i18n:check`) and `apps/marketing/src/i18n`. See [14_i18n.md](docs/internals/14_i18n.md).
- **Docs.** Check whether the change makes existing guidance inaccurate. Follow [Documentation](#documentation).

## Dev servers and test data

See [00_development.md](docs/operations/00_development.md) for setup, ports, seeding (`vp run migrate-dev-db`), and [reusable dev auth](docs/operations/00_development.md#reusable-dev-credential). Agent-specific rules:

- **Worktree setup:** Wait while `.t3/setup-running` names a live PID; do not run `vp i` concurrently. If no `.t3/setup-*` marker exists, run `vp i` yourself.
- **Process lifecycle:** Start dev servers, Metro, and builds from your own shell so they exit with your session—never detach with `systemd-run`, `nohup`, `setsid`, or `tmux` unless asked. Stop background tasks with your harness's own stop (`vp` does not forward SIGTERM to child Vite/server processes).
- **Sharing (`vp run dev --share`):** Wait for `pairingUrl:` and hand the full URL to the user. Never wire `tailscale serve` by hand, open the URL yourself, or consume the user's one-time pairing link. Mint another with `node apps/server/src/bin.ts pair` if needed.
- **Test data:** Always copy in (never symlink) and refresh `statev2.sqlite`, not `state.sqlite`. Bring `secrets` / `settings.json` only if the flow under test needs them.
- **Extra checkouts:** Put `git worktree add` next to this worktree, not in `/tmp`, and remove it when done.

## Verifying

- On Nicholas's Mac, build from the primary checkout after fast-forwarding `main` to the merged PR. Run `pnpm run dist:desktop:local --arch arm64` there. This loads the persistent macOS certificate from fnox's `local` profile and signs the packaged app; never fall back to an unsigned/ad-hoc build or regenerate the certificate when credentials are unavailable. Ensure `/Applications/T3 Code (Beta).app` is a symlink to that checkout's `release/T3 Code (Beta).app` and verify the signature through the link. See [local macOS signing](docs/operations/00_development.md#local-macos-signing).
- Keep that the only registered copy of the desktop app. Every build of a version shares the app ID `com.t3tools.t3code`, so macOS can launch a stale copy and a shipped fix silently goes missing. Builds without `--local-signed` leave one in `release/mac-arm64/`. After building, list copies with `lsregister -dump | grep 'path:.*T3 Code'` (`lsregister` lives in `/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/`). Unregister any other copy that isn't running with `lsregister -u <path>`, then move it to the Trash. To load a new build, ask Nicholas before quitting T3, since that ends every session. Then run `open "/Applications/T3 Code (Beta).app"` and use `ps` to confirm the running app is `release/T3 Code (Beta).app`.
- Private Android APKs intended for installation must use the existing private signing key in `fnox.toml`'s `local` profile. From the repository root, run `fnox exec --profile local --no-defaults -- bash scripts/sign-android-apk.sh <input.apk> <signed.apk>` with `APKSIGNER` pointing to the Android SDK's `apksigner`. Never distribute a debug-signed APK, generate a replacement key, or fall back to another key when credentials are unavailable; updates must preserve the signing identity. This does not change official/EAS signing. See [Private fork APK signing](docs/operations/android-notifications.md#private-fork-apk-signing).
- When changes also affect the remote server or SSH launch behavior, deploy this checkout's Linux runtime to `nicholas-dev` after the final commit, following the [remote deployment checks](#remote-deployment-checks). The deploy briefly restarts the server that Nicholas's phone and desktop use. Frontend-only changes do not need a deploy.
- Before you push, run `vp run check:changed`. **Do not run repo-wide checks** (`vp check`, `vp run -r test`, `vp run -r typecheck`) unless asked—CI owns the full suite.
- Iterate with `vp test run <files>` (add `-t "<name>"` for large files) and `vp run typecheck` (`effect-tsgo tsrs --noEmit`). Run `node -e` snippets from the owning package (`effect` does not resolve from repo root).
- Follow [15_testing.md](docs/internals/15_testing.md) for what to test, bug-fix proof, draining async work (no sleeps/polling), web browser tests (`await using screen = await render(...)`), and real-app [Scenarios](docs/internals/15_testing.md#scenarios) (`vp run scenarios:prove`).
- Give user-visible frontend changes one integrated pass in a real client: `test-t3-app` for web, `test-t3-mobile` for mobile (primary agent only; subagents do not launch dev servers). Inspect the rendered result and walk the flow as a user using the feature—checking layout, visual hierarchy, and ergonomics—and fix anything rough until you are satisfied before handing back. Use the free `Replay (dev)` provider unless the change depends on a real provider (then pick its cheapest model, e.g. Haiku or Luna). On mobile, run `vp run mobile:install <ios|android> [device-id]` before Metro rather than rebuilding from scratch.

## Evals

`evals/` checks how real models behave with T3 Code's model-facing text: agent instructions, MCP tool descriptions and schemas, and generated titles. Before changing that text, read [evals/README.md](evals/README.md) and run the evals it names. When fixing a model behavior bug, add a case that fails before the fix.

### Remote deployment checks

`nicholas-dev` (user `ubuntu`, T3 home `~/.t3`) runs T3 as the `t3code.service` systemd user unit that `t3 up` installed, on `127.0.0.1:3773`. Tailscale Serve publishes it on HTTPS port 8443; Coolify owns 443. `scripts/deploy-ssh-runtime.sh` does not fit this server: it only switches a launcher marked `managed`. The service launcher starts the server named by `activeVersion` in `~/.t3/runtime/service-state.json`, so editing the unit's `ExecStart` alone keeps the old server running.

1. **Record the existing connection before restarting.** On the remote host, inspect `tailscale serve status`, `~/.t3/userdata/server-runtime.json`, and the service's status. Confirm the live listener with `ss -H -ltnp` and fetch its `/.well-known/t3/environment` descriptor. Record the environment ID and existing tailnet HTTPS origin; preserve the T3 home and public HTTPS port rather than assuming a backend port or choosing a new phone URL.
2. **Make existing Tailscale publication persistent.** Confirm `tailscale-serve.json` in the running server's state directory remembers that HTTPS port. If missing or incorrect, use the installed runtime's `pair --base-dir "$HOME/.t3" --tailscale --tailscale-serve-port <existing-https-port> >/dev/null` on the remote host. This attaches to the running server and remembers the forwarding rule for subsequent restarts; verify the settings file afterward. Suppress pairing output because it contains credentials. A bare `tailscale serve --bg` repair alone does not tell T3 Code to restore the mapping.
3. **Check for running agent turns.** OpenCode runs agents on this server from `~/.opencode/bin`, which a non-login `ssh` shell does not see. Run `t3 thread list --base-dir ~/.t3 --project <dir> --json` for each project under `~/Documents/Projects`, and ask Nicholas before restarting while any thread is `running`.
4. **Stage the new runtime.** Build the Linux archive with the build steps in `scripts/deploy-ssh-runtime.sh`, reusing `resource-monitor` from the running runtime. The archive's `libatomic` step needs `ldd`, `dpkg-query`, and `patchelf`; on macOS, run that step in an `ubuntu:24.04` container. Extract the archive to `~/.t3/runtime/versions/.fork-<sha>-XXXXXX` and write its version to `.install-complete`. Move an existing directory for that version to `<version>.upstream`, then symlink the version name to the new directory.
5. **Switch the service.** Run `~/.t3/runtime/versions/<version>/t3 service install --base-dir ~/.t3`. It records `activeVersion`, rewrites the unit, and restarts. Roll back with the previous version's `t3 service install --allow-downgrade`. Never start a second `t3 serve` or `npx t3`, including to repair pairing: automatic port fallback can publish a temporary server on a different port. Keep dev-server publication on a separate HTTPS port, and never reset all Tailscale Serve configuration or overwrite another environment's live handler.
6. **Verify both paths after deployment or rollback.** Fetch `/.well-known/t3/environment` through loopback and the original tailnet HTTPS origin using bounded-time HTTP requests, without opening a browser or consuming a pairing link. Require HTTP 200, the same environment ID recorded before deployment, and the new `serverVersion`. If HTTPS returns 502 or targets a dead port, repair this environment's publication with the persistent pairing command above and recheck.

## Pull requests

- To ship a fork change, open a PR against `NicholasZolton/t3code`'s `main` and merge it once the required checks pass. Honor requests to keep work local or leave a PR open. Never open upstream PRs.
- After the merge, run `git pull --ff-only origin main` on `main` in the primary checkout (`/Users/nicholas/Documents/Projects/t3code`). Build the signed desktop app from that checkout and verify its `/Applications` symlink as described under [Verifying](#verifying).
- `origin` is not always GitHub. Check `git remote get-url origin` before your first forge command and use that forge's CLI and skill. See [Forge mirror](docs/operations/00_development.md#forge-mirror-optional).
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- UI changes need before/after images; motion or timing needs a short video. Upload PR evidence to GitHub—never commit PR-only screenshots or assets.
- One request is one PR. Split only when asked. Outside contributions follow [CONTRIBUTING.md](CONTRIBUTING.md#one-problem).
- When babysitting: call `watch_pull_request` and end your turn. Do not poll or sleep. Verify each bot finding against the source, fix real ones, dismiss false positives with a written reason. Stay quiet when nothing is new; stop when bots are green on the latest commit.

## Documentation

Most code changes do not need an internal documentation change. Agents can read the code.

- `docs/internals/` is for architectural decisions and their reasons, constraints that span components, and implementation traps that are hard to discover from the source. Before adding a paragraph, ask what a maintainer would get wrong without it. If reading the relevant code answers the question, leave it out.
- Do not document every feature, enumerate fields, methods, constants, timeouts, or migration numbers, narrate control flow, maintain file catalogs, or append PR summaries. Anything that can drift will drift; types, tests, and code already record the implementation. The glossary defines shared vocabulary; it is not a feature index.
- A local reason the code can't show goes in a short nearby code comment. Use an internal doc when the reasoning crosses boundaries or needs context the code cannot carry well. Link to the relevant source instead of copying it.
- When a documented decision or constraint changes, rewrite or remove the affected text. Do not append another account of the new behavior. A new internal page needs a distinct, durable reason to exist.
- `docs/user/` helps users accomplish tasks in the shipped product's voice, without implementation details or contributor tooling. Focus on what a feature does, how to start, and anything unintuitive—not descriptions of buttons, layouts, or UI tweaks.
- `docs/operations/` holds maintainer setup, release, and debugging runbooks. Keep end-user server instructions in `docs/user/`.

## Fork knowledge wiki

- Start at `wiki/index.md`. Maintain this repository-local knowledge bundle in [OKF v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md); follow `wiki/maintenance.md` when editing it.
- Update affected concepts in the same change when durable fork decisions, compatibility exceptions, or upstream integration status change. Keep provenance and verification timestamps accurate, and add a concise entry to `wiki/log.md`.
- For upstream syncs, record exact fork and upstream commits, what reached fork `main`, and any remaining gap. Distinguish unmerged candidates from completed integrations; refresh the record after the integration actually reaches `main`.
- Keep the wiki focused on reusable maintainer knowledge. Link to source, commits, and PRs instead of duplicating implementation details or task checklists.

## Plans and work artifacts

- Do not commit implementation plans, research notes, or agent scratch files (keep temporary material outside the worktree).
- Track active maintainer work in its GitHub issue or project item; external proposals belong in Ideas discussions. A merged PR is the implementation record.

## Where code lives

- `apps/server` - WebSocket, event-sourced orchestration (`Orchestrator` → `EventSink` → `EffectWorker`), providers, checkpointing. Read [02_effect-services.md](docs/internals/02_effect-services.md) and `.repos/effect/LLMS.md`.
- `apps/web` - React/Vite UI. `apps/desktop` wraps it; `apps/mobile` is React Native; `apps/marketing` is the site.
- `packages/contracts` - Effect/Schema wire contracts plus small derived helpers. No heavy runtime logic.
- `packages/shared` - shared runtime utils, subpath exports, no barrel.
- `packages/client-runtime` - client connection and domain state shared by web and mobile.
- `.repos/` - vendored read-only references. Never edit or import from them (`vpr sync:repos` updates them; if sparse-checked-out, read via `git show origin/main:.repos/<path>`).

### Internal docs by area

Read the matching doc before changing code in that area; code review enforces them.

| Area                                       | Read first                                                                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture & orchestration               | [00_glossary.md](docs/internals/00_glossary.md), [01_architecture.md](docs/internals/01_architecture.md)                                                                                          |
| Server Effect services & errors            | [02_effect-services.md](docs/internals/02_effect-services.md)                                                                                                                                     |
| Providers & ACP                            | [03_providers.md](docs/internals/03_providers.md)                                                                                                                                                 |
| Auth, MCP, guest links, assets, security   | [04_environment-auth.md](docs/internals/04_environment-auth.md), [SECURITY.md](SECURITY.md)                                                                                                       |
| Remote routes, peer links, previews        | [05_remote.md](docs/internals/05_remote.md)                                                                                                                                                       |
| T3 Connect & relay                         | [06_t3-connect.md](docs/internals/06_t3-connect.md)                                                                                                                                               |
| Server updates & crash recovery            | [07_server-updates.md](docs/internals/07_server-updates.md)                                                                                                                                       |
| Telemetry & analytics                      | [08_product-analytics.md](docs/internals/08_product-analytics.md)                                                                                                                                 |
| Client connection & sync runtime           | [09_connection-runtime.md](docs/internals/09_connection-runtime.md)                                                                                                                               |
| Web UI primitives, styles & React Compiler | [10_web-ui.md](docs/internals/10_web-ui.md)                                                                                                                                                       |
| Mobile layout, navigation & dev lifecycle  | [11_mobile-layout.md](docs/internals/11_mobile-layout.md), [12_mobile-navigation.md](docs/internals/12_mobile-navigation.md), [13_mobile-development.md](docs/internals/13_mobile-development.md) |
| Translations & UI copy                     | [14_i18n.md](docs/internals/14_i18n.md)                                                                                                                                                           |
| Writing & reviewing tests                  | [15_testing.md](docs/internals/15_testing.md)                                                                                                                                                     |
| Wire budgets, server metrics & perf        | [16_performance-regressions.md](docs/internals/16_performance-regressions.md)                                                                                                                     |
| Repo & package scripts                     | [17_scripts.md](docs/internals/17_scripts.md)                                                                                                                                                     |

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Client mutations use `createEnvironmentRpcCommand`, declare protected methods in `CLIENT_GUARDED_RPC_SCOPES`, and gate UI with `permissionAtom` (server stays authoritative). Keep raw RPC clients inside `rpc/`.
- Server features are Effect services using `Effect.fn("Service.operation")` with thin transport handlers; see [02_effect-services.md](docs/internals/02_effect-services.md).
- `apps/web/src/components/ui` exports own their look (`shadcn/no-restyle` enforces this); see [10_web-ui.md](docs/internals/10_web-ui.md).
- Inferred types over annotations. `any` is the enemy.
- Default to no comment. Write one only for a constraint, external quirk, or invariant the code can't show (1–4 lines max; `t3code/no-low-value-comments` enforces this).
- React effects are only for synchronizing with external systems. Derive in render and act in handlers; any remaining effect states its reason via `// oxlint-disable-next-line t3code/no-unreasoned-state-sync -- <why>`.
- No continuously repainting animations; they peg the GPU on high-refresh displays.
- Security matters, but do not over-index on dev-mode or maintainer-only features. Read [SECURITY.md](SECURITY.md) before auditing or triaging reports.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.
