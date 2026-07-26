# Handover — continuing SurgeCode for Windows on a Windows machine

Everything in this repository that can be written and verified without a
Windows machine is done. The `cfg(windows)` Rust paths now compile, lint under
`-D warnings`, and pass their tests on `windows-latest` via
`.github/workflows/ci-windows.yml`. What is left needs a real Windows 11 box:
the app has never been **launched**, and the remaining work is UI that has to
be looked at.

Read `ARCHITECTURE.md` before starting. This file is the operational half.

---

## 1. What is already here, and what is verified

| Area                                                             | State                            | Verified by                                                  |
| ---------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------ |
| Sidecar supervisor (spawn, bootstrap, readiness, backoff, stop)  | Complete                         | 27 `cargo test` cases, run on macOS                          |
| Job Object process ownership (`sidecar/job.rs`)                  | Complete, **never run**          | Compiles + clippy clean on `windows-latest` (CI)             |
| Credential Manager store (`secrets.rs`)                          | Complete, **never run**          | `cargo test` on `windows-latest` (CI)                        |
| DWM backdrop + dark caption (`window.rs`)                        | Complete, **never run**          | Compiles on `windows-latest` (CI); visual result unverified  |
| Node runtime locator                                             | Complete                         | `cargo test` (pure candidate-ordering + engines-range cases) |
| Launch preferences (LAN access, Tailscale, backdrop)             | Complete                         | `cargo test`                                                 |
| Tauri commands + events                                          | Complete, **never invoked**      | Serialization shape tested                                   |
| Design system port (palette, typography, motion, glass layering) | Complete                         | 58 `vp test` cases incl. FNV-1a parity with Swift            |
| Desktop bootstrap-token exchange                                 | Complete                         | `vp test` against a stubbed fetch                            |
| App shell (window layers, toolbar, columns, connection surface)  | Skeleton                         | Typechecks, builds, **never rendered**                       |
| Connection wiring into `@t3tools/client-runtime`                 | **Not started** — see §5         | —                                                            |
| Sidebar / chat / composer / diffs / settings                     | **Not started** — see §6         | —                                                            |
| Installer, signing, auto-update feed                             | Workflow written, secrets absent | —                                                            |

CI proves those three compile and their tests pass; it cannot prove they
_behave_. No Job Object has ever actually reaped a process tree, no credential
has been written to Credential Manager, and nobody has seen the Mica backdrop.
Confirming that is §3, and it is the first thing to do.

---

## 2. Machine setup

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools `
  --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
winget install Rustlang.Rustup
winget install OpenJS.NodeJS.LTS      # must satisfy ^22.16 || ^23.11 || >=24.10
winget install Git.Git
winget install Microsoft.EdgeWebView2Runtime   # preinstalled on Windows 11; confirm
rustup default stable
corepack enable
```

WebView2 ships with Windows 11, so the runtime install is usually a no-op —
but confirm it, because a missing runtime fails at window creation with an
unhelpful error.

Nothing else is required. There is no Visual Studio IDE dependency; the MSVC
build tools are needed only for the Rust linker.

---

## 3. First run — do this before writing any code

```powershell
git clone https://github.com/SergeSerb2/SergeCode.git
cd SergeCode
git checkout sergecode/windows-app-port     # or main, once this PR has merged
corepack pnpm install

# The Rust half. CI already builds this on windows-latest, so it should be
# green — treat a failure here as a difference in your local toolchain.
cd apps\windows\src-tauri
cargo test
cargo clippy --all-targets -- -D warnings
cd ..\..\..

# The renderer.
corepack pnpm exec vp run --filter @sergecode/windows typecheck
corepack pnpm exec vp run --filter @sergecode/windows test
```

Then launch it against a dev server build:

```powershell
corepack pnpm exec vp run --filter t3 build:bundle
cd apps\windows
corepack pnpm exec tauri dev
```

**What a correct first launch looks like:** a dark, Mica-backed window; the
toolbar shows "Launching Server…", then "Connecting…", then "Connected to
<your PC>"; `%APPDATA%\SergeCode\logs\sidecar\stdout.log` fills with server
output; and closing the window leaves **no** `node.exe` behind in Task Manager.
That last one is the Job Object working — check it explicitly.

If the window is a plain opaque rectangle with no Mica, that is
`apply_window_chrome` failing; it logs to stderr and never blocks launch by
design. If the app sits on "Launching Server…" forever, read the sidecar log
first — it is almost always a Node version outside the engines range or a
missing `apps/server/dist/bin.mjs`.

---

## 4. Prompt for the Windows-side agent

Copy everything between the rules into a fresh session on the Windows machine.

---

> You are continuing a port of a macOS app to Windows inside the SergeCode
> monorepo (`github.com/SergeSerb2/SergeCode`), checked out on this Windows 11
> machine.
>
> **Context.** `apps/mac` is a 54k-line native SwiftUI macOS client for coding
> agents (Codex, Claude Code, Grok, Kimi). It supervises a Node server sidecar
> (`apps/server`) and speaks its effect-RPC-over-WebSocket protocol.
> `apps/windows` is the Windows port: a Tauri 2 shell in Rust around a WebView2
> renderer in React/TypeScript. The goal is parity with the macOS app, as close
> to one-to-one as the platforms allow.
>
> **Read first, in this order:** `apps/windows/ARCHITECTURE.md`,
> `apps/windows/CLAUDE.md`, `apps/windows/HANDOVER.md`, then
> `apps/mac/ARCHITECTURE.md` for the behaviour you are matching. `AGENTS.md` at
> the repository root has rules that override everything else — in particular,
> this is a permanent hard fork and no GitHub operation may ever target
> `pingdotgg/t3code`; always pass `--repo SergeSerb2/SergeCode`.
>
> **The foundation is built and tested; do not rewrite it.** The sidecar
> supervisor, the design-system port, the Tauri IPC surface, and the
> bootstrap-token exchange all exist with tests. Your job is, in order:
>
> 1. Verify the `cfg(windows)` paths actually _behave_. They compile and pass
>    tests on `windows-latest` in CI, but nothing has observed them working:
>    confirm the Job Object really reaps the sidecar tree, that a credential
>    round-trips through Credential Manager, and that the Mica backdrop renders.
> 2. Launch the app (`pnpm exec tauri dev` in `apps/windows`) and confirm the
>    startup sequence in HANDOVER.md §3, including that no `node.exe` survives
>    closing the window.
> 3. Wire the renderer to `@t3tools/client-runtime` following HANDOVER.md §5.
>    Mirror `apps/mobile/src/connection/{platform,runtime,storage}.ts` — it is
>    the same package with the same layers — but the local sidecar is a
>    **bearer** connection, not a primary one, and there is no Clerk, relay, or
>    DPoP.
> 4. Port the UI in the order given in HANDOVER.md §6, checking each screen
>    against the macOS source file named there.
>
> **Rules that matter more than they look:**
>
> - Never hand-port the wire protocol. Import it from
>   `@t3tools/client-runtime/*` subpaths.
> - Never hard-code a color, duration, radius, or alpha in a component or
>   stylesheet. They come from `src/theme/` via CSS custom properties.
> - Never give `html`, `body`, or `#root` an opaque background — it silently
>   kills the Mica backdrop.
> - Keep `apps/windows/src-tauri` compiling on non-Windows hosts (every
>   `cfg(windows)` block needs a `cfg(not(windows))` no-op) so CI and the macOS
>   machine can still check the shared logic.
> - `vp check` and `vp run typecheck` must pass before you consider anything
>   done.
>
> Work in reviewable, PR-sized commits with conventional messages. Ask before
> touching `apps/windows/version.json` or running any release workflow.

---

## 5. Wiring the connection (the next real task)

`src/connection/desktopBootstrap.ts` already turns a sidecar endpoint into
`{ environmentId, label, httpBaseUrl, wsBaseUrl, bearerToken }`, and
`src/app/useSidecar.ts` calls it on every `ready`. What is missing is feeding
that into `@t3tools/client-runtime`.

The template is `apps/mobile/src/connection/`, which wires the same package.
Copy its structure, and cut what does not apply:

| Mobile layer               | Windows equivalent                                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PlatformConnectionSource` | Emits `[BearerConnectionRegistration]` built from `useSidecar`'s session. This is the whole point of the file — mobile leaves it `Stream.empty`.                                                                        |
| `connectionStorageLayer`   | Same shape, backed by `localStorage` instead of `expo-secure-store`. The shared helpers in `@t3tools/client-runtime/platform` (`ConnectionCatalogDocument`, `registerConnectionInCatalog`) do most of it.               |
| `EnvironmentCacheStore`    | A no-op is correct here, not a shortcut: the server is on loopback, so there is no offline window to cache for. `apps/mac` has no snapshot cache either — T3Kit re-subscribes from a fresh snapshot on every reconnect. |
| `Connectivity` / `Wakeups` | `navigator.onLine` + `online`/`offline` events; wakeups from `visibilitychange` and window `focus`.                                                                                                                     |
| `CloudSession` (Clerk)     | Drop. Cloud auth is permanently out for this fork.                                                                                                                                                                      |
| `RelayDeviceIdentity`      | Drop with the relay.                                                                                                                                                                                                    |
| `ClientPresentation`       | Keep; label the client "SurgeCode for Windows" (`CLIENT_LABEL` in `desktopBootstrap.ts`).                                                                                                                               |
| `runtimeContextLayer`      | Needs `Socket.layerWebSocketConstructorGlobal` and an HTTP client layer over the webview `fetch`. No DPoP signer, no relay client.                                                                                      |

Then `Atom.runtime(connectionLayer)` exactly as `apps/mobile/src/connection/runtime.ts`
does, and the `@t3tools/client-runtime/state/*` atoms light up.

---

## 6. UI port order

Port against the named macOS file; it is the specification. Sizes are the Swift
line counts, as a rough weighting.

**Phase 1 — the shell you can see immediately**

1. `UI/Shell/SidebarView.swift` (1567) — projects, thread rows, status
   grouping, archived section, search. `UI/Shell/SidebarPresentation.swift` and
   `ThreadInboxSemantics.swift` are pure logic and should be ported as tested
   TypeScript first.
2. `UI/Shell/ThreadDetailView.swift` + `Chat/ChatHeaderView.swift` — the
   identity header pinned to `contentHeaderHeight` (61px, already a token).
3. `UI/Shell/EmptyStateView.swift` — replaces the placeholder
   `ConnectionSurface`.
4. `UI/Shell/ConnectionStatusPill.swift` — already ported; re-check against the
   real phase set once the connection is live.

**Phase 2 — the conversation, which is most of the app**

5. `Chat/ChatTimelineScrollView.swift` + `ChatTimelineRow.swift` — virtualize
   this from the start. The macOS app went through a whole perf overhaul here
   (stale-timeline eviction, streaming markdown sessions); a naive list will not
   hold up on a long thread.
6. `Chat/StreamingMarkdown.swift`, `MarkdownContent.swift`,
   `StreamingReveal.swift` — streaming markdown. Assistant deltas arrive per
   chunk and are batched to ~30 Hz upstream; keep that batching.
7. `Chat/CodeHighlighter.swift` — macOS vendors HighlightSwift/highlight.js.
   The renderer should use Shiki, which `apps/mobile` already depends on.
8. `Chat/{ApprovalCard,UserInputCard,PlanCard,CommandTaskCard,DelegatedTaskCard,UsageLimitCard}.swift`
   — the timeline card set.
9. `Chat/ThinkingIndicator.swift`, `ToolActivityStyle.swift`,
   `PlanProgressStrip.swift`.

**Phase 3 — input and review**

10. `Composer/ComposerBar.swift` (1554) — @-file-mentions, slash commands,
    image attachments, model picker, runtime-mode picker, context meter.
11. `Diff/{DiffReviewView,DiffPresentation,IntralineDiff,ChangesTimelineView}.swift`
    — the inspector column. `@pierre/diffs` is already a workspace dependency.
12. `UI/Shell/VcsToolbar.swift` + `MergeReadiness.swift` — branch switch,
    pull, commit/push/PR, outcome banner.

**Phase 4 — the rest**

13. `UI/Settings/*` — settings scene, scenery tab, auto-review tab.
14. `Theme/Scenery*.swift` — the 24-location Unsplash pool, per-thread photo
    pinning, palette extraction. The Unsplash key is **not** in the repo; it
    comes from the environment (`EXPO_PUBLIC_*` on mobile). Cached photos go
    under `%APPDATA%\SergeCode\scenery\` and are served through Tauri's asset
    protocol, which `tauri.conf.json` already scopes to that directory.
15. `Support/AgentNotification*.swift` — Windows toast notifications.
16. Auto-update UI, iPhone pairing QR (`Support/QRCodeRenderer.swift`).

**Deferred:** dictation (`Dictation/*`). macOS uses FluidAudio's Parakeet TDT
v3 CoreML model, which has no Windows equivalent; a port needs whisper.cpp or
ONNX Runtime and is a project of its own.

---

## 7. Signing and updates

`createUpdaterArtifacts` is off and `plugins.updater.pubkey` is empty, so
`tauri build` works today and ships an installer with no update feed. To turn
updates on:

```powershell
cd apps\windows
corepack pnpm exec tauri signer generate -w %USERPROFILE%\.tauri\sergecode.key
```

Give it a **non-empty passphrase** when it prompts. The workflow requires one:
an unset repository secret and one set to the empty string are
indistinguishable in Actions, so "no passphrase" cannot be told apart from
"misconfigured", and an unencrypted minisign key sitting in a repository
secret is the worse of the two failure modes.

Then:

1. Put the **public** key in `tauri.conf.json` ▸ `plugins.updater.pubkey`.
2. Add repository secrets `TAURI_SIGNING_PRIVATE_KEY` and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Both, or neither — see below.
   That is the whole setup. The manifest is generated for you — see below.

Leave `bundle.createUpdaterArtifacts` at `false` in `tauri.conf.json`. The
release workflow turns it on with a `--config` override when it sees the
signing secrets, and keys the uploaded artifact list off the same decision, so
the two can never disagree.

### Where the update feed lives

Tauri's updater reads a manifest, not the release listing: it needs the
installer's URL and the _contents_ of the `.sig` beside it. `tauri build` emits
neither, so the workflow writes `apps/windows/updater/latest.json` after the
build, uploads it as a release asset, and — for a **published** release —
commits it to `main`.

The feed URL is that committed path on `main`, not the release asset:

```
https://raw.githubusercontent.com/SergeSerb2/SergeCode/main/apps/windows/updater/latest.json
```

A release asset cannot be the feed, because it has no stable URL.
`releases/latest/download/…` looks like one but is repository-wide: the next
**macOS** release would make it resolve to a release carrying no `latest.json`
at all, and every Windows client would start 404ing. Committing the manifest
mirrors how `release-mac.yml` commits the Sparkle appcast, for the same reason.

The endpoint 404s until the first signed, published release. That is fine —
the updater treats an unreachable feed as "no update available", and the
plugin is inert until `pubkey` is filled in anyway.

Every half-configured combination fails in the `Resolve updater signing` step
with a message pointing back here, rather than deep inside `tauri build`:

| State                          | Without the guard                                       |
| ------------------------------ | ------------------------------------------------------- |
| key, no passphrase             | `tauri build` waits on a prompt no runner can answer    |
| passphrase, no key             | silently ships an unsigned installer                    |
| both, but `pubkey` still empty | Tauri refuses to emit updater artifacts, late and vague |

Authenticode is separate and worth doing — without it SmartScreen warns on
every install. It needs an OV/EV certificate and `bundle.windows.certificateThumbprint`.

### Running the release

`Release Windows App` is `workflow_dispatch`-only, and it has three guards
worth knowing before you reach for it:

- **It builds the ref you dispatch it from**, and then refuses anything but
  `main`. Merge the release commit first. It does not silently fall back to
  `main` when you pick another branch — that would have made a hotfix build
  the wrong code.
- **The `version` input must equal `apps/windows/version.json` exactly.**
- **`draft` defaults to true**, and this is the switch that decides whether
  anyone receives the update. A draft's assets are not downloadable, so the
  workflow deliberately does not commit the updater manifest for one — that
  would hand every client a dead URL. Drafting is the safe default while the
  installer is still being checked by hand; uncheck `draft` when you actually
  intend to update users.

Ask the user before running it at all, and before touching
`apps/windows/version.json`.

---

## 8. Traps already paid for

- **`tauri-winres` needs `llvm-rc`** and **`tauri-plugin-updater` pulls `ring`**,
  which needs Windows SDK headers. Together they make `cargo check --target
x86_64-pc-windows-msvc` impossible from macOS. That is why `ci-windows.yml`
  exists.
- **A `cfg(windows)` block can only fail on Windows, and it will.** The first
  CI run on this code failed on exactly one line: an unused
  `std::os::windows::process::CommandExt` import, because
  `tokio::process::Command` exposes `creation_flags` as an inherent method
  while `std`'s needs the trait. Under `-D warnings` that is a build failure,
  and no amount of macOS testing can see it. Expect this class of thing when
  you add Windows-only code, and let CI be the check rather than reasoning
  about it.
- **A missing bundle resource fails the build**, so
  `dist-sidecar/SergeCode{Node,Server}/.gitkeep` are tracked on purpose. Do not
  "clean up" the empty directories.
- **`erasableSyntaxOnly` is on** repository-wide: TypeScript parameter
  properties (`constructor(readonly x: T)`) do not compile. Declare the field.
- **`vite/client` types do not resolve** — the workspace aliases `vite` to
  `@voidzero-dev/vite-plus-core`. Use `vite-plus/client`.
- **`std::env::split_paths` uses the host separator**, so a test with a
  `C:\...` path in a `PATH` string splits on the drive colon when run on macOS.
  Build test `PATH`s with `std::env::join_paths`.
- **The scenery seed hash must match Swift bit-for-bit.** `stableIndex` is
  64-bit FNV-1a with wrapping multiply; a `Number`-based port overflows on the
  first byte. `palette.ts` uses `BigInt` masked to 64 bits, with parity tests.
