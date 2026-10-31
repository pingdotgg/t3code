/**
 * Cases for the mobile behavior eval. `bad` fails on main today and must pass once fixed;
 * `guard` passes on main and must keep passing (its issue is fixed, or does not show on iOS);
 * `control` is ordinary use that must keep passing. Each names the scenario that produces its metrics and the checks on them.
 */
import type { Check } from "./grade.ts";
import type { Pose, ScenarioName } from "./scenarios.ts";

export interface MobileBehaviorCase {
  readonly id: string;
  readonly area: "scroll" | "jank" | "composer" | "status" | "wrong-thread";
  readonly kind: "bad" | "guard" | "control";
  /** The issue or PR it came from. */
  readonly source: string;
  /** The real bad experience, or the good one a guard protects. */
  readonly experience: string;
  readonly scenario: ScenarioName;
  /** The metric the scoreboard shows. */
  readonly key: string;
  readonly checks: ReadonlyArray<Check>;
  /** Omit to run on every pose. */
  readonly poses?: ReadonlyArray<Pose>;
}

/**
 * Frame budget checks for jank cases: at most 5% of UI frames and 10% of JS frames dropped.
 * Swipe-driven cases check JS frames only: the injected swipes cost the simulator's UI thread.
 */
const smooth: ReadonlyArray<Check> = [
  { metric: "uiDroppedPct", max: 5 },
  { metric: "jsDroppedPct", max: 10 },
];

export const CASES: ReadonlyArray<MobileBehaviorCase> = [
  {
    id: "scroll-up-never-moves-backward",
    area: "scroll",
    kind: "guard",
    source: "#22350",
    experience: "Flicking up a long thread, content jerks back down toward the latest message.",
    scenario: "scrollUpLongThread",
    key: "backwardPx",
    checks: [
      { metric: "movedPx", min: 300 },
      { metric: "backwardPx", max: 24 },
    ],
  },
  {
    id: "scroll-up-never-teleports",
    area: "scroll",
    kind: "guard",
    source: "#12072",
    experience: "Dragging up a little after scroll-to-end, the viewport jumps far away.",
    scenario: "scrollUpLongThread",
    key: "largestStepPx",
    checks: [
      { metric: "movedPx", min: 300 },
      { metric: "teleports", equals: 0 },
    ],
  },
  {
    id: "streaming-stays-at-latest",
    area: "scroll",
    kind: "bad",
    source: "#15469",
    experience:
      "While a reply streams at the bottom, the thread jumps far above the latest message.",
    scenario: "streamInView",
    key: "settledFromEndPx",
    checks: [
      { metric: "settledFromEndPx", max: 64 },
      { metric: "followingAtEnd", equals: true },
    ],
  },
  {
    id: "send-in-long-thread-stays-at-end",
    area: "scroll",
    kind: "guard",
    source: "#13706",
    experience:
      "Sending in a long thread, the timeline jumps far up instead of showing the new message.",
    scenario: "sendInLongThread",
    key: "maxFromEndPx",
    checks: [
      { metric: "maxFromEndPx", max: 1500 },
      { metric: "finalFromEndPx", max: 24 },
    ],
  },
  {
    id: "background-finish-keeps-scroll",
    area: "scroll",
    kind: "guard",
    source: "#15165",
    experience: "Another thread finishing resets the open thread's scroll position.",
    scenario: "backgroundFinish",
    key: "largestStepPx",
    checks: [{ metric: "largestStepPx", max: 4 }],
  },
  {
    id: "jank-streaming-long-reply",
    area: "jank",
    kind: "bad",
    source: "#15641, #14010, #19120",
    experience: "A long reply streaming into a long thread freezes or stutters the app.",
    scenario: "streamInView",
    key: "jsDroppedPct",
    checks: smooth,
  },
  {
    id: "jank-scrolling-settled-thread",
    area: "jank",
    kind: "control",
    source: "#13925 (Android)",
    experience: "Scrolling a long settled thread drops frames.",
    scenario: "scrollUpLongThread",
    key: "jsP99Ms",
    checks: [
      { metric: "movedPx", min: 300 },
      { metric: "jsDroppedPct", max: 10 },
    ],
  },
  {
    id: "jank-scrolling-subagent-thread",
    area: "jank",
    kind: "control",
    source: "#18376 (Android)",
    experience: "Scrolling a subagent's thread is far less smooth than its parent.",
    scenario: "openSubagentThread",
    key: "jsP99Ms",
    checks: [
      { metric: "movedPx", min: 300 },
      { metric: "jsDroppedPct", max: 10 },
    ],
  },
  {
    id: "draft-survives-thread-switch",
    area: "composer",
    kind: "guard",
    source: "#17422",
    experience: "A typed draft is gone after switching threads and coming back.",
    scenario: "draftThreadSwitch",
    key: "draftKept",
    checks: [
      { metric: "draftKept", equals: true },
      { metric: "editorShowsDraft", equals: true },
    ],
  },
  {
    id: "draft-never-leaks-to-other-thread",
    area: "composer",
    kind: "guard",
    source: "#7390",
    experience: "Text typed in a streaming thread shows up in another thread's composer.",
    scenario: "draftThreadSwitch",
    key: "leakedIntoOtherEditor",
    checks: [
      { metric: "leakedIntoOtherDraft", equals: false },
      { metric: "leakedIntoOtherEditor", equals: false },
    ],
  },
  {
    id: "draft-survives-background",
    area: "composer",
    kind: "guard",
    source: "#17422, #7390",
    experience: "A typed draft is gone after the app goes to the background and back.",
    scenario: "draftBackground",
    key: "draftKept",
    checks: [
      { metric: "draftKept", equals: true },
      { metric: "editorShowsDraft", equals: true },
    ],
  },
  {
    id: "composer-clears-after-send",
    area: "composer",
    kind: "guard",
    source: "#20982",
    experience: "After sending, the message text stays in the composer.",
    scenario: "sendInLongThread",
    key: "editorCleared",
    checks: [
      { metric: "draftCleared", equals: true },
      { metric: "editorCleared", equals: true },
    ],
  },
  {
    id: "composer-tap-focuses-text",
    area: "composer",
    kind: "guard",
    source: "#24303",
    experience: "Tapping the composer's text area opens the model picker instead of the keyboard.",
    scenario: "tapComposer",
    key: "editorFocused",
    checks: [
      { metric: "stayedOnThread", equals: true },
      { metric: "editorFocused", equals: true },
    ],
  },
  {
    id: "composer-keeps-focus-after-command-pick",
    area: "composer",
    kind: "guard",
    source: "#10956",
    experience: "Picking a skill or command from the / menu closes the keyboard.",
    scenario: "skillPick",
    key: "editorFocused",
    checks: [{ metric: "editorFocused", equals: true }],
  },
  {
    id: "failed-send-is-never-silent",
    area: "composer",
    kind: "guard",
    source: "#15801",
    experience: "A send the server will reject looks sent, with no error.",
    scenario: "failedSend",
    // The cell shows which path ran: Send blocked, or a rejected send with an error.
    key: "sendBlocked",
    checks: [{ metric: "silentFailure", equals: false }],
  },
  {
    id: "working-shelf-clears-when-done",
    area: "status",
    kind: "bad",
    source: "#24901",
    experience: "A finished thread stays in the Working shelf.",
    scenario: "workingShelfFinish",
    key: "shelfCountAfter",
    checks: [
      { metric: "shelfShownWhileWorking", equals: true },
      { metric: "shelfCountAfter", equals: 0 },
      { metric: "statusAfter", equals: "ready" },
    ],
  },
  {
    id: "pending-question-shows-input",
    area: "status",
    kind: "guard",
    source: "#24901",
    experience: "A thread waiting on a question shows as Working instead of needing input.",
    scenario: "pendingQuestion",
    key: "status",
    checks: [
      { metric: "status", equals: "input" },
      { metric: "shelfCount", equals: 0 },
    ],
  },
  {
    id: "running-subagents-not-idle",
    area: "status",
    kind: "guard",
    source: "#16464, #4962",
    experience: "A thread with subagents still running looks idle in the list and the thread.",
    scenario: "subagentsRunning",
    key: "status",
    checks: [
      { metric: "status", equals: "working" },
      { metric: "threadShowsStatus", equals: true },
    ],
  },
  {
    id: "long-press-pin-pins-that-row",
    area: "wrong-thread",
    kind: "guard",
    source: "#20428",
    experience: "Pin from a row's long-press menu pins a different thread.",
    scenario: "pinFromLongPress",
    key: "targetPinned",
    checks: [
      { metric: "targetPinned", equals: true },
      { metric: "otherPinned", equals: 0 },
    ],
  },
  {
    id: "link-opens-new-thread",
    area: "wrong-thread",
    kind: "guard",
    source: "#14689 (web)",
    experience: "A link to a just-created thread redirects to another thread.",
    scenario: "linkToNewThread",
    key: "opensTarget",
    checks: [{ metric: "opensTarget", equals: true }],
  },
  {
    id: "link-opens-archived-thread",
    area: "wrong-thread",
    kind: "guard",
    source: "#16443",
    experience: "A link to an archived thread sends you Home.",
    scenario: "linkToArchivedThread",
    key: "opensTarget",
    checks: [{ metric: "opensTarget", equals: true }],
  },
  {
    id: "folded-duo-back-opens-right-thread",
    area: "wrong-thread",
    kind: "guard",
    source: "#20633",
    experience: "On a folded iPhone Duo, after going back, the next thread opens off screen.",
    scenario: "duoBackThenOpen",
    key: "titleOnScreen",
    poses: ["duo-closed"],
    checks: [
      { metric: "opensTarget", equals: true },
      { metric: "titleOnScreen", equals: true },
    ],
  },
  {
    id: "control-open-thread-from-list",
    area: "wrong-thread",
    kind: "control",
    source: "control",
    experience: "Tapping a row opens that thread.",
    scenario: "openFromList",
    key: "opensTarget",
    checks: [{ metric: "opensTarget", equals: true }],
  },
  {
    id: "control-send-reaches-server",
    area: "composer",
    kind: "control",
    source: "control",
    experience: "A message sent from the composer reaches the server once.",
    scenario: "sendInLongThread",
    key: "serverMessages",
    checks: [{ metric: "serverMessages", equals: 1 }],
  },
  {
    id: "control-streaming-reply-renders",
    area: "scroll",
    kind: "control",
    source: "control",
    experience: "A streaming reply grows in the open thread.",
    scenario: "streamInView",
    key: "contentGrewPx",
    checks: [{ metric: "contentGrewPx", min: 500 }],
  },
];
