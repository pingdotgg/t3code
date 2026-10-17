import type { LegendListRef } from "@legendapp/list/react";
import { EnvironmentId, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { act, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { TimelineEntry } from "../../session-logic";
import { deriveMessagesTimelineRows, timelineEntryTurnFoldRunId } from "./MessagesTimeline.logic";
import { useAssistantCitationTarget } from "./useAssistantCitationTarget";

vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

let renderer: ReactTestRenderer | undefined;
let navigation: ReturnType<typeof useAssistantCitationTarget>;
let visibleMessageIds: string[];
let expandedRunIds: ReadonlySet<RunId>;

beforeEach(() => {
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("citation navigation into folded turns", () => {
  it.each([null, RunId.make("run")])("reveals a response in a turn with runId %s", (runId) => {
    const entries: TimelineEntry[] = ["prompt", "update", "answer"].map((id, index) => {
      const createdAt = new Date(index * 1000).toISOString();
      return {
        kind: "message",
        id,
        createdAt,
        message: {
          id: MessageId.make(id),
          role: index === 0 ? "user" : "assistant",
          text: id,
          runId,
          streaming: false,
          createdAt,
          updatedAt: createdAt,
        },
      };
    });
    const foldInput = { timelineEntries: entries, latestRun: null, isWorking: false };
    const rowInput = {
      ...foldInput,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    };
    const collapsedRows = deriveMessagesTimelineRows(rowInput);
    expect(collapsedRows.some((row) => row.kind === "message" && row.message.id === "update")).toBe(
      false,
    );
    const request = {
      key: "citation",
      citation: {
        version: 1 as const,
        environmentId: EnvironmentId.make("environment"),
        threadId: ThreadId.make("thread"),
        messageId: MessageId.make("update"),
        text: "update",
        start: 0,
        end: 6,
        prefix: "",
        suffix: "",
      },
    };
    const viewport = new EventTarget() as HTMLElement;
    const onManualNavigation = vi.fn();
    function Probe() {
      const [expanded, setExpanded] = useState<ReadonlySet<RunId>>(new Set());
      const rows = useMemo(
        () => deriveMessagesTimelineRows({ ...rowInput, expandedRunIds: expanded }),
        [expanded],
      );
      const onExpandTurn = useCallback((key: RunId) => {
        setExpanded((current) => (current.has(key) ? current : new Set(current).add(key)));
      }, []);
      const getTurnFoldRunId = useCallback(
        (entryId: string) => timelineEntryTurnFoldRunId(foldInput, entryId),
        [],
      );
      const listRef = useRef({} as LegendListRef);
      const state = useAssistantCitationTarget({
        getTurnFoldRunId,
        request,
        entries,
        rows,
        listRef,
        viewport,
        historyLoading: false,
        loadEarlier: null,
        onExpandTurn,
        onManualNavigation,
      });
      useLayoutEffect(() => {
        navigation = state;
        expandedRunIds = expanded;
        visibleMessageIds = rows.flatMap((row) => (row.kind === "message" ? [row.message.id] : []));
      });
      return null;
    }

    act(() => {
      renderer = create(<Probe />);
    });
    act(() => navigation.onListLoad());

    expect([...expandedRunIds]).toEqual([runId ?? "runless:prompt"]);
    expect(visibleMessageIds).toContain("update");
    expect(visibleMessageIds).toContain("answer");
    expect(navigation.target?.citation.messageId).toBe("update");
    expect(navigation.alwaysRender?.keys).toEqual(["update"]);
    expect(navigation.positioning).toBe(true);

    // The mounted source reports completion after measuring and scrolling to its quote.
    act(() => navigation.target!.onComplete());
    expect(navigation.positioning).toBe(false);
    expect(navigation.alwaysRender).toBeUndefined();
  });
});
