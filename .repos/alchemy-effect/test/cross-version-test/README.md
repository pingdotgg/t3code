# cross-version-test

Deploys a tiny app — a Cloudflare **state store** + one **Worker** — across a
range of alchemy versions, **upgrading the same app in place**, to catch
regressions in the version-to-version upgrade path.

`run.ts` runs two tests **back to back** (sequentially — they share one
account-wide state store and one fixed worker name, so they can never overlap):

1. **`upgrade` — sequential 1-by-1 upgrade.** Deploy the oldest version, then
   upgrade the same app through every version in order
   (v4 → v5 → v6 → v7 → current), walking the state store up one version at a
   time.
2. **`jump` — direct-to-latest.** For each older example, deploy it and then
   upgrade the same app **directly to latest** (the current branch), skipping
   the intermediate versions — a big-jump upgrade (e.g. state store v4 → v7 in
   one step).

Both assert, after every deploy, that the live worker serves the `marker` baked
into the version just deployed — proving the running code was actually replaced
in place. Each also exercises the **state-store upgrade** path: alchemy's
Cloudflare state store is an account-wide, version-stamped singleton that
`alchemy cloudflare bootstrap` migrates between versions.

**Fresh state store per scenario.** Each scenario ("unit" — the whole `upgrade`
chain is one unit; each `jump` is its own unit) owns a brand-new state store:
the runner tears the store (worker + secrets) down before and after every unit.
So the `upgrade` chain runs on its own store, that store is destroyed, then each
`jump` deploys a fresh store. Pass `--reuse-store` to skip the teardowns and
share one store across units (faster, less isolated).

## Layout

```
cross-version-test/
  run.ts                 # orchestrator — runs the stages in order
  test/
    01-beta.39/          # alchemy@2.0.0-beta.39  (last npm release with state store v4)
    02-beta.44/          # alchemy@2.0.0-beta.44  (last npm release with state store v5)
    03-beta.45/          # alchemy@2.0.0-beta.45  (last npm release with state store v6)
    04-beta.59/          # alchemy@2.0.0-beta.59  (latest v2 on npm, state store v7)
    05-current/          # current branch (workspace source, state store v7)
```

Each stage folder is a standalone alchemy app: `alchemy.run.ts` (identical
across stages) + `src/worker.ts` (differs only by a `marker` and, for older
versions, `main: import.meta.filename` vs HEAD's `import.meta.url`) +
`test/integ.test.ts` (an example-style integration test).

- **npm stages** (`01`, `02`) pin an exact `alchemy` version **and a matching
  `effect` version** in `package.json`, and get their own isolated
  `node_modules` via `bun install`. The `effect` pin matters: alchemy floats on
  the `effect` 4.0 beta line, so an old alchemy paired with a too-new `effect`
  crashes (e.g. beta.45 breaks on `effect` ≥ beta.84 via a `SchemaAST` change).
  Each stage therefore pins the `effect` version contemporaneous with its
  alchemy — its peer-dependency floor (beta.39 & beta.44 → `effect@4.0.0-beta.66`;
  beta.45 → `beta.74`; beta.59 → `beta.84`).
- **workspace stage** (`05-current`) has no dependencies — it resolves
  `alchemy`/`effect` from the monorepo (repo-root `node_modules`) so it runs the
  **current branch source**.

All stages share one identity — `Stack("CrossVersionApp")`, a fixed worker
`name`, the same account — which is what makes each deploy an in-place upgrade
rather than a new app. (TEST 2 uses the stage `<stage>-jump` to keep its state
separate from TEST 1's.)

## Running

```sh
# from the repo root — runs BOTH tests back to back
bun run test/cross-version-test/run.ts --profile <cloudflare-profile>
# or
ALCHEMY_PROFILE=<cloudflare-profile> bun run test/cross-version-test/run.ts
# run just one test
bun run test/cross-version-test/run.ts --profile <p> --test upgrade
bun run test/cross-version-test/run.ts --profile <p> --test jump
```

### Flags

| Flag             | Default            | Meaning                                                       |
| ---------------- | ------------------ | ------------------------------------------------------------- |
| `--profile <p>`  | `$ALCHEMY_PROFILE` | Cloudflare auth profile (`~/.alchemy/profiles.json`). Required. |
| `--test <names>` | `upgrade,jump`     | Comma-separated tests to run: `upgrade`, `jump`.            |
| `--stage <s>`    | `xver`             | Base alchemy stage name (TEST 2 uses `<stage>-jump`).       |
| `--only <dirs>`  | all                | Comma-separated stage dirs (e.g. `01-beta.39,02-beta.44`).  |
| `--no-install`   | off                | Skip `bun install` in npm stages (reuse existing installs). |
| `--keep`         | off                | Leave the final app + state store deployed (skip the last unit's teardown). |
| `--reuse-store`  | off                | Reuse one state store across units (faster, less isolated) instead of a fresh one per unit. |

## Per-version integration tests

Each stage folder also has a standalone `test/integ.test.ts` (mirrors
`examples/*/test/integ.test.ts`): it deploys the stack in `beforeAll`, makes an
HTTP request to the worker and asserts the live `marker`, and destroys in
`afterAll`. Run one from its folder:

```sh
cd test/cross-version-test/test/05-current
ALCHEMY_PROFILE=<profile> bun test          # bun test buffers — no live output until it finishes
```

These run on a dedicated stage (`integ`) so they don't touch the orchestrator's
`xver` state. They deploy through the **account-wide state store**, so it must
already be at the version matching that folder's alchemy (**v4** beta.39, **v5**
beta.44, **v6** beta.45, **v7** beta.59/current). Either run `run.ts` (which
bootstraps per stage), or bootstrap first:

```sh
cd test/cross-version-test/test/01-beta.39
bun run alc -- cloudflare bootstrap --profile <profile>   # brings the store to v4
bun test
```

## Tearing down the state store

`run.ts` tears the state store down automatically between units (unless
`--reuse-store`), and the last unit's store is removed at the end too (unless
`--keep`). So a normal run leaves the account clean.

To remove the state store manually — the `alchemy-state-store` worker, the
bearer-token + encryption-key secrets, and the now-empty Secrets Store (e.g.
after a `--keep` run or an aborted run):

```sh
cd test/cross-version-test/test/05-current   # uses the current-branch CLI
bun run alc -- cloudflare teardown --profile <profile>
```

`cloudflare teardown` is the inverse of `cloudflare bootstrap` (added alongside
this harness). It's idempotent and only removes resources alchemy created — a
Secrets Store that still holds foreign secrets is left in place.

## ⚠️ Use a dedicated Cloudflare account

The Cloudflare state store is **account-wide** and shared by every stack on the
account/profile. Stage `01` bootstraps state store **v4**, which **downgrades**
the store if the account already had a higher version — that can break other stacks using
the same account. **Point this at a dedicated/throwaway Cloudflare account.**

The runner tears the state store down between units and at the end, so a normal
run leaves the account clean.

## Known-bad upgrade paths

Two upgrade paths are **known broken** and are therefore **not tested**
(commented out of `EDGES` in `run.ts`). Both are deterministic and reproduced
across runs:

| Path | Status | Why |
| --- | --- | --- |
| v4 → v5 | ✅ works | |
| **v5 → v6** | ❌ **known bad** | **v6 (beta.45) can't read pre-v6 state** — `500 GET DecodeError` |
| v6 → v7 | ✅ works | |
| v5/v6/v7 → worktree | ✅ works | |
| **v4 → worktree** | ❌ **known bad** | **a v4 store can't be upgraded to current** — `415` on write |

Details:

- **`v5 → v6` (beta.44 → beta.45):** after the store is upgraded to v6, reading
  a record written under ≤v5 fails with `500 GET … DecodeError`. beta.45's
  legacy-record read (createdAt/updatedAt reshape, PR #427) is broken; **fixed
  in v7** — `v5 → worktree` (skipping beta.45) works. Don't step pre-v6 state
  through beta.45.
- **`v4 → worktree` (beta.39 → current):** the current state-store client can't
  write to a v4-format store — the upgrade fails with `415 Unsupported Media
  Type` on `PUT …/StateStoreEncryptionKey`. v4 (beta.37–39) predates the RPC
  state-store rewrite at v5, so its store HTTP API is wire-incompatible with
  current. Step a v4 store up to ≥v5 first (`v5/v6/v7 → worktree` all work).

Everything else passes. Transient `404/500` while bootstrapping a freshly
(re)deployed state-store worker is expected (the worker isn't serving yet when
bootstrap hoists into it) and is absorbed by the per-step retry.

## Adding versions / scenarios

Add a new `test/NN-<label>/` folder (copy an existing one), pin its `alchemy`
version in `package.json`, set the `marker` + `main` form appropriately in
`src/worker.ts`, then add an entry to the `STAGES` array in `run.ts`. Keep
`Stack("CrossVersionApp")` and the worker `name` identical so it upgrades the
same app.

### Version → state-store-version reference

| alchemy          | state store version | pinned `effect` | notes                              |
| ---------------- | ------------------- | --------------- | ---------------------------------- |
| beta.29 … 30     | 1                   | —               | version-gating introduced (#156)   |
| beta.31 … 32     | 2                   | —               |                                    |
| beta.33 … 36     | 3                   | —               |                                    |
| **beta.37 … 39** | **4**               | beta.66         | last release with v4 = beta.39     |
| **beta.40 … 44** | **5**               | beta.66         | last release with v5 = beta.44     |
| **beta.45**      | **6**               | beta.74         | only release with v6               |
| **beta.46 … 59** | **7**               | beta.84         | bumped to v7 in beta.46 (PR #477); last v7 on npm = beta.59 (= latest) |
| current branch   | 7                   | workspace       |                                    |
