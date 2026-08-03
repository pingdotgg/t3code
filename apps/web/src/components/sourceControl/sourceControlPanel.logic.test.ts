import { describe, expect, it } from "vite-plus/test";
import type { ServerProvider, ServerSettings } from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";

import { HISTORY_COMMIT_ROW_HEIGHT, historyCommitRowHeight } from "~/lib/sourceControl/historyRows";
import { LANE_COLOR_COUNT, LANE_COLOR_INDEX_NONE } from "~/lib/sourceControl/laneGraph";

import { LANE_FALLBACK_COLOR, laneCenterX, laneColor } from "./laneGraphPalette";
import {
  actionBusyKey,
  anyPathBusy,
  BUSY_DROPPED_PRESS_TITLE,
  BUSY_KEY_SEPARATOR,
  busyPathsFromKeys,
  changeLabel,
  changesListActionPaths,
  changeLetter,
  describeWorkingCopyError,
  groupHeaderCountLabel,
  groupIsCollapsible,
  historyRowDateRank,
  historyRowElements,
  historyWidthBucket,
  isCwdDeniedError,
  isEmptyPathSelection,
  isNothingStagedError,
  isTextGenerationConfigured,
  operationGuidance,
  sourceControlPrimarySlot,
  sourceControlPrimaryVariant,
  STAGE_ALL_PATHS,
  splitDisplayPath,
  vcsStatusPushSignature,
  withBusyKey,
  workingCopyBusyKey,
} from "./sourceControlPanel.logic";

const ALL_CHANGES = [
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "untracked",
  "typechange",
  "unmerged",
] as const;

describe("status letters", () => {
  it("gives every change kind a letter and a label", () => {
    for (const change of ALL_CHANGES) {
      expect(changeLetter(change)).toHaveLength(1);
      expect(changeLabel(change).length).toBeGreaterThan(0);
    }
  });

  it("renders untracked as U rather than ?", () => {
    expect(changeLetter("untracked")).toBe("U");
  });

  it("keeps letters distinct for the six common kinds", () => {
    const letters = ["added", "modified", "deleted", "renamed", "copied", "untracked"].map(
      (change) => changeLetter(change as (typeof ALL_CHANGES)[number]),
    );
    expect(new Set(letters).size).toBe(letters.length);
  });
});

describe("splitDisplayPath", () => {
  it("splits a nested path", () => {
    expect(splitDisplayPath("src/lib/thing.ts")).toEqual({ name: "thing.ts", dir: "src/lib" });
  });

  it("leaves a root file without a directory", () => {
    expect(splitDisplayPath("README.md")).toEqual({ name: "README.md", dir: "" });
  });
});

describe("group headers", () => {
  it("shows a plain count when nothing is filtered out", () => {
    expect(groupHeaderCountLabel(4, 4)).toBe("4");
  });

  it("shows the visible subcount while filtering", () => {
    expect(groupHeaderCountLabel(9, 2)).toBe("2 of 9");
  });

  it("never lets conflicts be collapsed away", () => {
    expect(groupIsCollapsible("conflicted")).toBe(false);
    expect(groupIsCollapsible("staged")).toBe(true);
    expect(groupIsCollapsible("unstaged")).toBe(true);
  });
});

describe("operationGuidance", () => {
  it("lets the panel finish a merge", () => {
    const guidance = operationGuidance("merge");
    expect(guidance.canContinueInPanel).toBe(true);
    expect(guidance.terminalHint).toBeNull();
  });

  it("refuses to automate rebase/cherry-pick/revert continuation and names the command", () => {
    for (const operation of ["rebase", "cherry-pick", "revert"] as const) {
      const guidance = operationGuidance(operation);
      expect(guidance.canContinueInPanel).toBe(false);
      expect(guidance.terminalHint).toContain(`git ${operation} --continue`);
    }
  });
});

describe("history width buckets", () => {
  it("buckets at the documented breakpoints", () => {
    expect(historyWidthBucket(299)).toBe("xs");
    expect(historyWidthBucket(300)).toBe("sm");
    expect(historyWidthBucket(379)).toBe("sm");
    expect(historyWidthBucket(380)).toBe("md");
    expect(historyWidthBucket(459)).toBe("md");
    expect(historyWidthBucket(460)).toBe("lg");
    expect(historyWidthBucket(539)).toBe("lg");
    expect(historyWidthBucket(540)).toBe("xl");
  });

  it("adds elements monotonically as the panel widens", () => {
    const order = ["xs", "sm", "md", "lg", "xl"] as const;
    let previous = -1;
    for (const width of order) {
      const elements = historyRowElements(width);
      const score =
        Number(elements.twoLine) +
        Number(elements.shortHash) +
        Number(elements.authorName) +
        historyRowDateRank(elements.date);
      expect(score).toBeGreaterThan(previous);
      previous = score;
    }
  });

  it("agrees with historyCommitRowHeight about when a row is two lines", () => {
    for (const width of ["xs", "sm", "md", "lg", "xl"] as const) {
      const twoLineHeight =
        historyCommitRowHeight("comfort", width) === HISTORY_COMMIT_ROW_HEIGHT.comfort.twoLine;
      expect(historyRowElements(width).twoLine).toBe(twoLineHeight);
    }
  });

  it("collapses to a node-only stub at xs", () => {
    expect(historyRowElements("xs")).toEqual({
      twoLine: false,
      shortHash: false,
      authorName: false,
      date: "none",
    });
  });

  // fork: f4 redesign (M15) — the table used to promise `diffstat` and
  // `refBadges`, neither of which `WorkingCopyLogEntry` carries, so widening
  // the panel bought the author name and nothing else while the table claimed
  // otherwise. Every remaining field is something the row draws.
  it("only describes elements the commit row can actually render", () => {
    const fields = Object.keys(historyRowElements("xl")).sort();
    expect(fields).toEqual(["authorName", "date", "shortHash", "twoLine"]);
  });
});

// ─── One primary action per state (audit §8 / live-findings) ────────────────

describe("sourceControlPrimarySlot", () => {
  const base = {
    section: "changes",
    operationInProgress: false,
    canContinueInPanel: false,
    commitEnabled: false,
    syncEmphasis: false,
  } as const;

  it("gives the slot to nothing when nothing is asking for it", () => {
    expect(sourceControlPrimarySlot(base)).toBe("none");
  });

  it("gives the slot to Sync when the remote is ahead/behind and nothing else is", () => {
    expect(sourceControlPrimarySlot({ ...base, syncEmphasis: true })).toBe("sync");
  });

  it("gives the slot to Commit over Sync — Publish and Commit were both primary", () => {
    expect(sourceControlPrimarySlot({ ...base, commitEnabled: true, syncEmphasis: true })).toBe(
      "commit",
    );
  });

  it("gives the slot to Continue over everything while a merge is stopped", () => {
    expect(
      sourceControlPrimarySlot({
        ...base,
        operationInProgress: true,
        canContinueInPanel: true,
        commitEnabled: true,
        syncEmphasis: true,
      }),
    ).toBe("continue");
  });

  it("does not hand the slot to Commit while an operation is blocking the tree", () => {
    // A rebase cannot be continued from the panel, so nothing in the panel is
    // the primary: the user's next move is in the terminal.
    expect(
      sourceControlPrimarySlot({
        ...base,
        operationInProgress: true,
        canContinueInPanel: false,
        commitEnabled: true,
      }),
    ).toBe("none");
  });

  it("never gives the slot to Commit from the History tab", () => {
    expect(sourceControlPrimarySlot({ ...base, section: "history", commitEnabled: true })).toBe(
      "none",
    );
    expect(
      sourceControlPrimarySlot({
        ...base,
        section: "history",
        commitEnabled: true,
        syncEmphasis: true,
      }),
    ).toBe("sync");
  });

  it("resolves EXACTLY ONE full-strength primary in every reachable state", () => {
    const candidates = ["continue", "commit", "sync"] as const;
    for (const operationInProgress of [false, true]) {
      for (const canContinueInPanel of [false, true]) {
        for (const commitEnabled of [false, true]) {
          for (const syncEmphasis of [false, true]) {
            for (const section of ["changes", "history"] as const) {
              const slot = sourceControlPrimarySlot({
                section,
                operationInProgress,
                canContinueInPanel,
                commitEnabled,
                syncEmphasis,
              });
              const defaults = candidates.filter(
                (candidate) => sourceControlPrimaryVariant(slot, candidate) === "default",
              );
              expect(defaults.length).toBeLessThanOrEqual(1);
              if (slot !== "none") expect(defaults).toEqual([slot]);
            }
          }
        }
      }
    }
  });

  it("steps the others down without hiding them", () => {
    expect(sourceControlPrimaryVariant("commit", "sync")).toBe("outline");
    expect(sourceControlPrimaryVariant("sync", "commit")).toBe("secondary");
    expect(sourceControlPrimaryVariant("none", "continue")).toBe("secondary");
  });
});

describe("busy keys", () => {
  it("scopes a key so two rows can be busy independently", () => {
    expect(actionBusyKey("discard", "a.ts")).not.toBe(actionBusyKey("discard", "b.ts"));
    expect(actionBusyKey("sync")).toBe("sync");
  });

  it("keeps set identity when nothing changed", () => {
    const busy = new Set(["sync"]);
    expect(withBusyKey(busy, "sync", true)).toBe(busy);
    expect(withBusyKey(busy, "stage", false)).toBe(busy);
  });

  it("adds and removes", () => {
    const busy = withBusyKey(new Set<string>(), "sync", true);
    expect(busy.has("sync")).toBe(true);
    expect(withBusyKey(busy, "sync", false).has("sync")).toBe(false);
  });
});

describe("describeWorkingCopyError", () => {
  it("prefers the untruncated stderr detail over the canned message", () => {
    expect(
      describeWorkingCopyError({
        message: "The git command failed.",
        detail: "error: pathspec 'x' did not match any file(s) known to git",
      }),
    ).toContain("pathspec");
  });

  it("falls back to the message, then to a default", () => {
    expect(describeWorkingCopyError({ message: "boom" })).toBe("boom");
    expect(describeWorkingCopyError({ detail: "   ", message: "boom" })).toBe("boom");
    expect(describeWorkingCopyError({})).toBe("The git command failed.");
    expect(describeWorkingCopyError(null)).toBe("The git command failed.");
  });

  it("accepts a plain string", () => {
    expect(describeWorkingCopyError("fatal: not a git repository")).toBe(
      "fatal: not a git repository",
    );
  });
});

describe("isCwdDeniedError", () => {
  it("recognizes the one failure a retry can never fix", () => {
    expect(isCwdDeniedError({ _tag: "WorkingCopyCwdDeniedError" })).toBe(true);
    expect(isCwdDeniedError({ _tag: "VcsProcessExitError" })).toBe(false);
    expect(isCwdDeniedError("nope")).toBe(false);
  });
});

describe("lane palette", () => {
  it("gives every colorIndex in range a distinct colour", () => {
    const colors = Array.from({ length: LANE_COLOR_COUNT }, (_unused, index) => laneColor(index));
    expect(new Set(colors).size).toBe(LANE_COLOR_COUNT);
    expect(colors).not.toContain(LANE_FALLBACK_COLOR);
  });

  it("wraps at the palette size, matching the module's own cycling", () => {
    expect(laneColor(LANE_COLOR_COUNT)).toBe(laneColor(0));
    expect(laneColor(LANE_COLOR_COUNT * 3 + 5)).toBe(laneColor(5));
  });

  it("maps the lane-less node onto the muted token", () => {
    expect(laneColor(LANE_COLOR_INDEX_NONE)).toBe(LANE_FALLBACK_COLOR);
  });

  it("never returns undefined for a nonsense index", () => {
    expect(laneColor(-7)).toBe(LANE_FALLBACK_COLOR);
    expect(laneColor(1.5)).toBe(LANE_FALLBACK_COLOR);
  });

  it("spaces lane centres by one column", () => {
    expect(laneCenterX(1) - laneCenterX(0)).toBe(12);
  });
});

// fork: f4 — the commit-all rung's contract with the server.
describe("stage-all selection", () => {
  it("spells 'everything' as an empty path list, matching WorkingCopyPathsInput", () => {
    expect(STAGE_ALL_PATHS).toEqual([]);
  });

  it("treats a per-path press with nothing selected as 'nothing', not 'everything'", () => {
    expect(isEmptyPathSelection([])).toBe(true);
    expect(isEmptyPathSelection(["a.ts"])).toBe(false);
  });
});

// fork: f4 — per-row spinners in the changes list.
describe("busyPathsFromKeys", () => {
  it("projects path-scoped keys onto the paths they touch", () => {
    const busy = new Set([
      actionBusyKey("stage", ["a.ts", "b.ts"].join(BUSY_KEY_SEPARATOR)),
      actionBusyKey("resolve", "c.ts"),
    ]);
    expect([...busyPathsFromKeys(busy)].toSorted()).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("ignores the commit-all rung and the unscoped keys", () => {
    const busy = new Set([
      actionBusyKey("stage", "*"),
      actionBusyKey("commit"),
      actionBusyKey("undo-commit"),
      actionBusyKey("stash-drop", "stash@{0}"),
    ]);
    expect([...busyPathsFromKeys(busy)]).toEqual([]);
  });

  it("returns a stable empty set when nothing is busy", () => {
    expect(busyPathsFromKeys(new Set())).toBe(busyPathsFromKeys(new Set(["commit"])));
  });
});

// ─── fork: f4 AI commit message ─────────────────────────────────────────────

function provider(overrides: Partial<ServerProvider> & { instanceId: string }): ServerProvider {
  return {
    driver: "codex",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  } as ServerProvider;
}

const settingsWith = (overrides: Partial<ServerSettings>): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  ...overrides,
});

describe("isTextGenerationConfigured", () => {
  it("answers null while the server config has not arrived", () => {
    // Answering `false` here would disable the button for the first second of
    // every session; the server is the authority, so let it try.
    expect(isTextGenerationConfigured(null)).toBe(null);
  });

  it("is true when the global text generation instance is present and available", () => {
    const settings = settingsWith({});
    expect(
      isTextGenerationConfigured({
        settings,
        providers: [provider({ instanceId: settings.textGenerationModelSelection.instanceId })],
      }),
    ).toBe(true);
  });

  it("is false when the configured instance is not in the provider list", () => {
    expect(
      isTextGenerationConfigured({
        settings: settingsWith({}),
        providers: [provider({ instanceId: ProviderInstanceId.make("something-else") })],
      }),
    ).toBe(false);
  });

  it("is false when the config carries no providers at all", () => {
    expect(isTextGenerationConfigured({ settings: settingsWith({}), providers: [] })).toBe(false);
  });

  it("is false when the instance exists but is disabled", () => {
    const settings = settingsWith({});
    expect(
      isTextGenerationConfigured({
        settings,
        providers: [
          provider({
            instanceId: settings.textGenerationModelSelection.instanceId,
            enabled: false,
          }),
        ],
      }),
    ).toBe(false);
  });

  it("is false when the instance exists but its driver is unavailable", () => {
    const settings = settingsWith({});
    expect(
      isTextGenerationConfigured({
        settings,
        providers: [
          provider({
            instanceId: settings.textGenerationModelSelection.instanceId,
            availability: "unavailable",
          }),
        ],
      }),
    ).toBe(false);
  });
});

describe("isNothingStagedError", () => {
  it("recognises the server's typed refusal", () => {
    expect(isNothingStagedError({ _tag: "WorkingCopyNothingStagedError" })).toBe(true);
  });

  it("does not confuse it with any other working-copy failure", () => {
    expect(isNothingStagedError({ _tag: "VcsProcessExitError" })).toBe(false);
    expect(isNothingStagedError(null)).toBe(false);
    expect(isNothingStagedError("nothing staged")).toBe(false);
  });
});

// ─── F-08: an empty path set is "nothing", never "everything" ───────────────
//
// This is the one gate every changes-list action passes through. The defect it
// pins: the group header's "Discard all" handed the panel `[]`, and the panel
// mapped `[]` onto `actions.discard(null)` — discard the ENTIRE working copy.

describe("changesListActionPaths (F-08)", () => {
  it("resolves an empty selection to null — do nothing", () => {
    expect(changesListActionPaths([])).toBeNull();
  });

  it("never returns a sentinel that a caller could read as 'everything'", () => {
    // `STAGE_ALL_PATHS` is the wire spelling of "everything" — an empty array.
    // A changes-list action must never be able to produce it.
    expect(changesListActionPaths(STAGE_ALL_PATHS)).toBeNull();
    expect(changesListActionPaths([])).not.toEqual(STAGE_ALL_PATHS);
  });

  it("passes an explicit selection through, deduped and in order", () => {
    expect(changesListActionPaths(["b.ts", "a.ts", "b.ts"])).toEqual(["b.ts", "a.ts"]);
  });

  it("preserves a single-path selection exactly", () => {
    expect(changesListActionPaths(["src/one file.ts"])).toEqual(["src/one file.ts"]);
  });
});

describe("anyPathBusy (F-04/F-06)", () => {
  it("is true when ONE path of a bulk target is in flight", () => {
    expect(anyPathBusy(new Set(["b.ts"]), ["a.ts", "b.ts", "c.ts"])).toBe(true);
  });

  it("is false for a disjoint set and for an empty busy set", () => {
    expect(anyPathBusy(new Set(["z.ts"]), ["a.ts"])).toBe(false);
    expect(anyPathBusy(new Set<string>(), ["a.ts"])).toBe(false);
    expect(anyPathBusy(new Set(["a.ts"]), [])).toBe(false);
  });
});

describe("workingCopyBusyKey (F-06)", () => {
  // The controls read these keys; `useWorkingCopyActions` builds the same ones
  // when it runs the action. If the two ever drift, a button stops disabling
  // and its second press starts vanishing again — which is the whole defect.
  it("matches the keys the action layer builds", () => {
    expect(workingCopyBusyKey.commit()).toBe(actionBusyKey("commit"));
    expect(workingCopyBusyKey.undoCommit()).toBe(actionBusyKey("undo-commit"));
    expect(workingCopyBusyKey.abort()).toBe(actionBusyKey("abort"));
    expect(workingCopyBusyKey.stashPush()).toBe(actionBusyKey("stash-push"));
    expect(workingCopyBusyKey.stashPop("stash@{0}")).toBe(actionBusyKey("stash-pop", "stash@{0}"));
    expect(workingCopyBusyKey.stashApply("stash@{1}")).toBe(
      actionBusyKey("stash-apply", "stash@{1}"),
    );
    expect(workingCopyBusyKey.stashDrop("stash@{2}")).toBe(
      actionBusyKey("stash-drop", "stash@{2}"),
    );
    expect(workingCopyBusyKey.restoreBackup("stash@{3}")).toBe(
      actionBusyKey("restore-backup", "stash@{3}"),
    );
    expect(workingCopyBusyKey.cherryPick("abc")).toBe(actionBusyKey("cherry-pick", "abc"));
    expect(workingCopyBusyKey.revert("abc")).toBe(actionBusyKey("revert", "abc"));
    expect(workingCopyBusyKey.checkout("abc")).toBe(actionBusyKey("checkout", "abc"));
    expect(workingCopyBusyKey.reset("abc")).toBe(actionBusyKey("reset", "abc"));
    expect(workingCopyBusyKey.tag("abc")).toBe(actionBusyKey("tag", "abc"));
    expect(workingCopyBusyKey.resolve("a.ts")).toBe(actionBusyKey("resolve", "a.ts"));
  });

  it("keys the whole-working-copy discard the same way the action does", () => {
    // `discard(null)` uses the "*" scope.
    expect(workingCopyBusyKey.discardAll()).toBe(actionBusyKey("discard", "*"));
    // …and that key must NOT collide with a per-path discard.
    expect(workingCopyBusyKey.discardAll()).not.toBe(actionBusyKey("discard", "a.ts"));
  });

  it("has a title for the press that is genuinely dropped", () => {
    expect(BUSY_DROPPED_PRESS_TITLE.length).toBeGreaterThan(0);
  });
});

// F-30 — `vcsEnvironment.status` is a subscription atom, so `useAtomValue`
// yields a fresh object per stream frame. Keying the panel's re-read off object
// identity cost one `workingCopy.status` RPC per frame.
describe("vcsStatusPushSignature (F-30)", () => {
  const base = {
    refName: "main",
    aheadCount: 1,
    behindCount: 0,
    hasUpstream: true,
    hasWorkingTreeChanges: true,
    workingTree: { files: [{}, {}] },
  };

  it("is stable across frames that changed nothing the panel renders", () => {
    expect(vcsStatusPushSignature({ ...base })).toBe(vcsStatusPushSignature({ ...base }));
  });

  it("changes for every field a control actually depends on", () => {
    const signature = vcsStatusPushSignature(base);
    expect(vcsStatusPushSignature({ ...base, refName: "feature" })).not.toBe(signature);
    expect(vcsStatusPushSignature({ ...base, aheadCount: 2 })).not.toBe(signature);
    expect(vcsStatusPushSignature({ ...base, behindCount: 3 })).not.toBe(signature);
    expect(vcsStatusPushSignature({ ...base, hasUpstream: false })).not.toBe(signature);
    expect(vcsStatusPushSignature({ ...base, hasWorkingTreeChanges: false })).not.toBe(signature);
    expect(vcsStatusPushSignature({ ...base, workingTree: { files: [{}] } })).not.toBe(signature);
  });

  it("handles the pre-first-frame null without pretending it is a real state", () => {
    expect(vcsStatusPushSignature(null)).toBe("");
    expect(vcsStatusPushSignature({})).not.toBe("");
  });
});
