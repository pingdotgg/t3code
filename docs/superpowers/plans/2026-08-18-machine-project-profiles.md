# Machine-aware grouped project profiles Implementation Plan

> **For agentic workers:** Use this plan task-by-task with the test-first
> checkpoints below. Keep the current working-tree changes intact and do not
> commit or publish them unless Lucas explicitly asks.

**Goal:** Turn the grouped-project environment picker into a complete draft-only machine profile switcher that previews each machine's path, checkout/worktree, model, and execution settings and restores those choices per machine.

**Architecture:** Keep the existing logical-project grouping and environment
picker. Add a serializable profile map to each draft session, keyed by the

> physical `environmentId:projectId`; the draft store atomically snapshots the
> current profile and restores the selected target profile. The UI receives
> already-derived profile summaries from `ChatView`, while environment/project
> selection continues to be the only cross-machine operation.

**Tech Stack:** React/TypeScript, Effect Schema persistence in
`apps/web/src/composerDraftStore.ts`, Base UI Select, Vitest through `vp`, and
the existing T3 Code isolated browser workflow.

**Spec:** `docs/superpowers/specs/2026-08-18-machine-project-profiles-design.md`

## Global Constraints

- Environment selection remains draft-only; started threads stay pinned to
  their existing environment and project.
- Profiles are keyed by `environmentId:projectId`, never by labels or paths.
- Switching never copies a branch/worktree path to another physical project
  without a profile that belongs to that exact target key.
- Legacy draft payloads decode with an empty profile map.
- No server/WebSocket contract changes are needed.
- No live `C:\Users\lucas\.t3\userdata` access; browser verification uses the
  existing disposable test bases.
- Use focused tests/typecheck/lint only; do not run repo-wide checks.
- Write each production behavior only after its focused test has failed for the
  expected reason.

---

### Task 1: Add the pure machine-profile model and summary helpers

**Files:**

- Create: `apps/web/src/machineDraftProfile.ts`
- Test: `apps/web/src/machineDraftProfile.test.ts`

**Interfaces:**

- Consumes: `EnvironmentId`, `ProjectId`, `ModelSelection`, `ProviderInstanceId`,
  `RuntimeMode`, and `ProviderInteractionMode` from `@t3tools/contracts`.
- Produces: `MachineDraftProfile`, `MachineDraftProfileMap`,
  `physicalProjectProfileKey`, and `resolveMachineProfileSummary` for the
  draft store and toolbar.

- [ ] **Step 1: Write the failing tests**

Add tests that define the pure behavior before implementation:

```ts
import { describe, expect, it } from "vitest";

import {
  physicalProjectProfileKey,
  resolveMachineProfileSummary,
  type MachineDraftProfile,
} from "./machineDraftProfile";

const profile: MachineDraftProfile = {
  environmentId: "env-remote" as never,
  projectId: "project-remote" as never,
  branch: "feature/remote",
  worktreePath: "C:/repo/.t3/worktrees/remote",
  envMode: "worktree",
  startFromOrigin: true,
  runtimeMode: "approval-required",
  interactionMode: "plan",
  modelSelectionByProvider: {
    codex: { instanceId: "codex" as never, model: "gpt-5.4" },
  },
  activeProvider: "codex" as never,
};

describe("machine draft profiles", () => {
  it("keys profiles by physical environment and project", () => {
    expect(physicalProjectProfileKey("env-remote" as never, "project-remote" as never)).toBe(
      "env-remote:project-remote",
    );
  });

  it("summarizes a saved profile without leaking another machine's path", () => {
    expect(
      resolveMachineProfileSummary({
        workspaceRoot: "C:/repo",
        defaultModelSelection: null,
        profile,
      }),
    ).toMatchObject({
      branchLabel: "feature/remote",
      workspaceLabel: "C:/repo/.t3/worktrees/remote",
      modelLabel: "gpt-5.4",
      executionLabel: "approval-required · plan · origin",
    });
  });

  it("falls back to physical project defaults on a first visit", () => {
    expect(
      resolveMachineProfileSummary({
        workspaceRoot: "C:/repo",
        defaultModelSelection: { instanceId: "claudeAgent" as never, model: "sonnet" },
        profile: null,
      }),
    ).toMatchObject({
      branchLabel: "Current checkout",
      workspaceLabel: "Current checkout",
      modelLabel: "sonnet",
      executionLabel: "Project defaults",
    });
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
$env:VP="$env:USERPROFILE\.vite-plus\bin\vp.exe"
& $env:VP test run apps/web/src/machineDraftProfile.test.ts
```

Expected: FAIL because `apps/web/src/machineDraftProfile.ts` does not yet
export the profile key and summary helpers.

- [ ] **Step 3: Implement the minimal pure model**

Create the model with branded contract types and a map type:

```ts
export interface MachineDraftProfile {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  branch: string | null;
  worktreePath: string | null;
  envMode: DraftThreadEnvMode;
  startFromOrigin: boolean;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  activeProvider: ProviderInstanceId | null;
}

export type MachineDraftProfileMap = Record<string, MachineDraftProfile>;

export function physicalProjectProfileKey(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): string {
  return `${environmentId}:${projectId}`;
}
```

Implement `resolveMachineProfileSummary` so a saved profile supplies branch,
worktree, model, and execution labels; a first visit uses `Current checkout`,
the physical project's default model, and `Project defaults`. Keep labels plain
and short so the toolbar can render them in a compact row.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same command. Expected: all tests pass with no warnings.

- [ ] **Step 5: Refactor only after green**

Use one shared physical-key helper and keep profile summary formatting outside
React components so the UI tests can assert real values without mounting the
whole chat view.

---

### Task 2: Persist profiles and atomically switch draft contexts

**Files:**

- Modify: `apps/web/src/composerDraftStore.ts`
- Test: `apps/web/src/composerDraftStore.test.ts`

**Interfaces:**

- Consumes: `MachineDraftProfile`, `MachineDraftProfileMap`, and
  `physicalProjectProfileKey` from Task 1.
- Produces: `machineProfilesByProjectKey` on `DraftSessionState`, a persisted
  optional schema field, and `switchDraftProject(draftId, projectRef)` on the
  store.

- [ ] **Step 1: Write failing store tests**

Add tests beside the existing `setDraftThreadContext` coverage:

```ts
it("restores a draft's branch, worktree, model, and modes per machine", () => {
  const store = useComposerDraftStore.getState();
  const draftId = DraftId.make("draft-machine-profile");
  const laptopRef = scopeProjectRef(TEST_ENVIRONMENT_ID, ProjectId.make("laptop-project"));
  const miniPcRef = scopeProjectRef(OTHER_TEST_ENVIRONMENT_ID, ProjectId.make("minipc-project"));

  store.setLogicalProjectDraftThreadId("github.com/pingdotgg/t3code", laptopRef, draftId, {
    branch: "feature/laptop",
    worktreePath: "/repo/.t3/worktrees/laptop",
    envMode: "worktree",
    runtimeMode: "full-access",
    interactionMode: "default",
  });
  store.setModelSelection(draftId, {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  });

  store.switchDraftProject(draftId, miniPcRef);
  expect(store.getDraftSession(draftId)).toMatchObject({
    environmentId: OTHER_TEST_ENVIRONMENT_ID,
    projectId: "minipc-project",
    branch: null,
    worktreePath: null,
  });
  expect(store.getComposerDraft(draftId)?.modelSelectionByProvider).toEqual({});

  store.setDraftThreadContext(draftId, {
    branch: "feature/minipc",
    worktreePath: "/repo/.t3/worktrees/minipc",
    envMode: "worktree",
  });
  store.setModelSelection(draftId, {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "sonnet",
  });
  store.switchDraftProject(draftId, laptopRef);

  expect(store.getDraftSession(draftId)).toMatchObject({
    environmentId: TEST_ENVIRONMENT_ID,
    projectId: "laptop-project",
    branch: "feature/laptop",
    worktreePath: "/repo/.t3/worktrees/laptop",
    envMode: "worktree",
  });
  expect(store.getComposerDraft(draftId)?.modelSelectionByProvider).toMatchObject({
    codex: { model: "gpt-5.4" },
  });
});

it("ignores malformed legacy profile entries and keeps drafts readable", () => {
  const decoded = decodePersistedComposerDraftStore({
    version: 4,
    state: { ...legacyState, draftThreadsByThreadKey: { ...legacyState.draftThreadsByThreadKey } },
  });
  expect(decoded.draftThreadsByThreadKey["draft-1"]?.machineProfilesByProjectKey).toEqual({});
});
```

Use the existing test fixtures and reset helpers rather than creating a second
store implementation in the test.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
& $env:VP test run apps/web/src/composerDraftStore.test.ts
```

Expected: TypeScript/test failures for the missing profile field and
`switchDraftProject` method.

- [ ] **Step 3: Extend persistence with backward-compatible defaults**

Add an optional `machineProfilesByProjectKey` record to
`PersistedDraftThreadState`. Define the nested schema with nullable strings,
`DraftThreadEnvModeSchema`, `RuntimeMode`, `ProviderInteractionMode`, and the
existing model-selection record. Normalize entries during decode: require a
non-empty `environmentId`, `projectId`, `envMode`, and valid runtime/interaction
values; discard invalid entries. Use `{}` when the field is absent.

Add `machineProfilesByProjectKey: MachineDraftProfileMap` to `DraftSessionState`
and all draft constructors/normalizers. Existing payload version handling must
continue to decode old drafts without the field.

- [ ] **Step 4: Implement `switchDraftProject` atomically**

Inside the store's single `set` callback:

1. Resolve the draft by `DraftId`.
2. Build the current physical key from the draft's environment/project.
3. Snapshot current context plus the current composer draft's model map and
   active provider into `machineProfilesByProjectKey[currentKey]`.
4. Look up the target key. If present, restore its branch/worktree/env mode,
   start-from-origin, runtime/interaction values, and model map/active provider.
5. If absent, set target environment/project, clear branch/worktree and model
   overrides, preserve runtime/interaction/start-from-origin, and use the
   current env mode only when it is still meaningful.
6. Update the `logicalProjectDraftThreadKeyByLogicalProjectKey` mapping only
   through the existing draft identity path; do not create a second draft.

The method must no-op for an empty ref or a missing draft. Keep
`setDraftThreadContext` for ordinary same-machine edits, but make it update the
active profile snapshot so a later switch captures the latest branch/worktree
and mode choices.

- [ ] **Step 5: Ensure model/mode setters update the active profile source**

Do not duplicate every profile field in a second mutable store. The switch
method reads the current `DraftSessionState` and `ComposerThreadDraftState`
when it snapshots. Existing setters therefore remain the source of truth; add
only the helper needed to write the restored model map/active provider in the
same atomic state update.

- [ ] **Step 6: Run the focused tests and verify GREEN**

Run:

```powershell
& $env:VP test run apps/web/src/composerDraftStore.test.ts
```

Expected: all existing composer-draft tests plus the new profile tests pass.

- [ ] **Step 7: Refactor after green**

Extract snapshot/restore functions if the store callback becomes difficult to
read. Keep them pure and covered by the profile tests; do not broaden the
store's public API beyond the one switch method and the persisted field.

---

### Task 3: Build profile summary data in `ChatView`

**Files:**

- Modify: `apps/web/src/components/ChatView.tsx`
- Modify: `apps/web/src/components/BranchToolbar.logic.ts`
- Test: `apps/web/src/components/BranchToolbar.logic.test.ts`

**Interfaces:**

- Consumes: `logicalProjectEnvironments`, active `DraftSessionState`, the
  selected environment's provider statuses/settings, and physical project
  `workspaceRoot`/`defaultModelSelection`.
- Produces: enriched `EnvironmentOption` entries containing `workspaceRoot`,
  connection state, and a `MachineProfileSummary` suitable for rendering.

- [ ] **Step 1: Write failing summary tests**

Add pure tests for primary/remote labels, a saved profile, a first-visit
physical project default, and an unavailable environment:

```ts
it("builds a profile row from the physical project and draft profile", () => {
  const result = resolveMachineProfileSummary({
    workspaceRoot: "/repo",
    defaultModelSelection: { instanceId: "codex" as never, model: "gpt-5.4" },
    profile: {
      branch: "feature/a",
      worktreePath: "/repo/.t3/worktrees/a",
      envMode: "worktree",
      runtimeMode: "full-access",
      interactionMode: "default",
      startFromOrigin: false,
      activeProvider: "codex" as never,
      modelSelectionByProvider: {
        codex: { instanceId: "codex" as never, model: "o3" },
      },
    },
  });

  expect(result).toEqual({
    path: "/repo",
    checkout: "feature/a",
    workspace: "/repo/.t3/worktrees/a",
    model: "o3",
    execution: "Full access · Build",
    startFromOrigin: false,
  });
});
```

- [ ] **Step 2: Run the focused logic test and verify RED**

Run:

```powershell
& $env:VP test run apps/web/src/components/BranchToolbar.logic.test.ts
```

Expected: FAIL because the summary builder and enriched option type do not yet
exist.

- [ ] **Step 3: Implement summary derivation**

Add a pure `MachineProfileSummary` type and `resolveMachineProfileSummary` to
`BranchToolbar.logic.ts`. Use the active provider's selected model first, then
the physical project's default model, then `Project default`. Keep path values
raw for the `title`/accessible description and expose short labels for the
row. Use `Current checkout` when no branch/worktree profile exists.

In `ChatView`, derive profile summaries for each member project. For the active
target, use the live draft context. For previously visited targets, use the
persisted profile. For an unvisited target, use its physical project default
model and default execution labels. Pass a connection status string without
including credentials or server URLs.

- [ ] **Step 4: Run the focused logic test and verify GREEN**

Run the same command and expect all tests to pass.

- [ ] **Step 5: Refactor after green**

Keep `ChatView` responsible for joining environment/project entities with draft
state, and keep formatting/label decisions in the pure logic file.

---

### Task 4: Render the detailed machine popup

**Files:**

- Modify: `apps/web/src/components/BranchToolbarEnvironmentSelector.tsx`
- Modify: `apps/web/src/components/BranchToolbar.tsx`
- Create: `apps/web/src/components/MachineProfileRow.tsx`
- Test: `apps/web/src/components/MachineProfileRow.test.tsx`

**Interfaces:**

- Consumes: enriched `EnvironmentOption` and `MachineProfileSummary` from Task
  3, plus `envLocked` and `onEnvironmentChange`.
- Produces: accessible profile rows inside the existing Base UI `SelectPopup`.

- [ ] **Step 1: Write failing component/row tests**

Test the real summary component with a small render harness used by existing
web component tests:

```tsx
import { renderToStaticMarkup } from "react-dom/server";

it("renders path, checkout, worktree, model, and execution details", () => {
  const markup = renderToStaticMarkup(
    <MachineProfileRow
      environment={{
        label: "Mini PC",
        isPrimary: false,
        profile: {
          path: "C:/Users/lucas/Projects/t3code",
          checkout: "feature/remote",
          workspace: "C:/Users/lucas/Projects/t3code/.t3/worktrees/remote",
          model: "gpt-5.4",
          execution: "Full access · Build",
          startFromOrigin: true,
        },
        connection: "connected",
      }}
    />,
  );

  expect(markup).toContain("Mini PC");
  expect(markup).toContain("C:/Users/lucas/Projects/t3code");
  expect(markup).toContain("feature/remote");
  expect(markup).toContain("gpt-5.4");
  expect(markup).toContain("Full access");
});
```

Add an accessibility assertion that the path is available through `title` or
an equivalent accessible description when CSS truncates it.

- [ ] **Step 2: Run the focused component test and verify RED**

Run the test file through `vp test run`. Expected: FAIL because the row does
not exist.

- [ ] **Step 3: Implement the compact row**

Create `MachineProfileRow` with no card-heavy chrome: icon/label on the first
line and two compact metadata lines below. Use `title` on the path/worktree
spans, `data-slot` hooks only where needed, and visually muted labels. Show
`Unavailable` and disable the row when connection state is not connected.

Update `BranchToolbarEnvironmentSelector` to render the row as the
`SelectItem` content. Keep the existing `aria-label="Run on"`, primary/remote
icons, selected value, and `SelectPopup` collision behavior. Do not put branch
editing or model controls inside the row.

Update the mobile `MobileRunContextSelector` path to use the same row content
when the popup is open, while keeping its explicit `side="top"` menu behavior.

- [ ] **Step 4: Run the focused component test and verify GREEN**

Run the same test file and expect all row assertions to pass.

- [ ] **Step 5: Refactor after green**

Keep the row presentational. It must not read from stores or issue environment
queries; `ChatView` remains the data owner.

---

### Task 5: Wire atomic switching and machine-specific restoration

**Files:**

- Modify: `apps/web/src/components/ChatView.tsx`
- Modify: `apps/web/src/components/BranchToolbar.tsx`
- Modify: `apps/web/src/components/BranchToolbarEnvironmentSelector.tsx`
- Test: `apps/web/src/components/ChatView.logic.test.ts`

**Interfaces:**

- Consumes: `switchDraftProject` from Task 2 and enriched environment options
  from Task 3.
- Produces: a draft-only `onEnvironmentChange` callback that restores the
  selected machine profile and keeps `envLocked` as the single lock guard.

- [ ] **Step 1: Write failing callback tests**

Add tests for the pure callback decision helper (or extract one if the current
inline callback is not testable):

```ts
it("does not switch a started thread", () => {
  expect(
    resolveEnvironmentSwitch({
      envLocked: true,
      draftId: "draft-1" as never,
      nextEnvironmentId: "env-2" as never,
      environments: [{ environmentId: "env-2" as never, projectId: "project-2" as never }],
    }),
  ).toBeNull();
});

it("resolves a target physical project for an unlocked draft", () => {
  expect(
    resolveEnvironmentSwitch({
      envLocked: false,
      draftId: "draft-1" as never,
      nextEnvironmentId: "env-2" as never,
      environments: [{ environmentId: "env-2" as never, projectId: "project-2" as never }],
    }),
  ).toEqual({ environmentId: "env-2", projectId: "project-2" });
});
```

- [ ] **Step 2: Run the focused logic test and verify RED**

Run:

```powershell
& $env:VP test run apps/web/src/components/ChatView.logic.test.ts
```

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement and wire the callback**

Move the target lookup into a pure helper. In `ChatView`, call
`switchDraftProject(draftId, scopeProjectRef(target.environmentId, target.projectId))`
only when the helper returns a target. Keep the existing early return for
`envLocked` and missing `draftId`.

Pass the active draft's profile map to the summary derivation and ensure the
toolbar receives the currently selected environment id after the store update.
The current `activeProject`, `settings`, provider status, git status, model
options, terminal context, and file operations should all rebind through the
existing `environmentId`/`activeProjectRef` paths.

- [ ] **Step 4: Run the focused logic and store tests and verify GREEN**

```powershell
& $env:VP test run apps/web/src/components/ChatView.logic.test.ts apps/web/src/composerDraftStore.test.ts
```

Expected: all tests pass, including existing environment-switch behavior.

- [ ] **Step 5: Refactor after green**

Keep one switch callback and one source of truth. Do not add a second client
settings preference for the active machine; the draft profile map is scoped to
the logical project draft.

---

### Task 6: Focused verification and browser integration pass

**Files:**

- Modify only if failures require it: files from Tasks 1–5
- Test artifacts: disposable bases under `C:\Users\lucas\Desktop\Projects\__t3code-browser-test-*`

- [ ] **Step 1: Run the focused automated suite**

Run:

```powershell
& $env:VP test run `
  apps/web/src/machineDraftProfile.test.ts `
  apps/web/src/composerDraftStore.test.ts `
  apps/web/src/components/BranchToolbar.logic.test.ts `
  apps/web/src/components/MachineProfileRow.test.tsx `
  apps/web/src/components/ChatView.logic.test.ts `
  apps/web/src/environmentGrouping.test.ts
& $env:VP run --filter @t3tools/web typecheck
& $env:VP exec prettier --check apps/web/src/machineDraftProfile.ts apps/web/src/composerDraftStore.ts apps/web/src/components/BranchToolbar.logic.ts apps/web/src/components/BranchToolbarEnvironmentSelector.tsx apps/web/src/components/MachineProfileRow.tsx apps/web/src/components/BranchToolbar.tsx apps/web/src/components/ChatView.tsx
```

Run targeted lint on the changed files and `git diff --check`. Do not run the
repository-wide suite.

- [ ] **Step 2: Prepare two isolated environments**

Reuse the existing disposable browser-test bases if still healthy. Otherwise
stop only the exact processes started for this task, create fresh bases, add
the same repository to each with distinct titles, and start primary/secondary
servers with explicit `--home-dir` values. Never point either server at
`C:\Users\lucas\.t3\userdata`.

- [ ] **Step 3: Verify the complete popup in the T3 preview browser**

Use `preview_status` first, then `preview_open`/`preview_navigate` as needed.
Verify through DOM interaction and state inspection:

1. Same repository across two environments shows one grouped project.
2. `Run on` opens an anchored popup with both machine rows.
3. Each row includes path, checkout/worktree labels, model, execution settings,
   and primary/remote icon.
4. Select laptop, set a branch/worktree/model/mode, select Mini PC, set a
   different branch/worktree/model/mode, then select laptop again and verify its
   original values return.
5. Verify the draft store/local persistence contains separate profile keys and
   the eventual start payload points at the selected environment/project.
6. Navigate to a started thread and verify `Run on` is static and cannot switch.

- [ ] **Step 4: Leave the isolated browser/server state available**

Keep the successful disposable servers and browser tab alive for Lucas to
inspect. Report their localhost ports without pairing secrets. Confirm the
working tree contains only the intended implementation, tests, and plan/spec
files; do not commit or push.
