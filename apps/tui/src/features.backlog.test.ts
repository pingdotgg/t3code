import { describe, it } from "bun:test";

// Living feature backlog: each web-UI capability the TUI does NOT yet implement is
// a `describe.skip` block here, so `bun test`'s "N skipped" count tracks the work
// left to port. As each ships, replace its block with real specs (alongside the
// component/logic specs) and drop the `.skip`. The effort estimate from the plan is
// noted on each block.
//
// Already shipped (covered by real specs elsewhere, NOT skipped here):
// plan↔build toggle, rename, archive/unarchive, delete, stop-session, search/filter,
// multiline composer + paste, tool-call rows, changed-files summary, working indicator,
// proposed-plan card, implement-plan (^Y, same thread via sourceProposedPlan),
// context-window meter, cycle pending approvals (↑/↓), checkpoint revert,
// plan/build badge on the prompt, pending user-input form,
// new-thread runtime-mode + plan/build options, per-file + all-changes turn diff viewer,
// model/provider picker (via server config + updateThreadMetadata),
// new-thread branch/worktree fields (Tab cycles), composer controls in the box
// (model-first), Shift+Tab plan/build alias, single-column icon glyphs mapped to
// web lucide icons, changed-files directory tree with collapse-all, settled-turn
// "Worked for" fold, the right-side source-control panel (^L: branch + PR
// status, Push & create PR / Commit / View PR), thread next/prev + jump (Alt+↑/↓,
// Alt+1…9), the command palette (^K — fuzzy commands folding in the thread
// actions), the right-panel Pull action, and multiple terminals per thread
// (terminal tabs — the TUI form of the web's terminal groups). See
// web-parity.test.ts for the keyboard parity table + remaining backlog.

describe.skip("Non-goal: image / file attachments", () => {
  it("is an explicit TUI non-goal — kept here only to document the decision", () => {});
});

// Multiple terminals per thread (the web's "terminal groups"): SHIPPED as tabs —
// see terminalTabs.test (add/close/cycle) and ThreadTerminalDrawer.test (tab bar).
// Only the web's split-pane *layout* within a group is out of scope (unusable in a
// single-column TUI drawer).
describe.skip("Non-goal: split-pane terminal layouts", () => {
  it("split grids don't fit a single-column TUI drawer — tabs cover the use case", () => {});
});
