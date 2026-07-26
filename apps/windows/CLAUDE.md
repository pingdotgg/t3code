# apps/windows — agent rules

Tauri 2 shell (Rust) + WebView2 renderer (React/TypeScript) for Windows 11.
Read `ARCHITECTURE.md` first, and `HANDOVER.md` if you are picking this up on
the Windows machine.

## Hard rules

- **Never hand-port the wire protocol.** The renderer imports
  `@t3tools/client-runtime` and `@t3tools/contracts`. `apps/mac` has its own
  Swift port (`T3Kit`) for reasons that do not apply here; adding a third
  implementation in Rust or TypeScript is the thing this app exists to avoid.
  Import from an explicit `@t3tools/client-runtime/*` subpath — the package has
  no root export and the lint rule will reject one.
- **Design tokens live in `src/theme/`, not in CSS.** `theme.css` reads
  `var(--…)` that `applyTheme()` publishes from `palette.ts` / `motion.ts` /
  `typography.ts` / `glass.ts`. Hard-coding a color or duration in a component
  or stylesheet silently forks the design system away from `apps/mac`.
- **Do not paint an opaque background anywhere in `html`/`body`/`#root`.** The
  window is transparent so DWM composites Mica behind it. One opaque
  background turns the whole app into a dark rectangle, and nothing else about
  it looks broken — this is the failure mode `GlassLayering` was written to
  prevent on macOS.
- **The layer alphas belong to `glass.ts`.** Photo + wash must composite to
  exactly the chosen translucency. If you need a new translucent surface,
  derive it there and add a test, do not pick an alpha by eye.
- **Keep the Rust crate buildable on non-Windows hosts.** Every `cfg(windows)`
  block needs a `cfg(not(windows))` counterpart that is an explicit no-op, so
  the shared supervisor logic stays testable off a Windows machine. Do not
  reference a plugin's permissions from an unconditional capability file —
  platform-scoped plugins go in `capabilities/windows.json`.

## Build and test

```powershell
vp run --filter @sergecode/windows typecheck
vp run --filter @sergecode/windows test
vp run --filter @sergecode/windows build     # required before any cargo step:
                                             # generate_context! reads dist/
cd apps/windows/src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

`pnpm exec tauri dev` from `apps/windows` runs the whole app. It needs a built
server bundle (`vp run --filter t3 build:bundle`) or `$SERGECODE_SERVER_ENTRY`
pointing at one; dev builds resolve `node` from `PATH`.

## Sidecar invariants (do not regress these)

They are ported from `apps/mac/Sources/SidecarKit` and pinned by tests in
`src-tauri/src/sidecar/process.rs`:

- Readiness is `GET /.well-known/t3/environment`, 100 ms poll, 60 s cap.
- Backoff is 500 ms → 10 s, and resets to 0 once a run reaches ready.
- A readiness **timeout** must terminate the child before restarting. It is
  still alive and holding the port; skipping this leaks a process and makes the
  next launch fail to bind.
- The child is assigned to the Job Object immediately after spawn, before the
  bootstrap write. A crash in between must not be able to orphan it.
- `stop()` resolves only once the child is gone, so app teardown can await it.

## Versioning and releases

`apps/windows/version.json` is the source of truth for the Windows app and is
read by `tauri.conf.json`. It currently tracks `apps/mac/version.json`.

Before changing it, tagging, or running `Release Windows App`, ask the user and
wait for an explicit choice — the same question `apps/mac/CLAUDE.md` requires:

> Should this work create a new app version/release, or should it be added to
> the current rolling/pending version number?

The Windows release workflow is `workflow_dispatch`-only until the signing
secrets exist (see `HANDOVER.md` ▸ Signing and updates). All GitHub operations
target `SergeSerb2/SergeCode`.
