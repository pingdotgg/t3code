import { describe, it } from "bun:test";

// Living feature backlog: each web-UI capability the TUI does NOT yet implement is
// a `describe.skip` block here, so `bun test`'s "N skipped" count tracks the work
// left to port. As each ships, replace its block with real specs (alongside the
// component/logic specs) and drop the `.skip`. The effort estimate from the plan is
// noted on each block.
//
// Already shipped (covered by real specs elsewhere, NOT skipped here):
// plan↔build toggle, rename, archive/unarchive, delete, stop-session, search/filter,
// multiline composer + paste, tool-call rows, changed-files summary, working indicator.

describe.skip("Backlog — Low/Med: cycle through all pending approvals", () => {
  it("Given several pending approvals, when navigating, then each can be approved/declined in turn", () => {
    // Today ^A/^R act only on approvals[0]; needs an index + per-request navigation.
  });
});

describe.skip("Backlog — Low/Med: new-thread options (branch / worktree / runtimeMode)", () => {
  it("Given the new-thread dialog, when options are set, then createThread receives them", () => {
    // createThread already accepts these; the dialog only collects project + message.
  });
});

describe.skip("Backlog — Low/Med: proposed-plan card", () => {
  it("Given a thread with an actionable proposed plan, then its markdown renders as a card", () => {
    // Data: thread.proposedPlans[].markdown + hasActionableProposedPlan.
  });
});

describe.skip("Backlog — Med: pending multi-question user input form", () => {
  it("Given a thread awaiting user input, when answered, then respondToThreadUserInput is sent", () => {
    // Data in thread.activities; needs a small select/text form.
  });
});

describe.skip("Backlog — Med: implement plan in a new thread", () => {
  it("Given a proposed plan, when 'implement in new thread' runs, then createThread + startThreadTurn fire with sourceProposedPlan", () => {});
});

describe.skip("Backlog — Med: checkpoint revert", () => {
  it("Given a selected turn, when reverted, then revertThreadCheckpoint({turnCount}) is sent", () => {
    // Op is trivial; the turn-selection UI is the work.
  });
});

describe.skip("Backlog — Med: context-window meter", () => {
  it("Given activity usage, then a context-window meter is shown", () => {});
});

describe.skip("Backlog — Med/High: model / provider picker", () => {
  it("Given a thread, when the model is changed, then the new model selection is applied", () => {
    // Needs a provider/model registry — not present in the subscribed shell.
  });
});

describe.skip("Backlog — Med/High: turn diff viewer", () => {
  it("Given a turn diff, then it renders in a split/unified diff view", () => {
    // OpenTUI <diff> helps; fetch + map is the work.
  });
});

describe.skip("Non-goal: image / file attachments", () => {
  it("is an explicit TUI non-goal — kept here only to document the decision", () => {});
});

describe.skip("Non-goal: multiple terminals / tabs", () => {
  it("is out of scope for the single-terminal drawer — documented, not planned", () => {});
});
