# Repo-level worktree housekeeping — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a repo-scoped "Clean up worktrees" action that lists t3code-managed worktrees with their on-disk size and dirty status, lets the user select and force-remove them, and shows the total reclaimable space upfront.

**Architecture:** The server enumerates managed worktrees (`git worktree list --porcelain` filtered to paths under `worktreesDir`), computes per-worktree dirty status (git) and size (recursive filesystem walk), and batch-removes selected paths. The client classifies each worktree against live + archived threads, applies a global scope setting, renders a confirmation dialog with lazy/cached sizes, and invokes batch removal. Two entry points (sidebar repo context menu, archived-threads settings panel) open the same dialog.

**Tech Stack:** Effect (server driver + RPC), Effect Schema (contracts), React + Base UI dialog primitives (web), `vite-plus/test` (test runner via `vp test run`).

---

## Spec reference

Design spec: `docs/superpowers/specs/2026-06-10-repo-worktree-housekeeping-design.md`.

## Conventions used in this plan

- **Test runner:** from inside a package directory, run `vp test run <relative-path>` (apps/web also needs `--project unit`). Examples are given per task.
- **Typecheck:** from repo root, `bun run tc`.
- **Lint:** from repo root, `bun run lint`.
- **Test frameworks differ by package — match the file you are editing:**
  - Contracts schema tests and web pure-logic tests use `vite-plus/test`: `import { describe, expect, it } from "vite-plus/test";` with `expect(...).toBe(...)`.
  - The server driver test (`GitVcsDriverCore.test.ts`) uses `@effect/vitest`: `import { assert, it, describe } from "@effect/vitest";`, tests are written as `it.effect("...", () => Effect.gen(function* () { ... }))` inside the existing `it.layer(TestLayer)("GitVcsDriver core integration", (it) => { ... })` block, and assertions use chai-style `assert.equal` / `assert.isAbove` / `assert.isString`.
- **Commit after every task.** Conventional-commit style (`feat:`, `test:`, `refactor:`).

## File map

**Contracts (`packages/contracts/src/`)**
- `settings.ts` — add `WorktreeCleanupScope` literal + `worktreeCleanupScope` server setting (default `"orphaned"`).
- `git.ts` — add `VcsManagedWorktree`, `VcsListManagedWorktreesInput/Result`, `VcsWorktreeSizeInput/Result`, `VcsRemoveWorktreesInput/Result`.
- `rpc.ts` — add 3 `WS_METHODS`, 3 `Rpc.make` defs, register them, import the new schemas.
- `ipc.ts` — add 3 methods to `EnvironmentApi.vcs`.

**Server (`apps/server/src/`)**
- `vcs/GitVcsDriver.ts` — add 3 methods to the driver shape interface.
- `vcs/GitVcsDriverCore.ts` — implement `listManagedWorktrees`, `worktreeSize`, `removeWorktrees`; export them.
- `vcs/GitVcsDriverCore.test.ts` — driver tests against a real temp repo.
- `git/GitWorkflowService.ts` — add 3 members (interface + impl).
- `ws.ts` — add auth scopes + handlers.
- `server.test.ts` — extend the `gitWorkflow` mock with the 3 new methods.

**Client runtime (`packages/client-runtime/src/`)**
- `wsRpcClient.ts` — add 3 typed methods + implementations.

**Web (`apps/web/src/`)**
- `environmentApi.ts` — map 3 methods.
- `localApi.test.ts` — extend the vcs mock.
- `worktreeCleanup.ts` — add `classifyManagedWorktrees` + `selectWorktreesForScope` pure helpers.
- `worktreeCleanup.test.ts` — tests for the new helpers.
- `components/WorktreeCleanupDialog.logic.ts` — pure UI helpers (`formatBytes`, totals, force-gating, removal items).
- `components/WorktreeCleanupDialog.logic.test.ts` — tests.
- `components/WorktreeCleanupDialog.tsx` — the dialog component.
- `components/settings/SettingsPanels.tsx` — settings Select for scope; archived-panel cleanup button + visible Delete button.
- `components/Sidebar.tsx` — context-menu "Clean up worktrees" item + dialog mount.

---

## Task 1: Add `worktreeCleanupScope` setting to contracts

**Files:**
- Modify: `packages/contracts/src/settings.ts`
- Test: `packages/contracts/src/settings.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

`packages/contracts/src/settings.test.ts` already exists and already imports `DEFAULT_SERVER_SETTINGS` from `./settings.ts` and `describe/expect/it` from `vite-plus/test`. Append this block (no new imports needed):

```typescript
describe("worktreeCleanupScope", () => {
  it("defaults to orphaned", () => {
    expect(DEFAULT_SERVER_SETTINGS.worktreeCleanupScope).toBe("orphaned");
  });
});
```

(`DEFAULT_SERVER_SETTINGS` is `Schema.decodeSync(ServerSettings)({})`, so the `withDecodingDefault` you add in Step 3 populates this field automatically.)

- [ ] **Step 2: Run test to verify it fails**

Run (from `packages/contracts`): `vp test run src/settings.test.ts`
Expected: FAIL — `worktreeCleanupScope` is `undefined` / not a key.

- [ ] **Step 3: Add the literal type and the setting field**

In `packages/contracts/src/settings.ts`, near the other `Schema.Literals` declarations (e.g. just below `ThreadEnvMode` around line 103), add:

```typescript
export const WorktreeCleanupScope = Schema.Literals(["orphaned", "orphaned-archived"]);
export type WorktreeCleanupScope = typeof WorktreeCleanupScope.Type;
```

Then in the `ServerSettings` `Schema.Struct` (where `defaultThreadEnvMode` is defined, around line 373), add a sibling field:

```typescript
worktreeCleanupScope: WorktreeCleanupScope.pipe(
  Schema.withDecodingDefault(Effect.succeed("orphaned" as const satisfies WorktreeCleanupScope)),
),
```

(`Effect` and `Schema` are already imported in this file — confirm at the top before adding.)

- [ ] **Step 4: Run test to verify it passes**

Run (from `packages/contracts`): `vp test run src/settings.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/settings.ts packages/contracts/src/settings.test.ts
git commit -m "feat(contracts): add worktreeCleanupScope setting"
```

---

## Task 2: Add worktree-cleanup contract schemas

**Files:**
- Modify: `packages/contracts/src/git.ts`
- Test: `packages/contracts/src/git.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/contracts/src/git.test.ts` (match the file's existing import + decode style — it already imports `Schema` and the git schemas):

```typescript
import {
  VcsListManagedWorktreesResult,
  VcsRemoveWorktreesInput,
  VcsWorktreeSizeResult,
} from "./git.ts";

describe("managed worktree schemas", () => {
  it("decodes a managed worktrees result", () => {
    const decoded = Schema.decodeUnknownSync(VcsListManagedWorktreesResult)({
      worktrees: [{ path: "/wt/a", refName: "feature-a", isDirty: false }],
    });
    expect(decoded.worktrees[0]?.isDirty).toBe(false);
  });

  it("decodes a worktree size result", () => {
    const decoded = Schema.decodeUnknownSync(VcsWorktreeSizeResult)({ sizeBytes: 4096 });
    expect(decoded.sizeBytes).toBe(4096);
  });

  it("decodes a batch remove input with per-item force", () => {
    const decoded = Schema.decodeUnknownSync(VcsRemoveWorktreesInput)({
      cwd: "/repo",
      items: [{ path: "/wt/a", force: true }, { path: "/wt/b" }],
    });
    expect(decoded.items.length).toBe(2);
    expect(decoded.items[0]?.force).toBe(true);
  });
});
```

If `describe/it/expect` and `Schema` are not yet imported at the top of `git.test.ts`, add `import { describe, expect, it } from "vite-plus/test";` and `import * as Schema from "effect/Schema";` (check the existing header first to avoid duplicates).

- [ ] **Step 2: Run test to verify it fails**

Run (from `packages/contracts`): `vp test run src/git.test.ts`
Expected: FAIL — these schemas are not exported yet.

- [ ] **Step 3: Add the schemas**

In `packages/contracts/src/git.ts`, just below the existing `VcsRemoveWorktreeInput` (around line 161), add:

```typescript
export const VcsManagedWorktree = Schema.Struct({
  path: TrimmedNonEmptyStringSchema,
  refName: TrimmedNonEmptyStringSchema,
  isDirty: Schema.Boolean,
});
export type VcsManagedWorktree = typeof VcsManagedWorktree.Type;

export const VcsListManagedWorktreesInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
});
export type VcsListManagedWorktreesInput = typeof VcsListManagedWorktreesInput.Type;

export const VcsListManagedWorktreesResult = Schema.Struct({
  worktrees: Schema.Array(VcsManagedWorktree),
});
export type VcsListManagedWorktreesResult = typeof VcsListManagedWorktreesResult.Type;

export const VcsWorktreeSizeInput = Schema.Struct({
  path: TrimmedNonEmptyStringSchema,
});
export type VcsWorktreeSizeInput = typeof VcsWorktreeSizeInput.Type;

export const VcsWorktreeSizeResult = Schema.Struct({
  sizeBytes: NonNegativeInt,
});
export type VcsWorktreeSizeResult = typeof VcsWorktreeSizeResult.Type;

const VcsRemoveWorktreeItem = Schema.Struct({
  path: TrimmedNonEmptyStringSchema,
  force: Schema.optional(Schema.Boolean),
});

export const VcsRemoveWorktreesInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  items: Schema.Array(VcsRemoveWorktreeItem),
});
export type VcsRemoveWorktreesInput = typeof VcsRemoveWorktreesInput.Type;

const VcsRemoveWorktreeOutcome = Schema.Struct({
  path: TrimmedNonEmptyStringSchema,
  ok: Schema.Boolean,
  error: Schema.optional(TrimmedNonEmptyStringSchema),
});

export const VcsRemoveWorktreesResult = Schema.Struct({
  results: Schema.Array(VcsRemoveWorktreeOutcome),
});
export type VcsRemoveWorktreesResult = typeof VcsRemoveWorktreesResult.Type;
```

(`NonNegativeInt` is already imported at `git.ts:2`. `TrimmedNonEmptyStringSchema` is the local alias defined at `git.ts:6`.)

- [ ] **Step 4: Run test to verify it passes**

Run (from `packages/contracts`): `vp test run src/git.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/git.ts packages/contracts/src/git.test.ts
git commit -m "feat(contracts): add managed-worktree cleanup schemas"
```

---

## Task 3: Wire the new RPC methods

**Files:**
- Modify: `packages/contracts/src/rpc.ts`

- [ ] **Step 1: Add WS method names**

In `rpc.ts`, in the `WS_METHODS` VCS section (around lines 133-141), add three entries next to `vcsRemoveWorktree`:

```typescript
  vcsListManagedWorktrees: "vcs.listManagedWorktrees",
  vcsWorktreeSize: "vcs.worktreeSize",
  vcsRemoveWorktrees: "vcs.removeWorktrees",
```

- [ ] **Step 2: Import the new schemas**

In the import block from `./git.ts` (around lines 16-40), add:

```typescript
  VcsListManagedWorktreesInput,
  VcsListManagedWorktreesResult,
  VcsWorktreeSizeInput,
  VcsWorktreeSizeResult,
  VcsRemoveWorktreesInput,
  VcsRemoveWorktreesResult,
```

- [ ] **Step 3: Define the Rpc objects**

Next to `WsVcsRemoveWorktreeRpc` (around line 385), add:

```typescript
export const WsVcsListManagedWorktreesRpc = Rpc.make(WS_METHODS.vcsListManagedWorktrees, {
  payload: VcsListManagedWorktreesInput,
  success: VcsListManagedWorktreesResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsWorktreeSizeRpc = Rpc.make(WS_METHODS.vcsWorktreeSize, {
  payload: VcsWorktreeSizeInput,
  success: VcsWorktreeSizeResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

export const WsVcsRemoveWorktreesRpc = Rpc.make(WS_METHODS.vcsRemoveWorktrees, {
  payload: VcsRemoveWorktreesInput,
  success: VcsRemoveWorktreesResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});
```

- [ ] **Step 4: Register the Rpcs in the group**

In the RpcGroup list (around lines 570-581), add next to `WsVcsRemoveWorktreeRpc,`:

```typescript
  WsVcsListManagedWorktreesRpc,
  WsVcsWorktreeSizeRpc,
  WsVcsRemoveWorktreesRpc,
```

- [ ] **Step 5: Typecheck**

Run (from repo root): `bun run tc`
Expected: PASS for `@t3tools/contracts` (other packages may still error until later tasks — that is acceptable for this task's scope, but contracts itself must compile).

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/rpc.ts
git commit -m "feat(contracts): register managed-worktree cleanup RPCs"
```

---

## Task 4: Add driver-shape interface methods

**Files:**
- Modify: `apps/server/src/vcs/GitVcsDriver.ts`

- [ ] **Step 1: Import the new types**

In the `@t3tools/contracts` import block of `GitVcsDriver.ts` (around lines 19-27), add:

```typescript
  type VcsListManagedWorktreesInput,
  type VcsListManagedWorktreesResult,
  type VcsWorktreeSizeInput,
  type VcsWorktreeSizeResult,
  type VcsRemoveWorktreesInput,
  type VcsRemoveWorktreesResult,
```

- [ ] **Step 2: Add the shape members**

Next to `readonly removeWorktree: ...` (around line 210), add:

```typescript
  readonly listManagedWorktrees: (
    input: VcsListManagedWorktreesInput,
  ) => Effect.Effect<VcsListManagedWorktreesResult, GitCommandError>;
  readonly worktreeSize: (
    input: VcsWorktreeSizeInput,
  ) => Effect.Effect<VcsWorktreeSizeResult, GitCommandError>;
  readonly removeWorktrees: (
    input: VcsRemoveWorktreesInput,
  ) => Effect.Effect<VcsRemoveWorktreesResult, GitCommandError>;
```

- [ ] **Step 3: Typecheck (expected to fail at the core)**

Run (from repo root): `bun run tc`
Expected: FAIL in `GitVcsDriverCore.ts` — the frozen driver object does not yet implement these. This is expected; Task 5-7 implement them. Do not commit a broken typecheck on its own; proceed directly to Task 5 and commit the interface + first implementation together if you prefer. (If using subagent-driven execution, note this cross-task dependency to the reviewer.)

---

## Task 5: Implement `listManagedWorktrees` in the driver

**Files:**
- Modify: `apps/server/src/vcs/GitVcsDriverCore.ts`
- Test: `apps/server/src/vcs/GitVcsDriverCore.test.ts`

- [ ] **Step 1: Write the failing test**

Add a new `describe` block **inside** the existing `it.layer(TestLayer)("GitVcsDriver core integration", (it) => { ... })` callback in `GitVcsDriverCore.test.ts` (the same place the existing `describe("commit context", ...)` lives). It uses the file's existing helpers `makeTmpDir`, `initRepoWithCommit`, and the `GitVcsDriver.GitVcsDriver` tag. Note: pass `path: null` to `createWorktree` so the worktree is created under the test config's `worktreesDir` and therefore counts as *managed*.

```typescript
describe("managed worktrees", () => {
  it.effect("lists managed worktrees under the worktrees dir with dirty status", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;

      yield* driver.createWorktree({
        cwd,
        refName: initialBranch,
        newRefName: "feature-a",
        path: null,
      });

      const result = yield* driver.listManagedWorktrees({ cwd });

      assert.equal(result.worktrees.length, 1);
      assert.equal(result.worktrees[0]?.refName, "feature-a");
      // Fresh worktree branch has no remote => treated as dirty (unpushed).
      assert.equal(result.worktrees[0]?.isDirty, true);
    }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/server`): `vp test run src/vcs/GitVcsDriverCore.test.ts`
Expected: FAIL — `driver.listManagedWorktrees` is not a function.

- [ ] **Step 3: Implement the helper + method**

In `GitVcsDriverCore.ts`, inside `makeGitVcsDriverCore` (after `removeWorktree` around line 2156, before the frozen return), add a dirty-check helper and the method. `Option` is already imported (used at line 728); `path`, `fileSystem`, `worktreesDir`, `executeGit` are all in scope.

```typescript
const readWorktreeDirty = (worktreePath: string): Effect.Effect<boolean, never> =>
  Effect.gen(function* () {
    const statusResult = yield* executeGit(
      "GitVcsDriver.listManagedWorktrees.status",
      worktreePath,
      ["status", "--porcelain"],
      { timeoutMs: 10_000, allowNonZeroExit: true },
    ).pipe(Effect.orElseSucceed(() => null));
    if (statusResult && statusResult.stdout.trim().length > 0) {
      return true;
    }
    const remoteContains = yield* executeGit(
      "GitVcsDriver.listManagedWorktrees.remoteContains",
      worktreePath,
      ["branch", "--remotes", "--contains", "HEAD"],
      { timeoutMs: 10_000, allowNonZeroExit: true },
    ).pipe(Effect.orElseSucceed(() => null));
    const hasRemoteContainingHead =
      remoteContains !== null &&
      remoteContains.exitCode === 0 &&
      remoteContains.stdout.trim().length > 0;
    // No remote branch contains HEAD => there is unpushed work.
    return !hasRemoteContainingHead;
  });

const isUnderWorktreesDir = (candidate: string): boolean => {
  const normalized = path.resolve(candidate);
  const base = path.resolve(worktreesDir);
  return normalized === base || normalized.startsWith(base + path.sep);
};

const listManagedWorktrees: GitVcsDriver.GitVcsDriverShape["listManagedWorktrees"] = Effect.fn(
  "listManagedWorktrees",
)(function* (input) {
  const result = yield* executeGit(
    "GitVcsDriver.listManagedWorktrees",
    input.cwd,
    ["worktree", "list", "--porcelain"],
    { timeoutMs: 10_000, allowNonZeroExit: true },
  );
  if (result.exitCode !== 0) {
    return { worktrees: [] };
  }

  const candidates: { path: string; refName: string }[] = [];
  let currentPath: string | null = null;
  let currentBranch: string | null = null;
  const flush = () => {
    if (currentPath && isUnderWorktreesDir(currentPath)) {
      candidates.push({
        path: currentPath,
        refName: currentBranch ?? path.basename(currentPath),
      });
    }
    currentPath = null;
    currentBranch = null;
  };
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      currentPath = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch refs/heads/")) {
      currentBranch = line.slice("branch refs/heads/".length).trim();
    } else if (line.trim() === "") {
      flush();
    }
  }
  flush();

  // Keep only worktrees that still exist on disk.
  const existing = yield* Effect.forEach(
    candidates,
    (candidate) =>
      fileSystem.stat(candidate.path).pipe(
        Effect.as(Option.some(candidate)),
        Effect.orElseSucceed(() => Option.none<{ path: string; refName: string }>()),
      ),
    { concurrency: 8 },
  ).pipe(Effect.map((options) => options.flatMap((o) => (Option.isSome(o) ? [o.value] : []))));

  const worktrees = yield* Effect.forEach(
    existing,
    (candidate) =>
      readWorktreeDirty(candidate.path).pipe(
        Effect.map((isDirty) => ({ path: candidate.path, refName: candidate.refName, isDirty })),
      ),
    { concurrency: 4 },
  );

  return { worktrees };
});
```

- [ ] **Step 4: Add to the frozen export object**

In the `return Object.freeze({ ... })` block (around lines 2308-2326), add `listManagedWorktrees,` next to `removeWorktree,`.

- [ ] **Step 5: Run test to verify it passes**

Run (from `apps/server`): `vp test run src/vcs/GitVcsDriverCore.test.ts`
Expected: PASS for the new test.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/vcs/GitVcsDriver.ts apps/server/src/vcs/GitVcsDriverCore.ts apps/server/src/vcs/GitVcsDriverCore.test.ts
git commit -m "feat(server): list managed worktrees with dirty status"
```

---

## Task 6: Implement `worktreeSize` in the driver

**Files:**
- Modify: `apps/server/src/vcs/GitVcsDriverCore.ts`
- Test: `apps/server/src/vcs/GitVcsDriverCore.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside the same `describe("managed worktrees", ...)` block:

```typescript
it.effect("computes the on-disk byte size of a worktree", () =>
  Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    const { initialBranch } = yield* initRepoWithCommit(cwd);
    const driver = yield* GitVcsDriver.GitVcsDriver;

    const created = yield* driver.createWorktree({
      cwd,
      refName: initialBranch,
      newRefName: "feature-size",
      path: null,
    });

    const { sizeBytes } = yield* driver.worktreeSize({ path: created.worktree.path });

    // A real checkout always has tracked files on disk.
    assert.isAbove(sizeBytes, 0);
  }),
);
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/server`): `vp test run src/vcs/GitVcsDriverCore.test.ts`
Expected: FAIL — `driver.worktreeSize` is not a function.

- [ ] **Step 3: Implement the recursive-walk size method**

In `GitVcsDriverCore.ts`, near `listManagedWorktrees`, add:

```typescript
const directorySizeBytes = (rootPath: string): Effect.Effect<number, never> => {
  const walk = (current: string): Effect.Effect<number, never> =>
    fileSystem.readDirectory(current).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(
          entries,
          (entry) => {
            const childPath = path.join(current, entry);
            return fileSystem.stat(childPath).pipe(
              Effect.flatMap((info) =>
                info.type === "Directory"
                  ? walk(childPath)
                  : Effect.succeed(Number(info.size)),
              ),
              Effect.orElseSucceed(() => 0),
            );
          },
          { concurrency: 8 },
        ),
      ),
      Effect.map((sizes) => sizes.reduce((total, size) => total + size, 0)),
      Effect.orElseSucceed(() => 0),
    );
  return walk(rootPath);
};

const worktreeSize: GitVcsDriver.GitVcsDriverShape["worktreeSize"] = Effect.fn("worktreeSize")(
  function* (input) {
    const sizeBytes = yield* directorySizeBytes(input.path);
    return { sizeBytes };
  },
);
```

> Note: this follows symbolic links (Effect `stat` resolves them). Worktree checkouts do not contain cyclic symlinks in practice, so this is acceptable for a size estimate. Document this as a known limitation if a reviewer asks.

- [ ] **Step 4: Add to the frozen export object**

Add `worktreeSize,` to the `Object.freeze({ ... })` block.

- [ ] **Step 5: Run test to verify it passes**

Run (from `apps/server`): `vp test run src/vcs/GitVcsDriverCore.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/vcs/GitVcsDriverCore.ts apps/server/src/vcs/GitVcsDriverCore.test.ts
git commit -m "feat(server): compute worktree on-disk size"
```

---

## Task 7: Implement `removeWorktrees` (batch) in the driver

**Files:**
- Modify: `apps/server/src/vcs/GitVcsDriverCore.ts`
- Test: `apps/server/src/vcs/GitVcsDriverCore.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside the same `describe("managed worktrees", ...)` block:

```typescript
it.effect("batch-removes worktrees and reports per-path outcomes", () =>
  Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    const { initialBranch } = yield* initRepoWithCommit(cwd);
    const driver = yield* GitVcsDriver.GitVcsDriver;

    const a = yield* driver.createWorktree({
      cwd,
      refName: initialBranch,
      newRefName: "rm-a",
      path: null,
    });

    const { results } = yield* driver.removeWorktrees({
      cwd,
      items: [
        { path: a.worktree.path, force: true },
        { path: "/does/not/exist", force: true },
      ],
    });

    assert.equal(results.length, 2);
    assert.equal(results.find((r) => r.path === a.worktree.path)?.ok, true);
    const missing = results.find((r) => r.path === "/does/not/exist");
    assert.equal(missing?.ok, false);
    assert.isString(missing?.error);
  }),
);
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/server`): `vp test run src/vcs/GitVcsDriverCore.test.ts`
Expected: FAIL — `driver.removeWorktrees` is not a function.

- [ ] **Step 3: Implement the batch remove**

In `GitVcsDriverCore.ts`, near the other new methods, add:

```typescript
const removeWorktrees: GitVcsDriver.GitVcsDriverShape["removeWorktrees"] = Effect.fn(
  "removeWorktrees",
)(function* (input) {
  const results = yield* Effect.forEach(
    input.items,
    (item) => {
      const args = ["worktree", "remove"];
      if (item.force) {
        args.push("--force");
      }
      args.push(item.path);
      return executeGit("GitVcsDriver.removeWorktrees", input.cwd, args, {
        timeoutMs: 15_000,
        fallbackErrorMessage: "git worktree remove failed",
      }).pipe(
        Effect.as({ path: item.path, ok: true as const }),
        Effect.catchAll((error) =>
          Effect.succeed({ path: item.path, ok: false as const, error: error.message }),
        ),
      );
    },
    { concurrency: 1 }, // serialize: concurrent worktree removals race on .git/worktrees metadata
  );
  return { results };
});
```

- [ ] **Step 4: Add to the frozen export object**

Add `removeWorktrees,` to the `Object.freeze({ ... })` block.

- [ ] **Step 5: Run test + typecheck**

Run (from `apps/server`): `vp test run src/vcs/GitVcsDriverCore.test.ts`
Expected: PASS
Run (from repo root): `bun run tc`
Expected: PASS for `@t3tools/server` driver layer (GitWorkflowService/ws will still need Task 8-9; those files may still error — acceptable until then, but the driver file itself must compile).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/vcs/GitVcsDriverCore.ts apps/server/src/vcs/GitVcsDriverCore.test.ts
git commit -m "feat(server): batch-remove worktrees with per-path force"
```

---

## Task 8: Expose the three methods on `GitWorkflowService`

**Files:**
- Modify: `apps/server/src/git/GitWorkflowService.ts`

- [ ] **Step 1: Import the new types**

In the `@t3tools/contracts` import block (around lines 12-21), add:

```typescript
  type VcsListManagedWorktreesInput,
  type VcsListManagedWorktreesResult,
  type VcsWorktreeSizeInput,
  type VcsWorktreeSizeResult,
  type VcsRemoveWorktreesInput,
  type VcsRemoveWorktreesResult,
```

- [ ] **Step 2: Add interface members**

Next to `readonly removeWorktree: ...` (around line 63), add:

```typescript
  readonly listManagedWorktrees: (
    input: VcsListManagedWorktreesInput,
  ) => Effect.Effect<VcsListManagedWorktreesResult, GitCommandError>;
  readonly worktreeSize: (
    input: VcsWorktreeSizeInput,
  ) => Effect.Effect<VcsWorktreeSizeResult, GitCommandError>;
  readonly removeWorktrees: (
    input: VcsRemoveWorktreesInput,
  ) => Effect.Effect<VcsRemoveWorktreesResult, GitCommandError>;
```

- [ ] **Step 3: Add implementations**

Next to the `removeWorktree:` implementation (around line 297), add. `listManagedWorktrees` and `removeWorktrees` run git in `input.cwd`, so they use `ensureGitCommand`; `worktreeSize` does no git work (filesystem only), so it calls the driver directly:

```typescript
listManagedWorktrees: (input) =>
  ensureGitCommand("GitWorkflowService.listManagedWorktrees", input.cwd).pipe(
    Effect.andThen(git.listManagedWorktrees(input)),
  ),
worktreeSize: (input) => git.worktreeSize(input),
removeWorktrees: (input) =>
  ensureGitCommand("GitWorkflowService.removeWorktrees", input.cwd).pipe(
    Effect.andThen(git.removeWorktrees(input)),
  ),
```

- [ ] **Step 4: Typecheck**

Run (from repo root): `bun run tc`
Expected: PASS for `@t3tools/server` except `ws.ts` (handlers added next).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/git/GitWorkflowService.ts
git commit -m "feat(server): expose managed-worktree cleanup on GitWorkflowService"
```

---

## Task 9: Wire WS auth scopes + handlers

**Files:**
- Modify: `apps/server/src/ws.ts`
- Modify: `apps/server/src/server.test.ts`

- [ ] **Step 1: Add auth scopes**

In `ws.ts`, in the scope-map list (around lines 166-172), add. List + size are read-only; batch remove mutates:

```typescript
[WS_METHODS.vcsListManagedWorktrees, AuthOrchestrationReadScope],
[WS_METHODS.vcsWorktreeSize, AuthOrchestrationReadScope],
[WS_METHODS.vcsRemoveWorktrees, AuthOrchestrationOperateScope],
```

- [ ] **Step 2: Add handlers**

In the handler map (next to `[WS_METHODS.vcsRemoveWorktree]:` around line 1266), add:

```typescript
[WS_METHODS.vcsListManagedWorktrees]: (input) =>
  observeRpcEffect(
    WS_METHODS.vcsListManagedWorktrees,
    gitWorkflow.listManagedWorktrees(input),
    { "rpc.aggregate": "vcs" },
  ),
[WS_METHODS.vcsWorktreeSize]: (input) =>
  observeRpcEffect(WS_METHODS.vcsWorktreeSize, gitWorkflow.worktreeSize(input), {
    "rpc.aggregate": "vcs",
  }),
[WS_METHODS.vcsRemoveWorktrees]: (input) =>
  observeRpcEffect(
    WS_METHODS.vcsRemoveWorktrees,
    gitWorkflow.removeWorktrees(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
    { "rpc.aggregate": "vcs" },
  ),
```

- [ ] **Step 3: Extend the server test mock**

In `server.test.ts`, the `gitWorkflow` mock (around line 4863) declares `removeWorktree: () => Effect.void`. Add the three new methods so the mock satisfies the interface:

```typescript
listManagedWorktrees: () => Effect.succeed({ worktrees: [] }),
worktreeSize: () => Effect.succeed({ sizeBytes: 0 }),
removeWorktrees: () => Effect.succeed({ results: [] }),
```

- [ ] **Step 4: Run server tests + typecheck**

Run (from `apps/server`): `vp test run src/server.test.ts`
Expected: PASS
Run (from repo root): `bun run tc`
Expected: PASS for `@t3tools/server`.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/ws.ts apps/server/src/server.test.ts
git commit -m "feat(server): wire managed-worktree cleanup WS handlers"
```

---

## Task 10: Add methods to the `EnvironmentApi.vcs` IPC contract

**Files:**
- Modify: `packages/contracts/src/ipc.ts`

- [ ] **Step 1: Import the new types**

In the `./git.ts` import block (around lines 1-20), add:

```typescript
  VcsListManagedWorktreesInput,
  VcsListManagedWorktreesResult,
  VcsWorktreeSizeInput,
  VcsWorktreeSizeResult,
  VcsRemoveWorktreesInput,
  VcsRemoveWorktreesResult,
```

- [ ] **Step 2: Add interface methods**

In the `vcs:` block (around lines 567-583), next to `removeWorktree`, add:

```typescript
    listManagedWorktrees: (
      input: VcsListManagedWorktreesInput,
    ) => Promise<VcsListManagedWorktreesResult>;
    worktreeSize: (input: VcsWorktreeSizeInput) => Promise<VcsWorktreeSizeResult>;
    removeWorktrees: (input: VcsRemoveWorktreesInput) => Promise<VcsRemoveWorktreesResult>;
```

- [ ] **Step 3: Typecheck**

Run (from repo root): `bun run tc`
Expected: `@t3tools/contracts` compiles; consumers wired in next tasks.

- [ ] **Step 4: Commit**

```bash
git add packages/contracts/src/ipc.ts
git commit -m "feat(contracts): add managed-worktree cleanup to EnvironmentApi.vcs"
```

---

## Task 11: Implement the methods in `wsRpcClient`

**Files:**
- Modify: `packages/client-runtime/src/wsRpcClient.ts`

- [ ] **Step 1: Add type declarations**

In the `vcs` type block (around lines 100-114), next to `removeWorktree`, add:

```typescript
    readonly listManagedWorktrees: RpcUnaryMethod<typeof WS_METHODS.vcsListManagedWorktrees>;
    readonly worktreeSize: RpcUnaryMethod<typeof WS_METHODS.vcsWorktreeSize>;
    readonly removeWorktrees: RpcUnaryMethod<typeof WS_METHODS.vcsRemoveWorktrees>;
```

- [ ] **Step 2: Add implementations**

In the `vcs` implementation block (around lines 236-259), next to `removeWorktree`, add:

```typescript
      listManagedWorktrees: (input) =>
        transport.request((client) => client[WS_METHODS.vcsListManagedWorktrees](input)),
      worktreeSize: (input) =>
        transport.request((client) => client[WS_METHODS.vcsWorktreeSize](input)),
      removeWorktrees: (input) =>
        transport.request((client) => client[WS_METHODS.vcsRemoveWorktrees](input)),
```

- [ ] **Step 3: Typecheck**

Run (from repo root): `bun run tc`
Expected: PASS for `@t3tools/client-runtime`.

- [ ] **Step 4: Commit**

```bash
git add packages/client-runtime/src/wsRpcClient.ts
git commit -m "feat(client-runtime): add managed-worktree cleanup RPC methods"
```

---

## Task 12: Map methods in web `environmentApi` + fix mocks

**Files:**
- Modify: `apps/web/src/environmentApi.ts`
- Modify: `apps/web/src/localApi.test.ts`

- [ ] **Step 1: Add mappings**

In `environmentApi.ts`, in the `vcs` object (around lines 33-43), next to `removeWorktree`, add:

```typescript
      listManagedWorktrees: rpcClient.vcs.listManagedWorktrees,
      worktreeSize: rpcClient.vcs.worktreeSize,
      removeWorktrees: rpcClient.vcs.removeWorktrees,
```

- [ ] **Step 2: Extend the vcs mock in `localApi.test.ts`**

`localApi.test.ts` mocks `removeWorktree: vi.fn()` (around line 80). Add:

```typescript
    listManagedWorktrees: vi.fn(async () => ({ worktrees: [] })),
    worktreeSize: vi.fn(async () => ({ sizeBytes: 0 })),
    removeWorktrees: vi.fn(async () => ({ results: [] })),
```

> Also check `apps/web/src/environments/runtime/service.savedEnvironments.test.ts` and `service.threadSubscriptions.test.ts` — they each mock `removeWorktree`. If TypeScript flags them as missing the new methods, add the same three mock entries there.

- [ ] **Step 3: Run web unit tests + typecheck**

Run (from `apps/web`): `vp test run src/localApi.test.ts --project unit`
Expected: PASS
Run (from repo root): `bun run tc`
Expected: PASS for `@t3tools/web`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/environmentApi.ts apps/web/src/localApi.test.ts
git commit -m "feat(web): map managed-worktree cleanup environment API"
```

---

## Task 13: Add worktree classification helpers

**Files:**
- Modify: `apps/web/src/worktreeCleanup.ts`
- Modify: `apps/web/src/worktreeCleanup.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `worktreeCleanup.test.ts`:

```typescript
import type { VcsManagedWorktree } from "@t3tools/contracts";
import {
  classifyManagedWorktrees,
  selectWorktreesForScope,
  type WorktreeThreadRef,
} from "./worktreeCleanup";

function wt(path: string, isDirty = false): VcsManagedWorktree {
  return { path, refName: path.split("/").pop() ?? path, isDirty };
}

describe("classifyManagedWorktrees", () => {
  it("marks worktrees with a live thread as active", () => {
    const refs: WorktreeThreadRef[] = [{ worktreePath: "/wt/a", isArchived: false }];
    const [classified] = classifyManagedWorktrees([wt("/wt/a")], refs);
    expect(classified?.classification).toBe("active");
  });

  it("marks worktrees referenced only by archived threads as archived-only", () => {
    const refs: WorktreeThreadRef[] = [{ worktreePath: "/wt/a", isArchived: true }];
    const [classified] = classifyManagedWorktrees([wt("/wt/a")], refs);
    expect(classified?.classification).toBe("archived-only");
  });

  it("marks worktrees with no thread as orphaned", () => {
    const [classified] = classifyManagedWorktrees([wt("/wt/a")], []);
    expect(classified?.classification).toBe("orphaned");
  });
});

describe("selectWorktreesForScope", () => {
  const classified = classifyManagedWorktrees(
    [wt("/wt/orphan"), wt("/wt/arch"), wt("/wt/active")],
    [
      { worktreePath: "/wt/arch", isArchived: true },
      { worktreePath: "/wt/active", isArchived: false },
    ],
  );

  it("orphaned scope selects only orphaned worktrees", () => {
    const selected = selectWorktreesForScope(classified, "orphaned");
    expect(selected.map((c) => c.worktree.path)).toEqual(["/wt/orphan"]);
  });

  it("orphaned-archived scope adds archived-only worktrees", () => {
    const selected = selectWorktreesForScope(classified, "orphaned-archived");
    expect(selected.map((c) => c.worktree.path).sort()).toEqual(["/wt/arch", "/wt/orphan"]);
  });

  it("never selects active worktrees", () => {
    const selected = selectWorktreesForScope(classified, "orphaned-archived");
    expect(selected.some((c) => c.worktree.path === "/wt/active")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/web`): `vp test run src/worktreeCleanup.test.ts --project unit`
Expected: FAIL — `classifyManagedWorktrees` / `selectWorktreesForScope` not exported.

- [ ] **Step 3: Implement the helpers**

Append to `worktreeCleanup.ts` (it already has `normalizeWorktreePath`):

```typescript
import type { VcsManagedWorktree, WorktreeCleanupScope } from "@t3tools/contracts";

export type WorktreeClassification = "active" | "archived-only" | "orphaned";

export interface WorktreeThreadRef {
  worktreePath: string | null;
  isArchived: boolean;
}

export interface ClassifiedWorktree {
  worktree: VcsManagedWorktree;
  classification: WorktreeClassification;
}

export function classifyManagedWorktrees(
  worktrees: readonly VcsManagedWorktree[],
  threadRefs: readonly WorktreeThreadRef[],
): ClassifiedWorktree[] {
  return worktrees.map((worktree) => {
    const normalized = normalizeWorktreePath(worktree.path);
    const linked = threadRefs.filter(
      (ref) => normalizeWorktreePath(ref.worktreePath) === normalized,
    );
    const classification: WorktreeClassification = linked.some((ref) => !ref.isArchived)
      ? "active"
      : linked.length > 0
        ? "archived-only"
        : "orphaned";
    return { worktree, classification };
  });
}

export function selectWorktreesForScope(
  classified: readonly ClassifiedWorktree[],
  scope: WorktreeCleanupScope,
): ClassifiedWorktree[] {
  return classified.filter(
    (entry) =>
      entry.classification === "orphaned" ||
      (scope === "orphaned-archived" && entry.classification === "archived-only"),
  );
}
```

> If `WorktreeCleanupScope` / `VcsManagedWorktree` are not re-exported from the `@t3tools/contracts` barrel, add `export * from "./git.ts";` / the `settings.ts` export there (check `packages/contracts/src/index.ts`). Verify with the typecheck in the next step.

- [ ] **Step 4: Run test + typecheck**

Run (from `apps/web`): `vp test run src/worktreeCleanup.test.ts --project unit`
Expected: PASS
Run (from repo root): `bun run tc`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/worktreeCleanup.ts apps/web/src/worktreeCleanup.test.ts packages/contracts/src/index.ts
git commit -m "feat(web): classify managed worktrees by thread state and scope"
```

---

## Task 14: Add dialog logic helpers

**Files:**
- Create: `apps/web/src/components/WorktreeCleanupDialog.logic.ts`
- Create: `apps/web/src/components/WorktreeCleanupDialog.logic.test.ts`

- [ ] **Step 1: Write the failing test**

Create `WorktreeCleanupDialog.logic.test.ts`:

```typescript
import { describe, expect, it } from "vite-plus/test";
import {
  buildRemovalItems,
  type CleanupRowState,
  formatBytes,
  isRowRemovable,
  totalSelectedBytes,
} from "./WorktreeCleanupDialog.logic";

function row(overrides: Partial<CleanupRowState> = {}): CleanupRowState {
  return {
    path: "/wt/a",
    refName: "a",
    classification: "orphaned",
    isDirty: false,
    selected: true,
    force: false,
    sizeBytes: 1024,
    ...overrides,
  };
}

describe("formatBytes", () => {
  it("formats zero", () => expect(formatBytes(0)).toBe("0 B"));
  it("formats kilobytes", () => expect(formatBytes(1024)).toBe("1.0 KB"));
  it("formats megabytes", () => expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB"));
});

describe("totalSelectedBytes", () => {
  it("sums only selected rows with known sizes", () => {
    const rows = [row({ sizeBytes: 1024 }), row({ selected: false, sizeBytes: 2048 }), row({ sizeBytes: null })];
    expect(totalSelectedBytes(rows)).toBe(1024);
  });
});

describe("isRowRemovable", () => {
  it("blocks active rows", () => expect(isRowRemovable(row({ classification: "active" }))).toBe(false));
  it("blocks dirty rows without force", () =>
    expect(isRowRemovable(row({ isDirty: true, force: false }))).toBe(false));
  it("allows dirty rows with force", () =>
    expect(isRowRemovable(row({ isDirty: true, force: true }))).toBe(true));
  it("blocks deselected rows", () => expect(isRowRemovable(row({ selected: false }))).toBe(false));
});

describe("buildRemovalItems", () => {
  it("forces dirty rows and includes only removable rows", () => {
    const rows = [
      row({ path: "/wt/clean" }),
      row({ path: "/wt/dirty", isDirty: true, force: true }),
      row({ path: "/wt/active", classification: "active" }),
    ];
    expect(buildRemovalItems(rows)).toEqual([
      { path: "/wt/clean", force: false },
      { path: "/wt/dirty", force: true },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/web`): `vp test run src/components/WorktreeCleanupDialog.logic.test.ts --project unit`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the logic module**

Create `WorktreeCleanupDialog.logic.ts`:

```typescript
import type { WorktreeClassification } from "../worktreeCleanup";

export interface CleanupRowState {
  path: string;
  refName: string;
  classification: WorktreeClassification;
  isDirty: boolean;
  selected: boolean;
  force: boolean;
  sizeBytes: number | null;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function totalSelectedBytes(rows: readonly CleanupRowState[]): number {
  return rows.reduce(
    (sum, row) => (row.selected && row.sizeBytes !== null ? sum + row.sizeBytes : sum),
    0,
  );
}

export function isRowRemovable(row: CleanupRowState): boolean {
  if (row.classification === "active") {
    return false;
  }
  if (!row.selected) {
    return false;
  }
  if (row.isDirty && !row.force) {
    return false;
  }
  return true;
}

export function buildRemovalItems(
  rows: readonly CleanupRowState[],
): { path: string; force: boolean }[] {
  return rows
    .filter(isRowRemovable)
    .map((row) => ({ path: row.path, force: row.isDirty || row.force }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `apps/web`): `vp test run src/components/WorktreeCleanupDialog.logic.test.ts --project unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/WorktreeCleanupDialog.logic.ts apps/web/src/components/WorktreeCleanupDialog.logic.test.ts
git commit -m "feat(web): add worktree cleanup dialog logic helpers"
```

---

## Task 15: Build the `WorktreeCleanupDialog` component

**Files:**
- Create: `apps/web/src/components/WorktreeCleanupDialog.tsx`

This task has no unit test (it is a presentational/effectful component verified manually in Task 19). Keep all decision logic in the Task 14 helpers.

- [ ] **Step 1: Implement the component**

Create `WorktreeCleanupDialog.tsx`. This mirrors the `PullRequestThreadDialog` dialog primitives and the `useThreadActions` toast/invalidate patterns. Adjust class names to match the project's styling conventions if the reviewer requests.

```typescript
import type { EnvironmentId, VcsManagedWorktree } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { ensureEnvironmentApi } from "../environmentApi";
import { invalidateSourceControlState } from "../lib/sourceControlActions";
import {
  classifyManagedWorktrees,
  selectWorktreesForScope,
  type WorktreeThreadRef,
} from "../worktreeCleanup";
import {
  buildRemovalItems,
  type CleanupRowState,
  formatBytes,
  totalSelectedBytes,
} from "./WorktreeCleanupDialog.logic";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { stackedThreadToast, toastManager } from "./ui/toast";

interface WorktreeCleanupDialogProps {
  open: boolean;
  environmentId: EnvironmentId;
  cwd: string;
  scope: "orphaned" | "orphaned-archived";
  threadRefs: readonly WorktreeThreadRef[];
  onOpenChange: (open: boolean) => void;
}

export function WorktreeCleanupDialog({
  open,
  environmentId,
  cwd,
  scope,
  threadRefs,
  onOpenChange,
}: WorktreeCleanupDialogProps) {
  const [rows, setRows] = useState<CleanupRowState[]>([]);
  const [loading, setLoading] = useState(false);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    if (!open) {
      setRows([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const api = ensureEnvironmentApi(environmentId);
        const { worktrees } = await api.vcs.listManagedWorktrees({ cwd });
        const selected = selectWorktreesForScope(
          classifyManagedWorktrees(worktrees, threadRefs),
          scope,
        );
        if (cancelled) return;
        setRows(
          selected.map((entry) => ({
            path: entry.worktree.path,
            refName: entry.worktree.refName,
            classification: entry.classification,
            isDirty: entry.worktree.isDirty,
            selected: !entry.worktree.isDirty,
            force: false,
            sizeBytes: null,
          })),
        );
        // Lazily load sizes; cache by updating each row as it resolves.
        for (const entry of selected) {
          void api.vcs
            .worktreeSize({ path: entry.worktree.path })
            .then(({ sizeBytes }) => {
              if (cancelled) return;
              setRows((current) =>
                current.map((row) =>
                  row.path === entry.worktree.path ? { ...row, sizeBytes } : row,
                ),
              );
            })
            .catch(() => {
              /* leave sizeBytes null => shown as unknown, excluded from total */
            });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, environmentId, cwd, scope, threadRefs]);

  const setRow = useCallback((path: string, patch: Partial<CleanupRowState>) => {
    setRows((current) => current.map((row) => (row.path === path ? { ...row, ...patch } : row)));
  }, []);

  const handleConfirm = useCallback(async () => {
    const items = buildRemovalItems(rows);
    if (items.length === 0) {
      onOpenChange(false);
      return;
    }
    setRemoving(true);
    try {
      const api = ensureEnvironmentApi(environmentId);
      const { results } = await api.vcs.removeWorktrees({ cwd, items });
      await invalidateSourceControlState({ environmentId });
      const removed = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      const freed = removed.reduce((sum, r) => {
        const row = rows.find((candidate) => candidate.path === r.path);
        return sum + (row?.sizeBytes ?? 0);
      }, 0);
      toastManager.add(
        stackedThreadToast({
          type: failed.length > 0 ? "warning" : "success",
          title:
            failed.length > 0
              ? `Removed ${removed.length}, ${failed.length} failed`
              : `Removed ${removed.length} worktree${removed.length === 1 ? "" : "s"}`,
          description: `Freed ${formatBytes(freed)}.${
            failed.length > 0 ? ` Failed: ${failed.map((f) => f.path).join(", ")}` : ""
          }`,
        }),
      );
      onOpenChange(false);
    } finally {
      setRemoving(false);
    }
  }, [rows, environmentId, cwd, onOpenChange]);

  const total = totalSelectedBytes(rows);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogPanel>
          <DialogHeader>
            <DialogTitle>Clean up worktrees</DialogTitle>
            <DialogDescription>
              Remove t3code-managed worktrees for this repository. Dirty worktrees require an
              explicit force toggle.
            </DialogDescription>
          </DialogHeader>

          {loading ? (
            <p className="px-1 py-4 text-sm text-muted-foreground">Scanning worktrees…</p>
          ) : rows.length === 0 ? (
            <p className="px-1 py-4 text-sm text-muted-foreground">Nothing to clean up.</p>
          ) : (
            <ul className="flex flex-col gap-2 py-2">
              {rows.map((row) => (
                <li key={row.path} className="flex items-center gap-3 rounded-md border p-2">
                  <input
                    type="checkbox"
                    checked={row.selected}
                    disabled={row.classification === "active"}
                    onChange={(event) => setRow(row.path, { selected: event.target.checked })}
                    aria-label={`Select ${row.refName}`}
                  />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{row.refName}</span>
                    <span className="truncate text-xs text-muted-foreground">{row.path}</span>
                  </div>
                  {row.isDirty ? (
                    <label className="flex items-center gap-1 text-xs text-amber-600">
                      <input
                        type="checkbox"
                        checked={row.force}
                        onChange={(event) => setRow(row.path, { force: event.target.checked })}
                        aria-label={`Force remove ${row.refName}`}
                      />
                      force (dirty)
                    </label>
                  ) : null}
                  <span className="w-16 text-right text-xs tabular-nums text-muted-foreground">
                    {row.sizeBytes === null ? "…" : formatBytes(row.sizeBytes)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <DialogFooter>
            <span className="mr-auto text-sm text-muted-foreground">
              Reclaimable: {formatBytes(total)}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={removing}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                void handleConfirm();
              }}
              disabled={removing || buildRemovalItems(rows).length === 0}
            >
              {removing ? "Removing…" : `Remove ${buildRemovalItems(rows).length}`}
            </Button>
          </DialogFooter>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
```

> Implementer notes: (1) confirm the exact dialog sub-component names exported by `./ui/dialog` (this snippet uses `Dialog`, `DialogPopup`, `DialogPanel`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter` per `PullRequestThreadDialog.tsx`). (2) the rows use native checkboxes for density; swap them for the project's `Switch`/`Checkbox` primitive if the reviewer prefers house style. (3) `ensureEnvironmentApi` is imported in `useThreadActions.ts`; confirm its exact export path from `../environmentApi`.

- [ ] **Step 2: Typecheck**

Run (from repo root): `bun run tc`
Expected: PASS for `@t3tools/web`. Fix any import-name mismatches surfaced here.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/WorktreeCleanupDialog.tsx
git commit -m "feat(web): add worktree cleanup dialog component"
```

---

## Task 16: Render the `worktreeCleanupScope` setting

**Files:**
- Modify: `apps/web/src/components/settings/SettingsPanels.tsx`

- [ ] **Step 1: Add a Select row**

In the same settings panel that renders `defaultThreadEnvMode` (around lines 700-740), add a sibling `SettingsRow`, mirroring that pattern exactly:

```typescript
<SettingsRow
  title="Worktree cleanup scope"
  description="Which worktrees are pre-selected when cleaning up a repository."
  resetAction={
    settings.worktreeCleanupScope !== DEFAULT_UNIFIED_SETTINGS.worktreeCleanupScope ? (
      <SettingResetButton
        label="worktree cleanup scope"
        onClick={() =>
          updateSettings({
            worktreeCleanupScope: DEFAULT_UNIFIED_SETTINGS.worktreeCleanupScope,
          })
        }
      />
    ) : null
  }
  control={
    <Select
      value={settings.worktreeCleanupScope}
      onValueChange={(value) => {
        if (value === "orphaned" || value === "orphaned-archived") {
          updateSettings({ worktreeCleanupScope: value });
        }
      }}
    >
      <SelectTrigger className="w-full sm:w-56" aria-label="Worktree cleanup scope">
        <SelectValue>
          {settings.worktreeCleanupScope === "orphaned-archived"
            ? "Orphaned + archived"
            : "Orphaned only"}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem hideIndicator value="orphaned">
          Orphaned only
        </SelectItem>
        <SelectItem hideIndicator value="orphaned-archived">
          Orphaned + archived
        </SelectItem>
      </SelectPopup>
    </Select>
  }
/>
```

- [ ] **Step 2: Typecheck**

Run (from repo root): `bun run tc`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/settings/SettingsPanels.tsx
git commit -m "feat(web): add worktree cleanup scope setting UI"
```

---

## Task 17: Archived panel — cleanup button + visible Delete button

**Files:**
- Modify: `apps/web/src/components/settings/SettingsPanels.tsx`

- [ ] **Step 1: Add a visible Delete button on archived rows**

In `ArchivedThreadsPanel`, the archived `SettingsRow` currently has `control={<Button …>Unarchive</Button>}` (around lines 1495-1519). Replace the single control with a two-button group so Delete is discoverable. `confirmAndDeleteThread` is already destructured from `useThreadActions()` (line 1343) and already used by the context-menu handler:

```typescript
control={
  <div className="flex shrink-0 items-center gap-1.5">
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 cursor-pointer gap-1.5 px-2.5 text-destructive"
      onClick={() =>
        void confirmAndDeleteThread(scopeThreadRef(thread.environmentId, thread.id)).then(() =>
          refreshArchivedThreads(),
        )
      }
    >
      <ArchiveX className="size-3.5" />
      <span>Delete</span>
    </Button>
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 cursor-pointer gap-1.5 px-2.5"
      onClick={() =>
        void unarchiveThread(scopeThreadRef(thread.environmentId, thread.id))
          .then(() => refreshArchivedThreads())
          .catch((error) => {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to unarchive thread",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          })
      }
    >
      <ArchiveX className="size-3.5" />
      <span>Unarchive</span>
    </Button>
  </div>
}
```

> Use a distinct icon for Delete if available (e.g. a `Trash` icon from `lucide-react`); `ArchiveX` is reused here only to avoid a new import. Prefer importing `Trash2` and using it for the Delete button.

- [ ] **Step 2: Add a per-project "Clean up worktrees" row + dialog state**

At the top of `ArchivedThreadsPanel`, add dialog state and access to settings + thread refs. `useSettings` is the hook this file already imports (`import { useSettings, useUpdateSettings } from "../../hooks/useSettings";`, line 34). `selectThreadsAcrossEnvironments` (store.ts:1762) returns the live `Thread[]` with `worktreePath` + `archivedAt`. Add:

```typescript
const settings = useSettings();
const liveThreads = useStore(selectThreadsAcrossEnvironments);
const [cleanupTarget, setCleanupTarget] = useState<{
  environmentId: EnvironmentId;
  cwd: string;
} | null>(null);
```

Build the `threadRefs` for the dialog by combining live threads with the archived snapshots already loaded in this panel (`archivedSnapshots`, whose `snapshot.threads` are `OrchestrationThreadShell` and carry `worktreePath`):

```typescript
const cleanupThreadRefs: WorktreeThreadRef[] = useMemo(() => {
  const live = liveThreads.map((thread) => ({
    worktreePath: thread.worktreePath,
    isArchived: thread.archivedAt !== null,
  }));
  const archived = archivedSnapshots.flatMap(({ snapshot }) =>
    snapshot.threads.map((thread) => ({ worktreePath: thread.worktreePath, isArchived: true })),
  );
  return [...live, ...archived];
}, [liveThreads, archivedSnapshots]);
```

In each project's `SettingsSection`, add a first row with the cleanup button (using the known `SettingsRow` pattern rather than modifying `SettingsSection`'s header):

```typescript
<SettingsRow
  title="Clean up worktrees"
  description="Remove managed worktrees for this repository."
  control={
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 cursor-pointer px-2.5"
      onClick={() =>
        setCleanupTarget({ environmentId: project.environmentId, cwd: project.cwd })
      }
    >
      Clean up
    </Button>
  }
/>
```

At the end of the panel's returned JSX (inside `SettingsPageContainer`), mount the dialog once:

```typescript
{cleanupTarget ? (
  <WorktreeCleanupDialog
    open
    environmentId={cleanupTarget.environmentId}
    cwd={cleanupTarget.cwd}
    scope={settings.worktreeCleanupScope}
    threadRefs={cleanupThreadRefs}
    onOpenChange={(next) => {
      if (!next) {
        setCleanupTarget(null);
        refreshArchivedThreads();
      }
    }}
  />
) : null}
```

Add the imports at the top of the file: `WorktreeCleanupDialog` from `../WorktreeCleanupDialog`, `type WorktreeThreadRef` from `../../worktreeCleanup`, `selectThreadsAcrossEnvironments` from `../../store` (the file already imports `useStore` — confirm and add the selector to that import), `useMemo`/`useState` from `react` (if not already imported), `Trash2` from `lucide-react`, and `EnvironmentId` type from `@t3tools/contracts`.

- [ ] **Step 3: Typecheck**

Run (from repo root): `bun run tc`
Expected: PASS. Resolve any selector/shape mismatches surfaced (especially `liveThreads` selector and `archivedSnapshots` thread path).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/settings/SettingsPanels.tsx
git commit -m "feat(web): add worktree cleanup + visible delete to archived panel"
```

---

## Task 18: Sidebar repo context-menu entry

**Files:**
- Modify: `apps/web/src/components/Sidebar.tsx`

- [ ] **Step 1: Add dialog state to the Sidebar host**

In the `Sidebar` component body, add state and a settings read (`useSettings` from `../hooks/useSettings`):

```typescript
const sidebarSettings = useSettings();
const [worktreeCleanupTarget, setWorktreeCleanupTarget] = useState<{
  environmentId: EnvironmentId;
  cwd: string;
} | null>(null);
```

> The sidebar does not load archived snapshots, so it passes only live-thread refs (`isArchived` from `thread.archivedAt !== null`). Under the default `orphaned` scope this is fully correct; only the `orphaned-archived` scope differs (archived-only worktrees count as orphaned from the sidebar entry). Lifting archived-snapshot loading into the sidebar is a follow-up, not part of this task.

- [ ] **Step 2: Add the context-menu item**

In `handleProjectButtonContextMenu` (the verbatim handler around lines 1427-1531), add a leaf to the menu array passed to `api.contextMenu.show`, and register its handler. Insert before the destructive "Remove project" item:

```typescript
{
  id: `cleanup-worktrees:${project.memberProjects[0]?.physicalProjectKey ?? "project"}`,
  label: "Clean up worktrees…",
},
```

And register the handler alongside the existing `actionHandlers.set(...)` calls (use the single-member project's `cwd`/`environmentId`; if grouped, use the first member):

```typescript
actionHandlers.set(
  `cleanup-worktrees:${project.memberProjects[0]?.physicalProjectKey ?? "project"}`,
  () => {
    const member = project.memberProjects[0];
    if (member) {
      setWorktreeCleanupTarget({ environmentId: member.environmentId, cwd: member.cwd });
    }
  },
);
```

> Match the exact id construction style used by `makeLeaf` (it keys ids by `physicalProjectKey`). Keep the id stable between the menu item and the `actionHandlers.set` registration.

- [ ] **Step 3: Mount the dialog**

In the Sidebar's returned JSX (near other dialogs/overlays the Sidebar renders), add:

```typescript
{worktreeCleanupTarget ? (
  <WorktreeCleanupDialog
    open
    environmentId={worktreeCleanupTarget.environmentId}
    cwd={worktreeCleanupTarget.cwd}
    scope={sidebarSettings.worktreeCleanupScope}
    threadRefs={sidebarThreadRefs}
    onOpenChange={(next) => {
      if (!next) setWorktreeCleanupTarget(null);
    }}
  />
) : null}
```

Where `sidebarThreadRefs` is built from the live thread list (`selectThreadsAcrossEnvironments`, store.ts:1762):

```typescript
const sidebarLiveThreads = useStore(selectThreadsAcrossEnvironments);
const sidebarThreadRefs: WorktreeThreadRef[] = useMemo(
  () =>
    sidebarLiveThreads.map((thread) => ({
      worktreePath: thread.worktreePath,
      isArchived: thread.archivedAt !== null,
    })),
  [sidebarLiveThreads],
);
```

Add imports: `WorktreeCleanupDialog` from `./WorktreeCleanupDialog`, `type WorktreeThreadRef` from `../worktreeCleanup`, `selectThreadsAcrossEnvironments` from `../store` (Sidebar already uses `useStore` — add the selector to that import), `useSettings` from `../hooks/useSettings`, `EnvironmentId` from `@t3tools/contracts`, and `useMemo`/`useState` from `react` if not present.

- [ ] **Step 4: Typecheck + lint**

Run (from repo root): `bun run tc`
Expected: PASS.
Run (from repo root): `bun run lint`
Expected: PASS (fix any unused-import / exhaustive-deps issues).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/Sidebar.tsx
git commit -m "feat(web): add clean up worktrees to sidebar repo menu"
```

---

## Task 19: Full verification + manual check

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run (from repo root): `bun run test`
Expected: PASS.

- [ ] **Step 2: Typecheck + lint the whole repo**

Run (from repo root): `bun run tc && bun run lint`
Expected: PASS.

- [ ] **Step 3: Manual smoke test**

Start the app (`bun run dev`) and, against a repo that has at least two managed worktrees (create them via worktree-mode threads, then archive/delete the threads):
- Open Settings → Archived Threads. Confirm each project shows a "Clean up" row and each archived thread row shows a visible Delete button.
- Click "Clean up". Confirm the dialog opens immediately, lists orphaned worktrees (per the default `orphaned` scope), shows sizes filling in, and a "Reclaimable" total.
- Create a dirty worktree (uncommitted change). Confirm it appears with a force checkbox and is deselected by default; confirm it cannot be removed without enabling force.
- Right-click a project in the sidebar → "Clean up worktrees…". Confirm the same dialog opens.
- Confirm removal: verify the worktrees are gone on disk (`git worktree list`), the toast reports freed space, and source-control state refreshes.
- Change Settings → "Worktree cleanup scope" to "Orphaned + archived" and confirm archived-only worktrees now appear pre-selected.

> If you cannot run the desktop/web app in this environment, state that explicitly and rely on the automated tests plus typecheck.

- [ ] **Step 4: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "fix(web): address worktree cleanup verification findings"
```

---

## Notes / known limitations

- **Dirty heuristic:** a worktree whose HEAD is not contained in any remote branch is treated as dirty (unpushed). For local-only branches with no remote at all, this means everything reads as dirty (force required) — a deliberately conservative default that matches the "never silently destroy unpushed work" goal.
- **Size walk:** follows symlinks and sums regular-file sizes; acceptable for an estimate. Stale (gone-on-disk) worktree registrations are filtered out of the list rather than pruned; pruning stale registrations is out of scope for this plan.
- **Sidebar archived parity:** the sidebar entry point passes only live-thread refs unless archived snapshots are also loaded there; under the default `orphaned` scope this is fully correct, and only the `orphaned-archived` scope differs (archived-only worktrees count as orphaned from the sidebar). Lift archived-snapshot loading into the sidebar as a follow-up if exact parity is desired.
