# Provider Usage Page Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate live provider quota limits into the top of the existing Usage page and make compact sidebar indicators deep-link to the selected provider.

**Architecture:** Keep quota projection shared and settings-ordered, make the sidebar strip navigation-only, and move detail/reset ownership into a dedicated Usage-page section. Use typed `/usage` search state for selection so sidebar clicks, selector clicks, refreshes, and history navigation agree.

**Tech Stack:** React 19, TanStack Router, TypeScript, Tailwind CSS 4, Effect contracts, Vite Plus tests.

## Global Constraints

- The Usage page leads with live provider limits and retains historical token/cost reporting underneath.
- Provider selectors use the enabled-provider order from Settings.
- The compact sidebar remains `logo percentage` with no visible provider names.
- Selection is URL-backed and invalid selections fall back to the first visible provider.
- No new dependency, continuous animation, popup, sheet, or duplicated quota-fetching path.
- Reset controls remain current-Codex-only and preserve the existing authorization and idempotency guarantees.
- Desktop, responsive web, Electron-wrapped web, local, and remote connections use the same client/server contracts.

---

### Task 1: Typed Usage Selection and Shared Quota View Logic

**Files:**

- Create: `apps/web/src/components/usage/ProviderQuotaSection.logic.ts`
- Create: `apps/web/src/components/usage/ProviderQuotaSection.logic.test.ts`
- Modify: `apps/web/src/routes/usage.tsx`
- Create: `apps/web/src/routes/usage.test.ts`
- Modify: `apps/web/src/components/sidebar/ProviderUsageStrip.logic.ts`
- Modify: `apps/web/src/components/sidebar/ProviderUsageStrip.logic.test.ts`

**Interfaces:**

- Produces: `UsageSearch { readonly provider?: ProviderInstanceId }`
- Produces: `parseUsageSearch(raw: Record<string, unknown>): UsageSearch`
- Produces: `resolveSelectedProviderQuotaItem(items, requestedInstanceId): ProviderUsageStripItem | null`
- Moves the existing reset-attempt functions and types into `ProviderQuotaSection.logic.ts` without changing their signatures.

- [ ] **Step 1: Write the failing route and selection tests**

```ts
it("bounds a valid provider instance search value", () => {
  expect(parseUsageSearch({ provider: "codex-work" })).toEqual({ provider: "codex-work" });
  expect(parseUsageSearch({ provider: "" })).toEqual({});
});

it("falls back to the first settings-ordered item", () => {
  expect(resolveSelectedProviderQuotaItem(items, ProviderInstanceId.make("missing"))).toBe(
    items[0],
  );
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `vp test run apps/web/src/routes/usage.test.ts apps/web/src/components/usage/ProviderQuotaSection.logic.test.ts`

Expected: FAIL because the parser and selection helper do not exist.

- [ ] **Step 3: Implement the parser, selection helper, and reset-logic move**

```ts
export function parseUsageSearch(raw: Record<string, unknown>): UsageSearch {
  return typeof raw.provider === "string" && raw.provider.trim()
    ? {
        provider: ProviderInstanceId.make(
          raw.provider.slice(0, PROVIDER_QUOTA_IDENTIFIER_MAX_LENGTH),
        ),
      }
    : {};
}

export function resolveSelectedProviderQuotaItem(
  items: readonly ProviderUsageStripItem[],
  requestedInstanceId: ProviderInstanceId | null,
): ProviderUsageStripItem | null {
  return items.find((item) => item.instanceId === requestedInstanceId) ?? items[0] ?? null;
}
```

Configure `createFileRoute("/usage")` with `validateSearch: parseUsageSearch` and a route-local wrapper that passes `Route.useSearch().provider ?? null` into `UsagePage`, avoiding a component-to-route circular import.

- [ ] **Step 4: Run selection and existing projection tests GREEN**

Run: `vp test run apps/web/src/routes/usage.test.ts apps/web/src/components/usage/ProviderQuotaSection.logic.test.ts apps/web/src/components/sidebar/ProviderUsageStrip.logic.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/usage.tsx apps/web/src/routes/usage.test.ts apps/web/src/components/usage/ProviderQuotaSection.logic.ts apps/web/src/components/usage/ProviderQuotaSection.logic.test.ts apps/web/src/components/sidebar/ProviderUsageStrip.logic.ts apps/web/src/components/sidebar/ProviderUsageStrip.logic.test.ts
git commit -m "refactor(web): share provider quota view state"
```

### Task 2: Make the Sidebar Strip Navigate Instead of Overlay

**Files:**

- Modify: `apps/web/src/components/sidebar/ProviderUsageStrip.tsx`
- Modify: `apps/web/src/components/sidebar/ProviderUsageStrip.test.tsx`
- Modify: `apps/web/src/components/sidebar/SidebarChrome.tsx`

**Interfaces:**

- `ProviderUsageStripView` consumes `items` and `onSelect(instanceId)` only.
- `ProviderUsageStrip` navigates to `/usage` with `{ provider: instanceId }` and hash `provider-limits`.

- [ ] **Step 1: Replace overlay assertions with failing navigation-only assertions**

```ts
it("renders navigation-only quota buttons", () => {
  const markup = renderToStaticMarkup(
    <ProviderUsageStripView items={[item]} onSelect={() => {}} />,
  );
  expect(markup).not.toContain('aria-haspopup="dialog"');
  expect(markup).not.toContain('data-slot="popover-popup"');
  expect(markup).not.toContain('data-slot="sheet-popup"');
});
```

Add a mounted interaction test that clicks `Work Codex: 64% remaining, Weekly limit` and asserts the navigation call contains `/usage`, the provider instance ID, and `provider-limits`.

- [ ] **Step 2: Run the sidebar test and verify RED**

Run: `vp test run apps/web/src/components/sidebar/ProviderUsageStrip.test.tsx`

Expected: FAIL because the strip still renders Popover/Sheet details and has no navigation callback.

- [ ] **Step 3: Remove overlay/reset ownership and wire typed navigation**

Delete Popover, Sheet, AlertDialog, reset-attempt, operate-access, and small-screen branches from `ProviderUsageStrip.tsx`. Keep tooltip and compact button rendering, add `active:translate-y-px`, and invoke:

```ts
void navigate({
  to: "/usage",
  search: { provider: item.instanceId },
  hash: "provider-limits",
});
```

Close the mobile sidebar through a callback supplied by `SidebarChromeFooter` before navigation.

- [ ] **Step 4: Run the sidebar suite GREEN**

Run: `vp test run apps/web/src/components/sidebar/ProviderUsageStrip.test.tsx apps/web/src/components/sidebar/ProviderUsageStrip.logic.test.ts`

Expected: PASS with no overlay semantics.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/sidebar/ProviderUsageStrip.tsx apps/web/src/components/sidebar/ProviderUsageStrip.test.tsx apps/web/src/components/sidebar/SidebarChrome.tsx
git commit -m "refactor(web): make provider quota strip navigate"
```

### Task 3: Build the Integrated Provider Limits Section

**Files:**

- Create: `apps/web/src/components/usage/ProviderQuotaSection.tsx`
- Create: `apps/web/src/components/usage/ProviderQuotaSection.test.tsx`
- Move: `apps/web/src/components/sidebar/ProviderQuotaDetails.tsx` to `apps/web/src/components/usage/ProviderQuotaDetails.tsx`
- Move: `apps/web/src/components/sidebar/ProviderQuotaDetails.test.tsx` to `apps/web/src/components/usage/ProviderQuotaDetails.test.tsx`
- Modify: `apps/web/src/components/usage/ProviderQuotaDetails.tsx`

**Interfaces:**

- `ProviderQuotaSection` consumes `requestedInstanceId` and `onSelect(instanceId)`.
- `ProviderQuotaSectionView` consumes `items`, `selectedItem`, operate access, and quota consume command for isolated rendering tests.
- `ProviderQuotaDetails` retains the existing reset-control props but presents metrics as bars instead of popup cards.

- [ ] **Step 1: Write failing section render tests**

```tsx
it("shows settings-ordered logo percentages and one selected provider", () => {
  const markup = renderToStaticMarkup(
    <ProviderQuotaSectionView
      items={[codexItem, claudeItem]}
      selectedItem={claudeItem}
      canOperate={false}
      onSelect={() => {}}
      onConsumeReset={async () => null}
    />,
  );
  expect(markup).toContain('id="provider-limits"');
  expect(markup.indexOf("Codex")).toBeLessThan(markup.indexOf("Claude"));
  expect(markup).toContain('aria-pressed="true"');
  expect(markup).toContain("64%");
  expect(markup).toContain("Weekly limit");
});
```

Add cases for unavailable percentage, horizontally scrollable selectors, current metric bars, reset confirmation, count-only reset, stale/auth gating, and empty items returning `null`.

- [ ] **Step 2: Run the new section/detail tests and verify RED**

Run: `vp test run apps/web/src/components/usage/ProviderQuotaSection.test.tsx apps/web/src/components/usage/ProviderQuotaDetails.test.tsx`

Expected: FAIL because the section does not exist and details still use popup-card layout.

- [ ] **Step 3: Implement the section controller and visual hierarchy**

Build:

```tsx
<section id="provider-limits" className="scroll-mt-6 border-y border-border py-5">
  <div className="flex items-baseline justify-between gap-4">
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">Live allowance</p>
      <h1 className="text-lg font-semibold tracking-tight">Usage limits</h1>
    </div>
    <time className="text-xs text-muted-foreground">...</time>
  </div>
  <div className="mt-4 flex gap-2 overflow-x-auto">{selectors}</div>
  <div className="mt-5 border-t border-border pt-5">{selectedDetails}</div>
</section>
```

Each selector is a semantic button with provider logo, tabular percentage, thin `h-1` bar, `aria-pressed`, focus ring, and no continuous animation. Selected details render metric rows with label/percentage alignment, a neutral track, foreground fill clamped to 0–100%, reset time, credits, status message, and existing banked-reset actions.

Reuse `deriveVisibleOrderedProviderSettingsRows`, `buildProviderUsageStripItems`, `usePrimaryProviderQuota`, and the existing primary operate-access computation. Do not fetch independently.

- [ ] **Step 4: Run section, detail, and reset suites GREEN**

Run: `vp test run apps/web/src/components/usage/ProviderQuotaSection.test.tsx apps/web/src/components/usage/ProviderQuotaDetails.test.tsx apps/web/src/components/usage/ProviderQuotaSection.logic.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/usage/ProviderQuotaSection.tsx apps/web/src/components/usage/ProviderQuotaSection.test.tsx apps/web/src/components/usage/ProviderQuotaDetails.tsx apps/web/src/components/usage/ProviderQuotaDetails.test.tsx apps/web/src/components/usage/ProviderQuotaSection.logic.ts
git commit -m "feat(web): add live limits to usage"
```

### Task 4: Integrate the Section Above Historical Usage

**Files:**

- Modify: `apps/web/src/components/usage/UsagePage.tsx`
- Create: `apps/web/src/components/usage/UsagePage.test.tsx`
- Modify: `apps/web/src/routes/usage.tsx`

**Interfaces:**

- `UsagePage` consumes `requestedProviderId: ProviderInstanceId | null`.
- Selector changes call typed navigation with `replace: true` and preserve `#provider-limits`.

- [ ] **Step 1: Write the failing layout-order and selection tests**

Render a testable `UsagePageContent` boundary and assert:

```ts
expect(markup.indexOf('id="provider-limits"')).toBeLessThan(markup.indexOf("Raw token cost"));
expect(markup).toContain("Usage limits");
expect(markup).toContain("Processed tokens");
```

Add a route interaction test asserting selector changes update only `search.provider`, keep the Usage route, and keep the limits hash.

- [ ] **Step 2: Run the Usage page tests and verify RED**

Run: `vp test run apps/web/src/components/usage/UsagePage.test.tsx apps/web/src/routes/usage.test.ts`

Expected: FAIL because live limits are not part of the page.

- [ ] **Step 3: Mount the integrated section before historical controls/content**

Place `ProviderQuotaSection` as the first content block inside the `max-w-6xl` scroll container. Keep all current historical state, loading, coverage, charts, metrics, and tables unchanged below it. Route selection changes through:

```ts
void navigate({
  to: "/usage",
  search: { provider: instanceId },
  hash: "provider-limits",
  replace: true,
});
```

When a requested instance disappears, normalize the URL to the first visible provider without rendering an empty intermediate detail.

- [ ] **Step 4: Run integrated Usage and sidebar tests GREEN**

Run: `vp test run apps/web/src/components/usage/UsagePage.test.tsx apps/web/src/components/usage/ProviderQuotaSection.test.tsx apps/web/src/components/sidebar/ProviderUsageStrip.test.tsx apps/web/src/routes/usage.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/usage/UsagePage.tsx apps/web/src/components/usage/UsagePage.test.tsx apps/web/src/routes/usage.tsx apps/web/src/routes/usage.test.ts
git commit -m "feat(web): integrate provider limits with usage"
```

### Task 5: Focused Verification and Delivery

**Files:**

- Modify only files required by failures found in this task.

**Interfaces:**

- No new product interface; this task proves the integrated behavior and delivers it.

- [ ] **Step 1: Run all affected focused tests**

Run:

```bash
vp test run apps/web/src/routes/usage.test.ts apps/web/src/components/usage/UsagePage.test.tsx apps/web/src/components/usage/ProviderQuotaSection.logic.test.ts apps/web/src/components/usage/ProviderQuotaSection.test.tsx apps/web/src/components/usage/ProviderQuotaDetails.test.tsx apps/web/src/components/sidebar/ProviderUsageStrip.logic.test.ts apps/web/src/components/sidebar/ProviderUsageStrip.test.tsx apps/web/src/state/providerQuota.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run affected typechecks and static checks**

Run:

```bash
vp run --filter @t3tools/web typecheck
vp run --filter @t3tools/client-runtime typecheck
vp lint <changed TypeScript files>
vp fmt --check <changed files>
git diff --check fork/main..HEAD
```

Expected: exit 0; unrelated advisory suggestions may be reported but no errors.

- [ ] **Step 3: Perform the authorized integrated web verification**

Use the repository `test-t3-app` workflow with isolated worktree state. Verify desktop and narrow viewport: Settings order, logo/percentage consistency, sidebar deep link, selected-provider focus, metric bars, unavailable state, historical content below, and reset confirmation gating. Capture before/after images required by PR policy.

- [ ] **Step 4: Final review and commit any verification fixes**

Run the focused tests that cover each fix, then commit only the verified changes using a conventional `fix(web): ...` title.

- [ ] **Step 5: Rebase, push, open the PR, and babysit it**

Rebase onto the latest `fork/main`, rerun focused verification, push `t3code/integrate-provider-usage`, and open a non-draft PR against `aGamingGod1234/t3code:main` with the required problem/fix/model body and UI evidence. Poll checks and comments newer than the latest push; verify each finding, fix real issues test-first, document false positives, resolve threads, and repeat until green.

- [ ] **Step 6: Merge the authorized PR**

Once the latest commit is mergeable, required checks are green, and no actionable thread remains, merge the PR into `aGamingGod1234/t3code:main`. Confirm the merge commit and remote branch state.
