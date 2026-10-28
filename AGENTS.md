# T3 Code

T3 Code is a minimal GUI for coding agents. A Node WebSocket server wraps provider CLIs and agents (Codex, Claude Code, Cursor, Grok, OpenCode, Antigravity) and serves web, desktop, and mobile clients.

You can think of T3 Code as an open source "bring-your-own-subscription" alternative to apps like Claude Desktop, Codex App, Cursor Glass and Conductor.

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
- **Providers.** Codex, Claude, Cursor, Grok, OpenCode, and Antigravity each have an adapter. Provider-shaped features need a decision per adapter, even if the decision is "not supported here".
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

## Test data

An empty database is a bad test. Seed your worktree's `.t3` with a copy of real data instead of pointing at live state:

- The first `vp run dev` in a worktree does this for you when its database is missing and the source is at most 500 MiB. Larger sources warn and dev starts with an empty database. `--no-seed` or `T3CODE_DEV_SEED=0` skips seeding. Manual migration still accepts larger sources and may use substantial disk space before pruning.
- Run `vp run migrate-dev-db` with your dev server stopped to refresh. It rebuilds `<worktree>/.t3/userdata/statev2.sqlite` from a read-only snapshot of `~/.t3/userdata/statev2.sqlite`, the developer's real data. It keeps recent projects and their stopped threads, and drops scheduled tasks, pending work, and auth sessions, so your dev server never runs the developer's agents. Raise `--projects` and `--threads-per-project` for more data.
- Refresh `statev2.sqlite`, not `state.sqlite`. The server copies the V1 `state.sqlite` only when `statev2.sqlite` is missing.
- Bring `secrets` and `settings.json` only if the flow under test needs them.
- Copy in, never symlink. Data flows one way: into your sandbox, never back out.

## Verifying

- Before you push, run `vp run check:changed`. It runs CI's fast checks for changed files: format, lint, knip, typecheck of affected packages and dependents, and tests beside changes. CI still runs the full test suites.
- While you iterate, run `vp test run <files>`. For big files, add `-t "<name>"`.
- Use `vp run typecheck`, not `npx tsc`; it caches per package. Both run tsc-rs (`typescript` is the `@tsc-rs/typescript` drop-in).
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

- `apps/server` - WebSocket, orchestration, providers, checkpointing. Effect-heavy: read [Effect services](docs/internals/effect-services.md) before adding server code, and `.repos/effect-smol/LLMS.md` for the Effect library itself.
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
