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
 *
 * The §8 re-layout moved two of these surfaces — the conflicts band became the
 * panel's one status slot (`SourceControlStatusBand`) and the stash strip
 * became dialog content (`StashesPanel`) — so the assertions moved with them.
 * The per-path Ours/Theirs rungs now live on the conflicted ROW, which is where
 * `ChangeRow`'s conflict cases below cover them.
 */
import type { WorkingCopyFile, WorkingCopyStashEntry } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ChangeRow } from "./ChangeRow";
import { changesRowDomId } from "./ChangesList";
import { SourceControlStatusBand } from "./SourceControlStatusBand";
import { StashesPanel } from "./StashesSection";
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

/** Counts `disabled` attributes, which is what SSR emits for `disabled`. */
function disabledCount(markup: string): number {
  return markup.split("disabled=").length - 1;
}

function renderStashes(over: Partial<Parameters<typeof StashesPanel>[0]> = {}) {
  return renderToStaticMarkup(
    <StashesPanel
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

describe("StashesPanel busy affordance (F-06/F-09)", () => {
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

  it("shows the timestamp AND the actions, never one instead of the other", () => {
    // C6: the timestamp used to be `group-hover:hidden` and the buttons
    // `group-hover:flex`, so two different-width blocks traded places under the
    // pointer. Both are laid out now; only opacity changes.
    const markup = renderStashes();
    expect(markup).toContain("Apply");
    expect(markup).not.toContain("group-hover:hidden");
  });
});

function renderStatusBand(over: Partial<Parameters<typeof SourceControlStatusBand>[0]> = {}) {
  return renderToStaticMarkup(
    <SourceControlStatusBand
      error={null}
      onDismissError={noop}
      operation="merge"
      conflictCount={2}
      busy={false}
      abortBusy={false}
      hasMessage
      primaryVariant="default"
      onAbort={noop}
      onContinue={noop}
      {...over}
    />,
  );
}

describe("SourceControlStatusBand busy affordance (F-06/F-11)", () => {
  // Baseline: two unresolved conflicts, so exactly ONE control is disabled —
  // "Commit merge", because the merge cannot be finished yet.
  const BASELINE_DISABLED = 1;

  it("names the operation and the remaining conflicts", () => {
    const markup = renderStatusBand();
    expect(markup).toContain("Merge in progress");
    expect(markup).toContain("still conflicted");
    expect(disabledCount(markup)).toBe(BASELINE_DISABLED);
  });

  it("disables Abort while an abort is running", () => {
    const markup = renderStatusBand({ abortBusy: true });
    expect(markup).toContain("Aborting…");
    expect(disabledCount(markup)).toBe(BASELINE_DISABLED + 1);
  });

  it("F-11: Commit merge is blocked, with a reason, when the composer is empty", () => {
    const markup = renderStatusBand({ conflictCount: 0, hasMessage: false });
    expect(markup).toContain("Write a commit message");
    expect(disabledCount(markup)).toBe(1);
  });

  it("F-11: Commit merge enables once conflicts are resolved AND a message exists", () => {
    const markup = renderStatusBand({ conflictCount: 0, hasMessage: true });
    expect(markup).toContain("Commit merge");
    expect(disabledCount(markup)).toBe(0);
  });

  it("sends the user to the terminal for an operation the panel will not drive", () => {
    const markup = renderStatusBand({ operation: "rebase", conflictCount: 0 });
    expect(markup).toContain("Rebase in progress");
    expect(markup).toContain("--continue");
    expect(markup).not.toContain("Commit merge");
  });

  it("§8 D: a read error takes the one slot, ahead of an in-progress operation", () => {
    const markup = renderStatusBand({ error: "fatal: not a git repository" });
    expect(markup).toContain("could not be read");
    expect(markup).toContain("fatal: not a git repository");
    expect(markup).not.toContain("Merge in progress");
  });

  it("renders nothing at all when there is neither an error nor an operation", () => {
    expect(renderStatusBand({ operation: null })).toBe("");
  });
});

function renderChangeRow(
  over: {
    busy?: boolean;
    group?: "unstaged" | "staged" | "conflicted";
    showDirectory?: boolean;
  } = {},
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
      showDirectory={over.showDirectory ?? true}
      indentPx={12}
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

  it("C5/C6: the row actions are in the markup before anything hovers them", () => {
    // They used to be `hidden group-hover:flex`, i.e. absent from the DOM and
    // from the a11y tree until a mouse arrived — so on a touch device Stage,
    // Unstage and Discard did not exist at all.
    const staged = renderChangeRow({ group: "staged" });
    expect(staged).toContain('aria-label="Unstage"');
    expect(staged).not.toContain("group-hover:flex");
  });

  it("omits the redundant directory label in tree mode", () => {
    const flat = renderChangeRow({ showDirectory: true });
    const tree = renderChangeRow({ showDirectory: false });

    expect(flat).toContain("<bdi");
    expect(flat).not.toContain("lucide-file");
    expect(tree).not.toContain("<bdi");
    expect(tree).toContain("lucide-file");
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
