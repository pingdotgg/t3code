import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  attachThreadFindTimeline,
  closeThreadFind,
  findForMessageMatch,
  openThreadFind,
  openThreadFindOnQuery,
  retainThreadFindForRoute,
  setThreadFindQuery,
  useThreadFindStore,
} from "./threadFindStore";

const threadRef = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));
const otherRef = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-2"));
const threadKey = "env-1:thread-1";

function setup() {
  closeThreadFind();
  const readPosition = vi.fn(() => ({ entryId: "entry-9", occurrence: 1 }));
  return { readPosition, timeline: { threadKey, readPosition } };
}

describe("thread find store", () => {
  it("restarts an open query from the viewport of the timeline showing the thread", () => {
    const { readPosition, timeline } = setup();
    const detach = attachThreadFindTimeline(timeline);
    openThreadFind(threadKey);
    expect(useThreadFindStore.getState()).toMatchObject({ threadKey, focusRequestId: 1 });

    setThreadFindQuery(threadKey, " needle ");
    expect(readPosition).toHaveBeenLastCalledWith("needle");
    // Opening again refocuses and restarts the search from where the viewport is.
    openThreadFind(threadKey);
    expect(useThreadFindStore.getState()).toMatchObject({
      query: " needle ",
      focusRequestId: 2,
      start: { entryId: "entry-9", occurrence: 1 },
      navigationId: 2,
      requestId: 2,
    });
    detach();
  });

  it("opens a search result's find for a thread before its timeline shows it", () => {
    const { readPosition, timeline } = setup();
    const detach = attachThreadFindTimeline({ ...timeline, threadKey: "env-1:thread-2" });
    openThreadFindOnQuery(threadKey, { query: "Café", start: { entryId: "m", occurrence: 0 } });
    expect(useThreadFindStore.getState()).toMatchObject({
      threadKey,
      query: "Café",
      start: { entryId: "m", occurrence: 0 },
    });
    // Another thread's timeline does not answer for this one.
    setThreadFindQuery(threadKey, "Caf");
    expect(readPosition).not.toHaveBeenCalled();
    detach();
  });

  it("keeps find over Settings and Usage, and closes it on any other route", () => {
    setup();
    openThreadFindOnQuery(threadKey, { query: "x" });
    retainThreadFindForRoute({ modalPage: false, threadRef });
    retainThreadFindForRoute({ modalPage: true, threadRef: null });
    expect(useThreadFindStore.getState()).toMatchObject({ threadKey, query: "x" });

    retainThreadFindForRoute({ modalPage: false, threadRef: otherRef });
    expect(useThreadFindStore.getState()).toMatchObject({ threadKey: null, query: "" });

    openThreadFindOnQuery(threadKey, { query: "x" });
    retainThreadFindForRoute({ modalPage: false, threadRef: null });
    expect(useThreadFindStore.getState().threadKey).toBeNull();
  });
});

describe("findForMessageMatch", () => {
  it("opens find on the longest word as the snippet writes it, at the matched message", () => {
    expect(
      findForMessageMatch(
        { snippet: "The cafeteria, then the Café", messageId: MessageId.make("message-1") },
        "cafe",
      ),
    ).toEqual({ query: "Café", start: { entryId: "message-1", occurrence: 0 } });
    expect(findForMessageMatch({ snippet: "fix the sidebar lag" }, "fix sidebar")).toEqual({
      query: "sidebar",
    });
    // The whole query, when the snippet holds it as typed.
    expect(findForMessageMatch({ snippet: "then Vp  run dev again" }, "vp run dev")).toEqual({
      query: "Vp  run dev",
    });
  });
});
