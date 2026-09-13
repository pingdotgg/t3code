# fixtures/monorepo-workspace

Exercises the **externalWorkspaces / input-hash memo machinery** with an app
that imports code across a package boundary.

## Layout

```
fixtures/monorepo-workspace/   ← fixture root (bun workspace member; harness cwd)
  e2e.config.ts                ← built-in Vite framework path, `root: "./app"`
  app/                         ← the Vite project root (SSR worker, no client assets)
    src/server.ts              ← imports ../../lib/src/greeting.ts
  lib/                         ← sibling directory with its own package.json + src
    package.json               ← makes lib/ a "workspace root" for the collector
    src/greeting.ts
```

Deliberate choices:

- **Vite framework path, not a framework package.** `e2e.config.ts` uses the
  harness's built-in Vite implementation with the first-class `root` option
  (`Options.root`, resolved against the fixture root and threaded by the
  Cli/Server into `Framework.build`/`Framework.dev`). This isolates the
  workspace machinery from framework churn.
- **Relative import, no bun workspace-protocol tricks.** `lib/` is NOT a bun
  workspace member (the root glob is `fixtures/*`, one level up). The app
  reaches it via `../../lib/src/greeting.ts`; framework-core's collector
  detects cross-boundary module ids **by path** (absolute id outside the
  project root, not under `node_modules`) and resolves each to its nearest
  `package.json` directory (`collectExternalWorkspaces`).
- **The client environment's default entry is `index.html`.** A
  worker-rendered app has none; `app/vite.config.ts` points the client build
  at `src/client.ts`. (User-config-respecting behavior working as intended —
  noted because a client-less SSR app cannot express "skip the client
  environment" through `e2e.config.ts` alone.)

## What the specs assert

- `live` + `dev`: the app builds/serves and its SSR HTML + `/api/greeting`
  JSON carry content imported from `lib/`.
- `live`: `dist/build.json`'s `externalWorkspaces` contains the absolute path
  of `lib/` — and does NOT contain `app/` or the fixture root.

The suite runs ungated (`bun run test` → `playwright test`). The two harness
gaps the original scaffold worked around are fixed upstream:

1. `writeBuildOutput` now `mkdir -p`s its target's parent, so the nested-root
   build (Vite writes to `app/dist` while the harness persists
   `<fixtureRoot>/dist/build.json`) no longer hits ENOENT.
2. `Options.root` is a first-class harness option threaded into
   `FrameworkBuildOptions.root` / `FrameworkDevOptions.root` — the fixture no
   longer wraps `makeViteFramework` in its own Framework layer.

## Out of scope here: memo-busting assertions

The aspirational spec — _editing `lib/src` busts the rebuild memo while an
untouched rebuild stays memoized_ — is intentionally **skipped** in
`test/smoke.test.ts`: the e2e harness has no build memoization by design
(`e2e build` rebuilds unconditionally). The memo that consumes
`externalWorkspaces` lives in alchemy's `Website`/`Command.Memo` machinery
(`memo.workspaces: "auto"` hashes the workspace directories recorded in the
build output), and the memo-bust behavior is asserted by an alchemy-side
`Website` memo test (see `alchemy-effect/packages/alchemy/test/Cloudflare/Website/`).
This fixture pins the prerequisite: the collector must report `lib/` so the
memo layer has the right inputs.
