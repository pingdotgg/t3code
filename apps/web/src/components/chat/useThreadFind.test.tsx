import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  RunId,
  ThreadId,
  type OrchestrationV2SearchThreadInput,
  type OrchestrationV2SearchThreadResult,
} from "@t3tools/contracts";
import { useThreadFind } from "./useThreadFind";
import { orchestrationEnvironment } from "~/state/orchestration";
import { requestThreadFindOpen } from "./threadFindActionBus";

const queries = vi.hoisted(() => ({
  results: new Map<string, OrchestrationV2SearchThreadResult>(),
  pending: false,
  refresh: vi.fn(),
}));
vi.mock("~/state/orchestration", () => ({
  orchestrationEnvironment: {
    threadFindProgressive: vi.fn(
      (input: { environmentId: EnvironmentId; input: OrchestrationV2SearchThreadInput }) => input,
    ),
    threadFind: vi.fn(
      (input: { environmentId: EnvironmentId; input: OrchestrationV2SearchThreadInput }) => input,
    ),
  },
}));
vi.mock("~/state/queries", () => ({ useDebouncedValue: <T,>(value: T) => value }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: { environmentId: EnvironmentId } | null) => ({
    data: atom === null ? null : (queries.results.get(atom.environmentId) ?? null),
    isPending: queries.pending,
    error: null,
    refresh: queries.refresh,
  }),
}));

vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

let renderer: ReactTestRenderer | undefined;
let find: ReturnType<typeof useThreadFind>;
const a = EnvironmentId.make("environment:a");
const b = EnvironmentId.make("environment:b");
const threadId = ThreadId.make("shared-thread");
const runId = RunId.make("run:plan");
function Probe({
  environmentId,
  enabled = true,
  progressive = false,
  content,
}: {
  environmentId: EnvironmentId;
  enabled?: boolean;
  progressive?: boolean;
  content?: Parameters<typeof useThreadFind>[0]["content"];
}) {
  const state = useThreadFind({
    thread: { environmentId, threadId },
    enabled,
    progressive,
    content,
  });
  useLayoutEffect(() => {
    find = state;
  });
  return null;
}
beforeEach(() => {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  queries.results.clear();
  queries.pending = false;
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("V2 find state", () => {
  function messageResult(index: number, snapshotSequence = 9): OrchestrationV2SearchThreadResult {
    return {
      snapshotSequence,
      totalMatches: 10,
      activeIndex: index,
      match: { entryId: `message:${index + 2}`, runId, occurrence: 0 },
    };
  }

  it("reveals an early match and updates its count without requesting another jump", async () => {
    await act(async () => {
      renderer = create(<Probe environmentId={a} progressive />);
    });
    await act(async () => find.open());
    await act(async () => find.barProps.onQueryChange("needle"));
    const partial: OrchestrationV2SearchThreadResult = {
      complete: false,
      snapshotSequence: 9,
      totalMatches: 1,
      activeIndex: 0,
      match: { entryId: "early", runId, occurrence: 2 },
    };
    queries.pending = true;
    queries.results.set(a, partial);
    await act(async () => renderer?.update(<Probe environmentId={a} progressive />));
    expect(find.barProps.counting).toBe(true);
    expect(find.barProps.status).toBeNull();
    expect(find.timelineProps.activeFindMatch).toEqual(partial.match);
    const match = find.timelineProps.activeFindMatch;
    const navigationId = find.timelineProps.findNavigationId;
    const requests = vi.mocked(orchestrationEnvironment.threadFindProgressive).mock.calls.length;
    await act(async () => {
      find.barProps.onNext();
      find.barProps.onPrevious();
    });
    expect(orchestrationEnvironment.threadFindProgressive).toHaveBeenCalledTimes(requests);
    queries.results.set(a, { ...partial, complete: true, totalMatches: 123, activeIndex: 42 });
    await act(async () => renderer?.update(<Probe environmentId={a} progressive />));
    expect(find.barProps.counting).toBe(false);
    expect(find.barProps.matchCount).toBe(123);
    expect(find.barProps.activeIndex).toBe(42);
    expect(find.timelineProps.activeFindMatch).toBe(match);
    expect(find.timelineProps.findNavigationId).toBe(navigationId);
    expect(orchestrationEnvironment.threadFind).not.toHaveBeenCalled();
    queries.pending = false;
    await act(async () => renderer?.update(<Probe environmentId={a} progressive />));
    await act(async () => find.barProps.onNext());
    expect(orchestrationEnvironment.threadFindProgressive).toHaveBeenCalledTimes(requests + 1);
  });

  it("coalesces incoming pages until the progressive scan finishes", async () => {
    vi.useFakeTimers();
    queries.pending = true;
    await act(async () => {
      renderer = create(<Probe environmentId={a} progressive />);
    });
    await act(async () => find.open());
    await act(async () => find.barProps.onQueryChange("needle"));
    queries.results.set(a, { ...messageResult(0), complete: false, totalMatches: 1 });
    const content = { visibleTurnItems: [], runs: [] };
    await act(async () =>
      renderer?.update(<Probe environmentId={a} progressive content={content} />),
    );
    const requests = vi.mocked(orchestrationEnvironment.threadFindProgressive).mock.calls.length;
    await act(async () => vi.advanceTimersByTime(300));
    expect(orchestrationEnvironment.threadFindProgressive).toHaveBeenCalledTimes(requests);
    expect(queries.refresh).not.toHaveBeenCalled();
    queries.results.set(a, messageResult(0));
    queries.pending = false;
    await act(async () =>
      renderer?.update(<Probe environmentId={a} progressive content={content} />),
    );
    expect(orchestrationEnvironment.threadFindProgressive).toHaveBeenCalledTimes(requests + 1);
    expect(orchestrationEnvironment.threadFindProgressive).toHaveBeenLastCalledWith({
      environmentId: a,
      input: {
        threadId,
        query: "needle",
        skills: [],
        start: { entryId: "message:2", occurrence: 0 },
      },
    });
    expect(find.timelineProps.activeFindMatch?.entryId).toBe("message:2");
  });

  it("requests a fresh jump when the same search wraps to the same match from a new position", async () => {
    queries.results.set(a, messageResult(0));
    await act(async () => {
      renderer = create(<Probe environmentId={a} />);
    });
    await act(async () => find.open());
    find.timelineProps.findPositionReaderRef.current = () => ({
      entryId: "reading",
      occurrence: 0,
    });
    await act(async () => find.barProps.onQueryChange("COD4"));
    const firstNavigationId = find.timelineProps.findNavigationId;
    const firstMatch = find.timelineProps.activeFindMatch;
    find.timelineProps.findPositionReaderRef.current = () => ({ entryId: "bottom", occurrence: 0 });
    await act(async () => find.barProps.onQueryChange("COD4"));
    expect(find.timelineProps.findNavigationId).toBeGreaterThan(firstNavigationId);
    expect(find.timelineProps.activeFindMatch).toEqual(firstMatch);
    expect(orchestrationEnvironment.threadFind).toHaveBeenLastCalledWith({
      environmentId: a,
      input: { threadId, query: "COD4", skills: [], start: { entryId: "bottom", occurrence: 0 } },
    });
    const repeatedNavigationId = find.timelineProps.findNavigationId;
    find.timelineProps.findPositionReaderRef.current = () => ({
      entryId: "new-bottom",
      occurrence: 0,
    });
    await act(async () => requestThreadFindOpen());
    expect(find.timelineProps.findNavigationId).toBeGreaterThan(repeatedNavigationId);
    expect(find.timelineProps.activeFindMatch).toEqual(firstMatch);
    expect(orchestrationEnvironment.threadFind).toHaveBeenLastCalledWith({
      environmentId: a,
      input: {
        threadId,
        query: "COD4",
        skills: [],
        start: { entryId: "new-bottom", occurrence: 0 },
      },
    });
  });

  it("cycles cached entries immediately, wraps, and accumulates clicks in one event", async () => {
    const initial = {
      ...messageResult(0),
      totalMatches: 5,
      match: { entryId: "first", runId, occurrence: 0 },
      navigation: [
        { entryId: "first", runId, startIndex: 0, count: 3 },
        { entryId: "second", runId, startIndex: 3, count: 2 },
      ],
    };
    queries.results.set(a, initial);
    await act(async () => {
      renderer = create(<Probe environmentId={a} />);
    });
    await act(async () => find.open());
    await act(async () => find.barProps.onQueryChange("COD4"));
    const requests = vi.mocked(orchestrationEnvironment.threadFind).mock.calls.length;
    await act(async () => {
      find.barProps.onNext();
      find.barProps.onNext();
    });
    expect(find.barProps.activeIndex).toBe(2);
    expect(find.timelineProps.activeFindMatch).toEqual({ entryId: "first", runId, occurrence: 2 });
    expect(find.timelineProps.findNavigationId).toBe(3);
    await act(async () => find.barProps.onNext());
    expect(find.timelineProps.activeFindMatch).toEqual({ entryId: "second", runId, occurrence: 0 });
    await act(async () => {
      find.barProps.onNext();
      find.barProps.onNext();
    });
    expect(find.barProps.activeIndex).toBe(0);
    await act(async () => find.barProps.onPrevious());
    expect(find.barProps.activeIndex).toBe(4);
    expect(find.timelineProps.activeFindMatch).toEqual({ entryId: "second", runId, occurrence: 1 });
    expect(orchestrationEnvironment.threadFind).toHaveBeenCalledTimes(requests);
    expect(queries.refresh).not.toHaveBeenCalled();
  });

  it("does not let an older background response undo a cached step", async () => {
    const initial = {
      ...messageResult(0),
      match: { entryId: "first", runId, occurrence: 0 },
      navigation: [{ entryId: "first", runId, startIndex: 0, count: 3 }],
    };
    queries.results.set(a, initial);
    await act(async () => {
      renderer = create(<Probe environmentId={a} />);
    });
    await act(async () => find.open());
    await act(async () => find.barProps.onQueryChange("COD4"));
    const requests = vi.mocked(orchestrationEnvironment.threadFind).mock.calls.length;
    await act(async () => find.barProps.onNext());
    queries.results.set(a, {
      ...initial,
      snapshotSequence: 10,
      totalMatches: 11,
      activeIndex: 1,
      navigation: [{ entryId: "first", runId, startIndex: 1, count: 3 }],
    });
    await act(async () => renderer?.update(<Probe environmentId={a} />));
    expect(find.timelineProps.activeFindMatch).toEqual({ entryId: "first", runId, occurrence: 1 });
    expect(find.barProps.activeIndex).toBe(2);
    expect(find.barProps.matchCount).toBe(11);
    expect(find.timelineProps.findNavigationId).toBe(2);
    await act(async () => find.barProps.onNext());
    expect(find.timelineProps.activeFindMatch?.occurrence).toBe(2);
    expect(find.barProps.activeIndex).toBe(3);
    expect(orchestrationEnvironment.threadFind).toHaveBeenCalledTimes(requests);
  });

  it("fetches the next window from the locally selected match and retains it while pending", async () => {
    const initial = {
      ...messageResult(0),
      match: { entryId: "first", runId, occurrence: 0 },
      navigation: [{ entryId: "first", runId, startIndex: 0, count: 2 }],
    };
    queries.results.set(a, initial);
    await act(async () => {
      renderer = create(<Probe environmentId={a} />);
    });
    await act(async () => find.open());
    await act(async () => find.barProps.onQueryChange("COD4"));
    await act(async () => find.barProps.onNext());
    expect(find.timelineProps.activeFindMatch?.occurrence).toBe(1);
    queries.pending = true;
    queries.results.delete(a);
    await act(async () => {
      find.barProps.onNext();
      find.barProps.onNext();
    });
    expect(orchestrationEnvironment.threadFind).toHaveBeenLastCalledWith({
      environmentId: a,
      input: {
        threadId,
        query: "COD4",
        skills: [],
        start: { entryId: "first", occurrence: 1 },
        offset: 2,
      },
    });
    expect(find.barProps.activeIndex).toBe(1);
    expect(find.timelineProps.findNavigationId).toBe(2);
    queries.pending = false;
    queries.results.set(a, messageResult(3));
    await act(async () => renderer?.update(<Probe environmentId={a} />));
    expect(find.barProps.activeIndex).toBe(3);
    expect(find.timelineProps.findNavigationId).toBe(4);
  });

  it("refreshes around the cached selection when live matches are inserted before it", async () => {
    vi.useFakeTimers();
    const initial = {
      ...messageResult(0),
      match: { entryId: "first", runId, occurrence: 0 },
      navigation: [
        { entryId: "first", runId, startIndex: 0, count: 1 },
        { entryId: "second", runId, startIndex: 1, count: 1 },
      ],
    };
    queries.results.set(a, initial);
    await act(async () => {
      renderer = create(<Probe environmentId={a} />);
    });
    await act(async () => find.open());
    await act(async () => find.barProps.onQueryChange("COD4"));
    await act(async () => find.barProps.onNext());
    expect(find.timelineProps.activeFindMatch?.entryId).toBe("second");
    const content = { runs: [], visibleTurnItems: [] };
    await act(async () => renderer?.update(<Probe environmentId={a} content={content} />));
    await act(async () => vi.advanceTimersByTime(300));
    expect(orchestrationEnvironment.threadFind).toHaveBeenLastCalledWith({
      environmentId: a,
      input: { threadId, query: "COD4", skills: [], start: { entryId: "second", occurrence: 0 } },
    });
    queries.results.set(a, {
      ...initial,
      snapshotSequence: 10,
      totalMatches: 11,
      activeIndex: 2,
      match: { entryId: "second", runId, occurrence: 0 },
      navigation: [
        { entryId: "inserted", runId, startIndex: 1, count: 1 },
        { entryId: "second", runId, startIndex: 2, count: 1 },
      ],
    });
    await act(async () => renderer?.update(<Probe environmentId={a} content={content} />));
    expect(find.barProps.matchCount).toBe(11);
    expect(find.barProps.activeIndex).toBe(2);
    expect(find.timelineProps.activeFindMatch?.entryId).toBe("second");
    expect(find.timelineProps.findNavigationId).toBe(2);
    await act(async () => find.barProps.onPrevious());
    expect(find.timelineProps.activeFindMatch?.entryId).toBe("inserted");
  });

  it("asks the server rather than using stale navigation counts during live updates", async () => {
    const initial = {
      ...messageResult(0),
      navigation: [{ entryId: "message:2", runId, startIndex: 0, count: 10 }],
    };
    queries.results.set(a, initial);
    await act(async () => {
      renderer = create(<Probe environmentId={a} />);
    });
    await act(async () => find.open());
    await act(async () => find.barProps.onQueryChange("COD4"));
    await act(async () =>
      renderer?.update(<Probe environmentId={a} content={{ runs: [], visibleTurnItems: [] }} />),
    );
    await act(async () => find.barProps.onNext());
    expect(orchestrationEnvironment.threadFind).toHaveBeenLastCalledWith({
      environmentId: a,
      input: {
        threadId,
        query: "COD4",
        skills: [],
        start: { entryId: "message:2", occurrence: 0 },
        offset: 1,
      },
    });
  });

  it("starts from the viewport and steps from the server-selected match", async () => {
    queries.results.set(a, messageResult(4));
    await act(async () => {
      renderer = create(<Probe environmentId={a} />);
    });
    await act(async () => find.open());
    find.timelineProps.findPositionReaderRef.current = () => ({
      entryId: "message:6",
      occurrence: 1,
    });
    await act(async () => find.barProps.onQueryChange("COD4"));
    expect(orchestrationEnvironment.threadFind).toHaveBeenLastCalledWith({
      environmentId: a,
      input: {
        threadId,
        query: "COD4",
        skills: [],
        start: { entryId: "message:6", occurrence: 1 },
      },
    });
    expect(find.barProps.activeIndex).toBe(4);
    queries.results.set(a, messageResult(5));
    await act(async () => find.barProps.onNext());
    expect(orchestrationEnvironment.threadFind).toHaveBeenLastCalledWith({
      environmentId: a,
      input: {
        threadId,
        query: "COD4",
        skills: [],
        start: { entryId: "message:6", occurrence: 0 },
        offset: 1,
      },
    });
    expect(find.timelineProps.activeFindMatch?.entryId).toBe("message:7");
    queries.results.set(a, messageResult(4));
    await act(async () => find.barProps.onPrevious());
    expect(find.barProps.activeIndex).toBe(4);
    expect(orchestrationEnvironment.threadFind).toHaveBeenLastCalledWith({
      environmentId: a,
      input: {
        threadId,
        query: "COD4",
        skills: [],
        start: { entryId: "message:7", occurrence: 0 },
        offset: -1,
      },
    });
  });

  it("accumulates rapid navigation against the same match until the response arrives", async () => {
    queries.results.set(a, messageResult(4));
    await act(async () => {
      renderer = create(<Probe environmentId={a} />);
    });
    await act(async () => find.open());
    await act(async () => find.barProps.onQueryChange("COD4"));
    queries.pending = true;
    queries.results.delete(a);
    await act(async () => find.barProps.onNext());
    await act(async () => find.barProps.onNext());
    expect(orchestrationEnvironment.threadFind).toHaveBeenLastCalledWith({
      environmentId: a,
      input: {
        threadId,
        query: "COD4",
        skills: [],
        start: { entryId: "message:6", occurrence: 0 },
        offset: 2,
      },
    });
    expect(find.timelineProps.findNavigationId).toBe(1);
    queries.pending = false;
    queries.results.set(a, messageResult(6));
    await act(async () => renderer?.update(<Probe environmentId={a} />));
    expect(find.timelineProps.findNavigationId).toBe(3);
    expect(find.barProps.activeIndex).toBe(6);
  });

  it("refreshes continuous updates without shifting the current match or showing Searching", async () => {
    vi.useFakeTimers();
    queries.results.set(a, messageResult(4));
    await act(async () => {
      renderer = create(<Probe environmentId={a} />);
    });
    await act(async () => find.open());
    await act(async () => find.barProps.onQueryChange("COD4"));
    for (let i = 0; i < 3; i++) {
      await act(async () =>
        renderer?.update(<Probe environmentId={a} content={{ visibleTurnItems: [], runs: [] }} />),
      );
      await act(async () => vi.advanceTimersByTime(100));
    }
    expect(orchestrationEnvironment.threadFind).toHaveBeenLastCalledWith({
      environmentId: a,
      input: {
        threadId,
        query: "COD4",
        skills: [],
        start: { entryId: "message:6", occurrence: 0 },
      },
    });
    const updated = { ...messageResult(5, 10), totalMatches: 11, match: messageResult(4).match };
    queries.results.set(a, updated);
    await act(async () => renderer?.update(<Probe environmentId={a} />));
    expect(find.barProps.matchCount).toBe(11);
    expect(find.barProps.activeIndex).toBe(5);
    expect(find.timelineProps.activeFindMatch?.entryId).toBe("message:6");
    expect(find.timelineProps.findNavigationId).toBe(1);
    expect(find.barProps.status).toBeNull();
    await act(async () => find.barProps.onNext());
    expect(orchestrationEnvironment.threadFind).toHaveBeenLastCalledWith({
      environmentId: a,
      input: {
        threadId,
        query: "COD4",
        skills: [],
        start: { entryId: "message:6", occurrence: 0 },
        offset: 1,
      },
    });
  });

  it("keeps pending navigation when incoming content triggers a refresh", async () => {
    vi.useFakeTimers();
    queries.results.set(a, messageResult(4));
    await act(async () => {
      renderer = create(<Probe environmentId={a} />);
    });
    await act(async () => find.open());
    await act(async () => find.barProps.onQueryChange("COD4"));
    queries.pending = true;
    queries.results.delete(a);
    await act(async () => find.barProps.onNext());
    await act(async () =>
      renderer?.update(<Probe environmentId={a} content={{ visibleTurnItems: [], runs: [] }} />),
    );
    await act(async () => vi.advanceTimersByTime(300));
    expect(queries.refresh).toHaveBeenCalledTimes(1);
    expect(orchestrationEnvironment.threadFind).toHaveBeenLastCalledWith({
      environmentId: a,
      input: {
        threadId,
        query: "COD4",
        skills: [],
        start: { entryId: "message:6", occurrence: 0 },
        offset: 1,
      },
    });
    queries.pending = false;
    queries.results.set(a, { ...messageResult(6, 10), totalMatches: 11 });
    await act(async () => renderer?.update(<Probe environmentId={a} />));
    expect(find.timelineProps.activeFindMatch?.entryId).toBe("message:8");
    expect(find.timelineProps.findNavigationId).toBe(2);
    expect(find.barProps.matchCount).toBe(11);
  });

  it("does not navigate the previous result while a new match is loading", async () => {
    queries.results.set(a, messageResult(0));
    await act(async () => {
      renderer = create(<Probe environmentId={a} />);
    });
    await act(async () => find.open());
    await act(async () => find.barProps.onQueryChange("COD4"));
    queries.pending = true;
    queries.results.delete(a);
    await act(async () => find.barProps.onNext());
    expect(find.timelineProps.activeFindMatch?.entryId).toBe("message:2");
    expect(find.timelineProps.findNavigationId).toBe(1);
    expect(find.barProps.status).toBeNull();
    expect(find.barProps.activeIndex).toBe(0);
    expect(find.barProps.matchCount).toBe(10);
    queries.pending = false;
    queries.results.set(a, messageResult(1));
    await act(async () => renderer?.update(<Probe environmentId={a} />));
    expect(find.timelineProps.activeFindMatch?.entryId).toBe("message:3");
    expect(find.timelineProps.findNavigationId).toBe(2);
  });

  it("keeps the reading-position start when Enter is pressed before results arrive", async () => {
    queries.pending = true;
    await act(async () => {
      renderer = create(<Probe environmentId={a} />);
    });
    await act(async () => find.open());
    find.timelineProps.findPositionReaderRef.current = () => ({
      entryId: "message:6",
      occurrence: 1,
    });
    await act(async () => find.barProps.onQueryChange("COD4"));
    await act(async () => find.barProps.onNext());
    expect(orchestrationEnvironment.threadFind).toHaveBeenLastCalledWith({
      environmentId: a,
      input: {
        threadId,
        query: "COD4",
        skills: [],
        start: { entryId: "message:6", occurrence: 1 },
      },
    });
  });

  it("shows Searching only when the query has no result yet", async () => {
    queries.pending = true;
    await act(async () => {
      renderer = create(<Probe environmentId={a} />);
    });
    await act(async () => find.open());
    await act(async () => find.barProps.onQueryChange("COD4"));
    expect(find.barProps.status).toBe("loading");
    queries.pending = false;
    queries.results.set(a, messageResult(0));
    await act(async () => renderer?.update(<Probe environmentId={a} />));
    expect(find.barProps.status).toBeNull();
    queries.pending = true;
    queries.results.delete(a);
    await act(async () => find.barProps.onQueryChange("different query"));
    expect(find.barProps.status).toBe("loading");
    expect(find.barProps.matchCount).toBe(0);
    // Folded content stays expanded while the new query loads.
    expect(find.timelineProps.findQuery).toBe("");
    expect(find.timelineProps.findExpanded).toBe(true);
    await act(async () => find.barProps.onQueryChange(""));
    expect(find.timelineProps.findExpanded).toBe(false);
  });

  it("keeps search unavailable when the server does not support it", async () => {
    await act(async () => {
      renderer = create(<Probe environmentId={a} enabled={false} />);
    });
    await act(async () => {
      find.open();
      requestThreadFindOpen();
    });
    expect(find.isOpen).toBe(false);
    expect(find.timelineProps.activeFindMatch).toBeNull();
    expect(orchestrationEnvironment.threadFind).not.toHaveBeenCalled();
  });

  it("closes search when support disappears without restoring stale queries", async () => {
    await act(async () => {
      renderer = create(<Probe environmentId={a} />);
    });
    await act(async () => find.open());
    await act(async () => find.barProps.onQueryChange("needle"));
    expect(find.isOpen).toBe(true);
    vi.mocked(orchestrationEnvironment.threadFind).mockClear();
    await act(async () => {
      renderer?.update(<Probe environmentId={a} enabled={false} />);
    });
    expect(find.isOpen).toBe(false);
    expect(find.timelineProps.activeFindMatch).toBeNull();
    expect(find.timelineProps.findQuery).toBe("");
    expect(orchestrationEnvironment.threadFind).not.toHaveBeenCalled();
    await act(async () => {
      renderer?.update(<Probe environmentId={a} />);
    });
    expect(find.isOpen).toBe(false);
    await act(async () => find.open());
    expect(find.barProps.query).toBe("");
  });

  it("preserves plan item ID and run ownership for navigation", async () => {
    queries.results.set(a, {
      snapshotSequence: 9,
      totalMatches: 1,
      activeIndex: 0,
      match: { entryId: "plan-item", runId, occurrence: 0 },
    });
    await act(async () => {
      renderer = create(<Probe environmentId={a} />);
    });
    await act(async () => {
      find.open();
    });
    await act(async () => {
      find.barProps.onQueryChange("needle");
    });
    expect(find.timelineProps.activeFindMatch).toEqual({
      entryId: "plan-item",
      runId,
      occurrence: 0,
    });
    await act(async () => {
      find.close();
    });
    expect(find.timelineProps.activeFindMatch).toBeNull();
    expect(find.timelineProps.findQuery).toBe("");
  });

  it("drops results on environment changes even when the thread IDs are identical", async () => {
    queries.results.set(a, {
      snapshotSequence: 1,
      totalMatches: 3,
      activeIndex: 0,
      match: null,
    });
    queries.results.set(b, {
      snapshotSequence: 2,
      totalMatches: 0,
      activeIndex: 0,
      match: null,
    });
    await act(async () => {
      renderer = create(<Probe environmentId={a} />);
    });
    await act(async () => {
      find.open();
    });
    await act(async () => {
      find.barProps.onQueryChange("needle");
    });
    expect(find.barProps.matchCount).toBe(3);
    await act(async () => {
      renderer?.update(<Probe environmentId={b} />);
    });
    expect(find.isOpen).toBe(false);
    expect(find.timelineProps.activeFindMatch).toBeNull();
    await act(async () => {
      find.open();
    });
    await act(async () => {
      find.barProps.onQueryChange("needle");
    });
    expect(find.barProps.matchCount).toBe(0);
    await act(async () => {
      renderer?.update(<Probe environmentId={a} />);
    });
    expect(find.isOpen).toBe(false);
  });
});
