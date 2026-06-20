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
// context-window meter, cycle pending approvals (↑/↓), checkpoint revert (^K → v),
// plan/build badge on the prompt, pending user-input form,
// new-thread runtime-mode + plan/build options, turn diff viewer (^K → g),
// model/provider picker (^K → m, via server config + updateThreadMetadata),
// new-thread branch/worktree fields (Tab cycles).

describe.skip("Non-goal: image / file attachments", () => {
  it("is an explicit TUI non-goal — kept here only to document the decision", () => {});
});

describe.skip("Non-goal: multiple terminals / tabs", () => {
  it("is out of scope for the single-terminal drawer — documented, not planned", () => {});
});
