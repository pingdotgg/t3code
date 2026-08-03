/**
 * F-04 / F-06 — the busy contract, pinned in rendered markup.
 *
 * The defect these exist for: `useWorkingCopyActions.run` drops any press whose
 * busy key is already in flight and returns `null`, and NOT ONE of the ~25
 * controls it governs rendered a disabled state. `actions.isBusy` was exported
 * with zero call sites and `busyPaths` was plumbed into `ChangeRow` and used
 * only to lower opacity. So the panel was full of enabled, hover-highlighted
 * buttons that silently discarded the press.
 *
 * The rule these pin: a control governed by a busy key renders `disabled` while
 * that key is in flight. "Accepted and dropped" is never allowed to look
 * identical to "accepted and running".
 */
import type { WorkingCopyFile, WorkingCopyStashEntry } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ChangeRow } from "./ChangeRow";
import { changesRowDomId } from "./ChangesList";
import { ConflictsSection } from "./ConflictsSection";
import { StashesSection } from "./StashesSection";
import { workingCopyBusyKey } from "./sourceControlPanel.logic";

const noop = () => undefined;

function stash(index: number, ref: string): WorkingCopyStashEntry {
  return {
    index,
    ref,
    label: `stash ${ref}`,
    branch: "main",
    createdAt: "2026-08-01T00:00:00.000Z",
    isDiscardBackup: false,
  };
}

function conflicted(path: string): WorkingCopyFile {
  return { path, area: "conflicted", change: "unmerged" };
}

/** Counts `disabled` attributes, which is what SSR emits for `disabled`. */
function disabledCount(markup: string): number {
  return markup.split("disabled=").length - 1;
}

function renderStashes(over: Partial<Parameters<typeof StashesSection>[0]> = {}) {
  return renderToStaticMarkup(
    <StashesSection
      open
      onToggle={noop}
      stashes={[stash(0, "stash@{0}"), stash(1, "stash@{1}")]}
      backups={[]}
      isLoading={false}
      listReady
      isBusy={() => false}
      dirty
      onStash={noop}
      onPopLatest={noop}
      onApply={noop}
      onDrop={noop}
      onRestoreBackup={noop}
      {...over}
    />,
  );
}

describe("StashesSection busy affordance (F-06/F-09)", () => {
  it("leaves every rung live when nothing is in flight", () => {
    const markup = renderStashes();
    expect(markup).toContain("Pop");
    expect(disabledCount(markup)).toBe(0);
  });

  it("disables Pop — and only Pop — while the latest stash is popping", () => {
    const markup = renderStashes({
      isBusy: (key) => key === workingCopyBusyKey.stashPop("stash@{0}"),
    });
    expect(markup).toContain("Popping…");
    expect(disabledCount(markup)).toBe(1);
  });

  it("disables Apply for exactly the row whose ref is in flight", () => {
    const markup = renderStashes({
      isBusy: (key) => key === workingCopyBusyKey.stashApply("stash@{1}"),
    });
    // One disabled Apply, and the other row's Apply/Drop stay live.
    expect(disabledCount(markup)).toBe(1);
  });

  it("disables Drop for exactly the row whose ref is in flight", () => {
    const markup = renderStashes({
      isBusy: (key) => key === workingCopyBusyKey.stashDrop("stash@{0}"),
    });
    expect(disabledCount(markup)).toBe(1);
  });

  it("disables Stash… while a stash push is running", () => {
    const markup = renderStashes({
      isBusy: (key) => key === workingCopyBusyKey.stashPush(),
    });
    expect(disabledCount(markup)).toBe(1);
  });

  it("F-09: Pop is disabled while the stash list has not resolved", () => {
    // The old code read `stashQuery.data?.find(...)` inside the click handler
    // and fell through an `if` with no else, while `disabled` was computed from
    // the same possibly-null list — so it was enabled exactly when it was stale.
    const markup = renderStashes({ listReady: false });
    expect(disabledCount(markup)).toBeGreaterThan(0);
  });
});

function renderConflicts(over: Partial<Parameters<typeof ConflictsSection>[0]> = {}) {
  return renderToStaticMarkup(
    <ConflictsSection
      operation="merge"
      files={[conflicted("a.ts"), conflicted("b.ts")]}
      busy={false}
      busyPaths={new Set<string>()}
      abortBusy={false}
      hasMessage
      onResolve={noop}
      onOpen={noop}
      onAbort={noop}
      onContinue={noop}
      {...over}
    />,
  );
}

describe("ConflictsSection busy affordance (F-06/F-11)", () => {
  // Baseline: two unresolved conflicts, so exactly ONE control is disabled —
  // "Commit merge", because the merge cannot be finished yet.
  const BASELINE_DISABLED = 1;

  it("keeps Ours/Theirs live for a path with nothing in flight", () => {
    const markup = renderConflicts();
    expect(markup).toContain("Ours");
    expect(disabledCount(markup)).toBe(BASELINE_DISABLED);
  });

  it("disables Ours/Theirs for exactly the path being resolved", () => {
    const markup = renderConflicts({ busyPaths: new Set(["a.ts"]) });
    // Two buttons on one of the two rows; the other row stays live.
    expect(disabledCount(markup)).toBe(BASELINE_DISABLED + 2);
  });

  it("disables Abort while an abort is running", () => {
    const markup = renderConflicts({ abortBusy: true });
    expect(markup).toContain("Aborting…");
    expect(disabledCount(markup)).toBe(BASELINE_DISABLED + 1);
  });

  it("F-11: Commit merge is blocked, with a reason, when the composer is empty", () => {
    const markup = renderConflicts({ files: [], hasMessage: false });
    expect(markup).toContain("Write a commit message");
    expect(disabledCount(markup)).toBe(1);
  });

  it("F-11: Commit merge enables once conflicts are resolved AND a message exists", () => {
    const markup = renderConflicts({ files: [], hasMessage: true });
    expect(markup).toContain("Commit merge");
    expect(disabledCount(markup)).toBe(0);
  });

  it("names the remaining conflicts rather than just greying the button out", () => {
    const markup = renderConflicts({ hasMessage: true });
    expect(markup).toContain("still conflicted");
  });
});

function renderChangeRow(
  over: { busy?: boolean; group?: "unstaged" | "staged" | "conflicted" } = {},
) {
  const group = over.group ?? "unstaged";
  const file: WorkingCopyFile = {
    path: "src/a.ts",
    area: group === "conflicted" ? "conflicted" : group,
    change: group === "conflicted" ? "unmerged" : "modified",
  };
  return renderToStaticMarkup(
    <ChangeRow
      row={{ key: `${group}-src/a.ts`, kind: "file", group, depth: 0, file }}
      domId="sc-row-test"
      selected={false}
      focused={false}
      partial={false}
      busy={over.busy ?? false}
      indentPx={0}
      onSelect={noop}
      onOpen={noop}
      onStage={noop}
      onUnstage={noop}
      onDiscard={noop}
      onResolve={noop}
    />,
  );
}

describe("ChangeRow busy affordance (F-06)", () => {
  it("keeps Stage and Discard live when the path is idle", () => {
    const markup = renderChangeRow();
    expect(markup).toContain('aria-label="Stage"');
    expect(markup).toContain('aria-label="Discard"');
    expect(disabledCount(markup)).toBe(0);
  });

  it("disables BOTH row rungs while that path's action is in flight", () => {
    // The old row only lowered opacity (`opacity-64`) and left the buttons live,
    // so the second press was accepted and then dropped by the busy guard.
    const markup = renderChangeRow({ busy: true });
    expect(disabledCount(markup)).toBe(2);
    expect(markup).toContain('aria-busy="true"');
  });

  it("disables the three conflict rungs while that path resolves", () => {
    const markup = renderChangeRow({ group: "conflicted", busy: true });
    // Stage + Accept current + Accept incoming + Mark resolved.
    expect(disabledCount(markup)).toBe(4);
  });

  it("carries the DOM id the listbox points aria-activedescendant at", () => {
    expect(renderChangeRow()).toContain('id="sc-row-test"');
  });
});

describe("changesRowDomId (focus model)", () => {
  it("produces a selector-safe id for keys with slashes and spaces", () => {
    const id = changesRowDomId("unstaged-src/a folder/b.ts");
    expect(id).toMatch(/^sc-row-[0-9a-f]{8}$/);
  });

  it("is stable and distinct per row key", () => {
    expect(changesRowDomId("unstaged-a.ts")).toBe(changesRowDomId("unstaged-a.ts"));
    expect(changesRowDomId("unstaged-a.ts")).not.toBe(changesRowDomId("staged-a.ts"));
  });
});
