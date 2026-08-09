# Completed-PR Auto-Settle Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a cross-surface setting that disables merged/closed change-request auto-settlement so users can combine it with disabled inactivity settlement for a manual-only workflow.

**Architecture:** Extend the existing client-settings contract with a default-on boolean, make the shared `effectiveSettled` policy require that boolean, and wire every web and mobile classification call to the corresponding persisted preference. Keep orchestration and explicit lifecycle semantics unchanged; this is a focused, conflict-free replacement for the toggle portion of PR #5643.

**Tech Stack:** Effect Schema contracts, TypeScript, React/Vite web and Electron desktop, React Native mobile, Vite Plus tests.

## Global Constraints

- `sidebarAutoSettleCompletedChangeRequests` defaults to `true` for compatibility.
- `false` disables only merged/closed change-request auto-settlement; it does not disable inactivity settlement.
- Open change requests continue to block inactivity settlement.
- When this boolean is `false` and `sidebarAutoSettleAfterDays` is `null`, only an explicit Settle action settles a thread.
- Do not change settle/unsettle, pin/unpin, snooze, or activity-reset orchestration semantics.
- Cover web, desktop, iOS, and Android; desktop inherits the web surface but still needs client-settings persistence coverage.
- Keep the historical reused-branch timestamp fix in issue #4970 and out of this PR.

---

### Task 1: Add the persisted client setting

**Files:**

- Modify: `packages/contracts/src/settings.test.ts`
- Modify: `packages/contracts/src/settings.ts`
- Modify: `apps/desktop/src/settings/DesktopClientSettings.test.ts`

**Interfaces:**

- Produces: `ClientSettings.sidebarAutoSettleCompletedChangeRequests: boolean`
- Produces: `ClientSettingsPatch.sidebarAutoSettleCompletedChangeRequests?: boolean`
- Produces: `DEFAULT_SIDEBAR_AUTO_SETTLE_COMPLETED_CHANGE_REQUESTS = true`

- [ ] **Step 1: Write failing contract and persistence tests**

Add these assertions to the existing sidebar settings tests:

```ts
expect(decodeClientSettings({}).sidebarAutoSettleCompletedChangeRequests).toBe(true);

it.each([true, false])("accepts completed-PR auto-settle patches: %s", (value) => {
  const patch = decodeClientSettingsPatch({
    sidebarAutoSettleCompletedChangeRequests: value,
  });
  expect(patch.sidebarAutoSettleCompletedChangeRequests).toBe(value);
  expect(patch).not.toHaveProperty("sidebarAutoSettleAfterDays");
});
```

Add `sidebarAutoSettleCompletedChangeRequests: false` to the complete desktop test fixture so the existing persist/reload test proves the value survives disk round-tripping.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
pnpm exec vp test run packages/contracts/src/settings.test.ts apps/desktop/src/settings/DesktopClientSettings.test.ts
```

Expected: TypeScript/test failure because the new property does not exist.

- [ ] **Step 3: Implement the setting contract**

In `packages/contracts/src/settings.ts`, add:

```ts
export const DEFAULT_SIDEBAR_AUTO_SETTLE_COMPLETED_CHANGE_REQUESTS = true;
```

Add this field beside `sidebarAutoSettleAfterDays` in `ClientSettingsSchema`:

```ts
sidebarAutoSettleCompletedChangeRequests: Schema.Boolean.pipe(
  Schema.withDecodingDefault(
    Effect.succeed(DEFAULT_SIDEBAR_AUTO_SETTLE_COMPLETED_CHANGE_REQUESTS),
  ),
),
```

Add this field to `ClientSettingsPatch`:

```ts
sidebarAutoSettleCompletedChangeRequests: Schema.optionalKey(Schema.Boolean),
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the Task 1 command again. Expected: both test files pass.

- [ ] **Step 5: Commit the contract**

```bash
git add packages/contracts/src/settings.ts packages/contracts/src/settings.test.ts apps/desktop/src/settings/DesktopClientSettings.test.ts
git commit -m "feat(settings): add completed PR auto-settle preference"
```

### Task 2: Gate the shared settlement policy

**Files:**

- Modify: `packages/client-runtime/src/state/threadSettled.test.ts`
- Modify: `packages/client-runtime/src/state/threadSettled.ts`

**Interfaces:**

- Consumes: `autoSettleCompletedChangeRequests: boolean`
- Produces: required `effectiveSettled` option `autoSettleCompletedChangeRequests`

- [ ] **Step 1: Update existing calls and add failing behavior tests**

Add `autoSettleCompletedChangeRequests: true` to every existing `effectiveSettled` test call. Then add:

```ts
it("keeps completed PR threads active when completed-PR auto-settle is off", () => {
  const fresh = makeShell({ activityAt: FRESH });
  for (const changeRequestState of ["merged", "closed"] as const) {
    expect(
      effectiveSettled(fresh, {
        now: NOW,
        autoSettleAfterDays: 3,
        autoSettleCompletedChangeRequests: false,
        changeRequestState,
      }),
    ).toBe(false);
  }
});

it("supports a manual-only workflow", () => {
  const neutral = makeShell({ activityAt: STALE });
  const explicit = { ...neutral, settledOverride: "settled" as const };
  const options = {
    now: NOW,
    autoSettleAfterDays: null,
    autoSettleCompletedChangeRequests: false,
    changeRequestState: "merged" as const,
  };
  expect(effectiveSettled(neutral, options)).toBe(false);
  expect(effectiveSettled(explicit, options)).toBe(true);
});

it("still blocks inactivity settlement for an open PR when the toggle is off", () => {
  expect(
    effectiveSettled(makeShell({ activityAt: STALE }), {
      now: NOW,
      autoSettleAfterDays: 3,
      autoSettleCompletedChangeRequests: false,
      changeRequestState: "open",
    }),
  ).toBe(false);
});
```

- [ ] **Step 2: Run the policy test and verify RED**

```bash
pnpm exec vp test run packages/client-runtime/src/state/threadSettled.test.ts
```

Expected: merged/closed assertions fail because terminal states still settle unconditionally.

- [ ] **Step 3: Implement the minimal gate**

Make the option required:

```ts
readonly autoSettleCompletedChangeRequests: boolean;
```

Gate only the terminal-state branch:

```ts
if (
  options.autoSettleCompletedChangeRequests &&
  (options.changeRequestState === "merged" || options.changeRequestState === "closed")
) {
  return true;
}
```

Do not edit orchestration deciders or the meaning of `settledOverride === "active"`.

- [ ] **Step 4: Run the policy test and verify GREEN**

Run the Task 2 command. Expected: all `threadSettled` tests pass.

- [ ] **Step 5: Commit the policy**

```bash
git add packages/client-runtime/src/state/threadSettled.ts packages/client-runtime/src/state/threadSettled.test.ts
git commit -m "fix(threads): gate completed PR auto-settlement"
```

### Task 3: Wire web and desktop settings

**Files:**

- Modify: `apps/web/src/components/Sidebar.tsx`
- Modify: `apps/web/src/components/ChatView.tsx`
- Modify: `apps/web/src/hooks/useThreadActionMenu.ts`
- Modify: `apps/web/src/components/settings/SettingsPanels.tsx`
- Modify: `apps/web/src/components/settings/settingsSearch.test.ts`
- Modify: `apps/web/src/components/settings/settingsSearch.ts`

**Interfaces:**

- Consumes: `useClientSettings((settings) => settings.sidebarAutoSettleCompletedChangeRequests)`
- Produces: General settings switch with id `auto-settle-completed-pull-requests`

- [ ] **Step 1: Add a failing settings-search test**

```ts
expect(searchableSetting("auto-settle-completed-pull-requests")).toEqual({
  id: "auto-settle-completed-pull-requests",
  title: "Auto-settle completed pull requests",
});
```

- [ ] **Step 2: Run the web test and verify RED**

```bash
pnpm exec vp test run apps/web/src/components/settings/settingsSearch.test.ts
```

Expected: the settings id is absent from `SETTINGS_SEARCH_ITEMS`.

- [ ] **Step 3: Wire all web settlement callers**

Read the preference once in `Sidebar`, `ChatView`, and `useThreadActionMenu`:

```ts
const autoSettleCompletedChangeRequests = useClientSettings(
  (settings) => settings.sidebarAutoSettleCompletedChangeRequests,
);
```

Pass it to each production `effectiveSettled` call:

```ts
effectiveSettled(thread, {
  now,
  autoSettleAfterDays,
  autoSettleCompletedChangeRequests,
  changeRequestState,
});
```

Add it to affected React dependency arrays.

- [ ] **Step 4: Add the settings control and search item**

Add a General settings row beside inactivity auto-settlement:

```tsx
<SettingsRow
  {...searchableSetting("auto-settle-completed-pull-requests")}
  description="Move threads to Settled when their pull request is merged or closed. Turn this off to keep completed pull-request threads active until you settle them or the inactivity rule applies."
  control={
    <Switch
      checked={settings.sidebarAutoSettleCompletedChangeRequests}
      onCheckedChange={(checked) =>
        updateSettings({ sidebarAutoSettleCompletedChangeRequests: Boolean(checked) })
      }
      aria-label="Auto-settle completed pull requests"
    />
  }
/>
```

Add the corresponding search catalog entry targeting the General settings section containing the row. Include the setting in modified-settings/reset calculations so reset restores `true`.

- [ ] **Step 5: Run web verification**

```bash
pnpm exec vp test run apps/web/src/components/settings/settingsSearch.test.ts packages/client-runtime/src/state/threadSettled.test.ts
pnpm --filter @t3tools/web typecheck
```

Expected: focused tests and web typecheck pass.

- [ ] **Step 6: Commit the web surface**

```bash
git add apps/web/src/components/Sidebar.tsx apps/web/src/components/ChatView.tsx apps/web/src/hooks/useThreadActionMenu.ts apps/web/src/components/settings/SettingsPanels.tsx apps/web/src/components/settings/settingsSearch.ts apps/web/src/components/settings/settingsSearch.test.ts
git commit -m "feat(web): add completed PR auto-settle toggle"
```

### Task 4: Add mobile parity

**Files:**

- Create: `apps/mobile/src/features/threads/use-auto-settle-completed-change-requests.ts`
- Modify: `apps/mobile/src/persistence/mobile-preferences.test.ts`
- Modify: `apps/mobile/src/persistence/mobile-preferences.ts`
- Modify: `apps/mobile/src/features/threads/threadListV2.test.ts`
- Modify: `apps/mobile/src/features/threads/threadListV2.ts`
- Modify: `apps/mobile/src/features/home/HomeScreen.tsx`
- Modify: `apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx`
- Modify: `apps/mobile/src/features/settings/SettingsRouteScreen.tsx`

**Interfaces:**

- Produces: mobile preference `autoSettleCompletedChangeRequests?: boolean`
- Produces: `resolveAutoSettleCompletedChangeRequests({ preference, preferencesLoaded }): boolean`
- Produces: `useAutoSettleCompletedChangeRequests(): boolean`

- [ ] **Step 1: Write failing mobile preference and list tests**

Add sanitizer coverage:

```ts
expect(sanitizePreferences({ autoSettleCompletedChangeRequests: false })).toEqual({
  autoSettleCompletedChangeRequests: false,
});
expect(sanitizePreferences({ autoSettleCompletedChangeRequests: "no" } as never)).toEqual({});
```

Add list coverage that passes `autoSettleCompletedChangeRequests: false` with merged/closed PR state and expects fresh threads in the active card block. Add a second case with a stale thread and the existing inactivity window to prove it still settles from inactivity.

- [ ] **Step 2: Run mobile tests and verify RED**

```bash
pnpm exec vp test run apps/mobile/src/persistence/mobile-preferences.test.ts apps/mobile/src/features/threads/threadListV2.test.ts
```

Expected: preference/type failures and terminal PR rows still appear settled.

- [ ] **Step 3: Implement preference resolution and persistence**

Add the optional boolean to `Preferences`, preserve it only when it is a boolean in `sanitizePreferences`, and add:

```ts
export function resolveAutoSettleCompletedChangeRequests(input: {
  readonly preference: boolean | undefined;
  readonly preferencesLoaded: boolean;
}): boolean {
  if (!input.preferencesLoaded) return true;
  return input.preference ?? true;
}
```

Create the hook that reads `mobilePreferencesAtom`, defaults to `true` until loaded, and returns the resolver result.

- [ ] **Step 4: Wire lists and the mobile settings row**

Add `autoSettleCompletedChangeRequests?: boolean` to `buildThreadListV2Items`, resolve it with `!== false`, and pass it to `effectiveSettled`.

Read the hook in `HomeScreen` and `ThreadNavigationSidebar`, pass the value to their list builders, and add it to memo dependency arrays.

Add this settings switch:

```tsx
<SettingsSwitchRow
  icon="checkmark.circle"
  label="Auto-settle completed pull requests"
  value={autoSettleCompletedChangeRequests}
  onValueChange={(value) => savePreferences({ autoSettleCompletedChangeRequests: value })}
/>
```

- [ ] **Step 5: Run mobile verification**

```bash
pnpm exec vp test run apps/mobile/src/persistence/mobile-preferences.test.ts apps/mobile/src/features/threads/threadListV2.test.ts
pnpm --filter @t3tools/mobile typecheck
```

Expected: both tests and the mobile typecheck pass.

- [ ] **Step 6: Commit mobile parity**

```bash
git add apps/mobile/src/features/threads/use-auto-settle-completed-change-requests.ts apps/mobile/src/persistence/mobile-preferences.ts apps/mobile/src/persistence/mobile-preferences.test.ts apps/mobile/src/features/threads/threadListV2.ts apps/mobile/src/features/threads/threadListV2.test.ts apps/mobile/src/features/home/HomeScreen.tsx apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx apps/mobile/src/features/settings/SettingsRouteScreen.tsx
git commit -m "feat(mobile): configure completed PR auto-settlement"
```

### Task 5: Document and verify the complete fix

**Files:**

- Modify: `docs/user/thread-sidebar.md`

**Interfaces:**

- Documents: manual-only workflow using both automatic settings off

- [ ] **Step 1: Update user documentation**

Add a **Settling threads** section that states:

```md
Two independent settings can settle neutral threads automatically:

1. **Auto-settle inactive threads** moves threads after the configured quiet period.
2. **Auto-settle completed pull requests** moves threads when a linked pull request is merged or closed.

Turn both settings off to keep every thread active until you choose **Settle**. Open pull requests
continue to block inactivity settlement.
```

- [ ] **Step 2: Run all focused tests**

```bash
pnpm exec vp test run packages/contracts/src/settings.test.ts packages/client-runtime/src/state/threadSettled.test.ts apps/desktop/src/settings/DesktopClientSettings.test.ts apps/web/src/components/settings/settingsSearch.test.ts apps/mobile/src/persistence/mobile-preferences.test.ts apps/mobile/src/features/threads/threadListV2.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 3: Run targeted typechecks and formatting checks**

```bash
pnpm --filter @t3tools/contracts typecheck
pnpm --filter @t3tools/shared typecheck
pnpm --filter @t3tools/client-runtime typecheck
pnpm --filter t3 typecheck
pnpm --filter @t3tools/web typecheck
pnpm --filter @t3tools/desktop typecheck
pnpm --filter @t3tools/mobile typecheck
pnpm exec vp fmt --check
```

Expected: every targeted command exits zero. Do not run repository-wide tests or checks.

- [ ] **Step 4: Review the diff against PR #5643**

Confirm the final diff contains no changes under `apps/server/src/orchestration`, preserves the existing `active` override semantics, and includes every current production `effectiveSettled` call site.

- [ ] **Step 5: Commit documentation**

```bash
git add docs/user/thread-sidebar.md
git commit -m "docs: explain automatic thread settlement"
```

- [ ] **Step 6: Rebase and prepare upstream handoff**

Fetch and rebase on the latest `origin/main`, rerun the focused test command from Step 2, and push the branch only if the existing PR cannot be updated cleanly by its author. If a replacement PR is necessary, credit PR #5643 and link the validated review finding; otherwise provide the author with the commits and verification evidence.
