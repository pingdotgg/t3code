import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_INBOX_ACTION_LABEL,
  EMPTY_INBOX_HEADLINE,
  EMPTY_INBOX_PARKED_DETAIL,
  emptyInboxCopy,
  isInboxClear,
} from "./threadInbox.ts";

describe("isInboxClear", () => {
  it("is clear only when nothing live sits above the shelves", () => {
    expect(isInboxClear({ active: 0, pinned: 0, drafts: 0 })).toBe(true);
  });

  it("is not clear while a pinned thread is on top", () => {
    // The block would otherwise say nothing is open directly under a stack of
    // pinned cards, which are unsettled work by definition.
    expect(isInboxClear({ active: 0, pinned: 1, drafts: 0 })).toBe(false);
  });

  it("is not clear while a draft is waiting", () => {
    expect(isInboxClear({ active: 0, pinned: 0, drafts: 1 })).toBe(false);
  });

  it("is not clear while the inbox itself has rows", () => {
    expect(isInboxClear({ active: 1, pinned: 0, drafts: 0 })).toBe(false);
  });

  it("ignores settled and snoozed rows, which are not passed at all", () => {
    // Guards the shape: the shelves must never gate the block, or clearing
    // your inbox would show nothing until you also emptied your history.
    expect(isInboxClear({ active: 0, pinned: 0, drafts: 0 })).toBe(true);
  });
});

describe("emptyInboxCopy", () => {
  it("congratulates without a detail when nothing is parked", () => {
    expect(emptyInboxCopy({ projectName: null, parkedCount: 0 })).toEqual({
      headline: EMPTY_INBOX_HEADLINE,
      detail: undefined,
      actionLabel: EMPTY_INBOX_ACTION_LABEL,
    });
  });

  it("adds the detail once something is settled or snoozed", () => {
    expect(emptyInboxCopy({ projectName: null, parkedCount: 3 })).toEqual({
      headline: EMPTY_INBOX_HEADLINE,
      detail: EMPTY_INBOX_PARKED_DETAIL,
      actionLabel: EMPTY_INBOX_ACTION_LABEL,
    });
  });

  it("names the project when the list is filtered to one", () => {
    expect(emptyInboxCopy({ projectName: "t3code", parkedCount: 0 }).headline).toBe(
      "You're all caught up in t3code",
    );
  });

  it("falls back to the plain headline on an empty project name", () => {
    expect(emptyInboxCopy({ projectName: "", parkedCount: 0 }).headline).toBe(EMPTY_INBOX_HEADLINE);
  });
});
