import { ThreadId, type WorktreeSetupSnapshot } from "@t3tools/contracts";
import {
  CheckpointRef,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  RunAttemptId,
  TurnItemId,
  RuntimeRequestId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  deriveTimelineEntriesFromVisibleTurnItems,
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  workEntryDisplayIndicatesToolFailure,
  type TimelineEntry,
} from "../../session-logic";
import { makeStreamingTimelineFixture } from "../../test-fixtures";
import type { TurnDiffSummary } from "../../types";
import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, MessageId, RunId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  timelineTurnFoldRunIdsByEntryId,
  deriveMessagesTimelineRowsWithState,
  shouldCollapseUserMessage,
  resolveAssistantMessageCopyState,
  type MessagesTimelineRow,
  workEntryDisplayLabel,
} from "./MessagesTimeline.logic";

describe("resolveAssistantMessageCopyState", () => {
  it("copies the rendered representation of Codex directives", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: [
          'Created :codex-file-citation{path="outputs/report.xlsx" purpose="output"}.',
          "",
          '::artifact-template{skill_name="artifact-template-hello-world" skill_directory="/Users/test/.codex/skills/artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}',
        ].join("\n"),
        streaming: false,
      }),
    ).toEqual({
      text: "Created [report.xlsx](<outputs/report.xlsx>).\n\nHello World (Document template)",
      visible: true,
    });
  });
});

describe("deriveMessagesTimelineRows", () => {
  it("stops stranded thinking after a steer and follows the next thought or tool", () => {
    const runId = RunId.make("steered-run");
    const at = "2026-10-01T06:19:10Z";
    const thought = (id: string): TimelineEntry => ({
      kind: "work",
      id,
      createdAt: at,
      entry: {
        id,
        runId,
        createdAt: at,
        label: "Thinking",
        tone: "thinking",
        itemType: "reasoning",
        detail: id,
        toolLifecycleStatus: "inProgress",
      },
    });
    const steer: TimelineEntry = {
      kind: "message",
      id: "steer",
      createdAt: at,
      message: {
        id: MessageId.make("steer"),
        role: "user",
        text: "Also evaluate speed",
        runId,
        inputIntent: "steer",
        streaming: false,
        createdAt: at,
        updatedAt: at,
      },
    };
    const first = thought("first-thought");
    const next = thought("next-thought");
    const tool: TimelineEntry = {
      kind: "work",
      id: "tool",
      createdAt: at,
      entry: {
        id: "tool",
        runId,
        createdAt: at,
        label: "Running cat",
        tone: "tool",
        command: "cat file",
        toolLifecycleStatus: "inProgress",
      },
    };
    const rows = (timelineEntries: ReadonlyArray<TimelineEntry>) =>
      deriveMessagesTimelineRows({
        timelineEntries,
        runningRunId: runId,
        isWorking: true,
        activeTurnStartedAt: at,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
    expect(rows([first]).find((row) => row.kind === "work-live")).toMatchObject({
      active: true,
      entry: { id: "first-thought" },
    });
    const afterSteer = rows([first, steer]);
    expect(afterSteer.some((row) => row.kind === "work-live")).toBe(false);
    expect(afterSteer.at(-1)?.kind).toBe("thinking");
    expect(afterSteer.find((row) => row.kind === "work")).toMatchObject({
      groupedEntries: [{ id: "first-thought", toolLifecycleStatus: "completed" }],
    });
    for (const entries of [
      [first, steer, next],
      [first, next],
      [first, steer, next, tool],
    ]) {
      const live = rows(entries).filter((row) => row.kind === "work-live" && row.active);
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({ entry: { id: entries.at(-1)!.id } });
    }
    expect(first.kind === "work" && first.entry.toolLifecycleStatus).toBe("inProgress");
  });

  it("recovers the failed Sky call stored as a generic js integration", () => {
    const fixture = makeStreamingTimelineFixture();
    const source = fixture.visibleTurnItems.find((row) => row.item.type === "dynamic_tool")!;
    if (source.item.type !== "dynamic_tool") throw new Error("Expected tool fixture");
    const item = {
      ...source.item,
      type: "dynamic_tool" as const,
      status: "failed" as const,
      title: "js",
      toolName: "node_repl.js",
      toolSource: { key: "mcp:node_repl", name: "node repl", kind: "integration" as const },
      input: {
        title: "Restrict the breakpoint to Git actions",
        code: "await sky.type_text({app:'T3 Code (Nightly)',text:'debug(ga.run)'});",
      },
    };
    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [{ ...source, item }],
      optimisticMessages: [],
    });
    const entry = entries.find((row) => row.kind === "work");
    expect(entry?.kind === "work" && workEntryDisplayLabel(entry.entry, undefined)).toBe(
      "Restrict the breakpoint to Git actions",
    );
    expect(entry?.kind === "work" && entry.entry).toMatchObject({
      toolSurface: "computer",
      toolSource: { key: "computer-use", kind: "computer" },
    });
  });

  it.each(["waiting", "completed"] as const)(
    "groups approval and user-input requests with commands without expanding them when %s",
    (status) => {
      const fixture = makeStreamingTimelineFixture();
      const source = fixture.visibleTurnItems[0]!;
      const common = {
        ...source.item,
        threadId: fixture.threadId,
        runId: fixture.runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        status,
      };
      const items: OrchestrationV2ProjectedTurnItem["item"][] = [
        {
          ...common,
          id: TurnItemId.make("command"),
          type: "command_execution",
          input: "pwd",
          output: "",
        },
        {
          ...common,
          id: TurnItemId.make("approval"),
          type: "approval_request",
          requestId: RuntimeRequestId.make("approval-request"),
          requestKind: "command",
          prompt: "Allow pwd?",
        },
        {
          ...common,
          id: TurnItemId.make("input"),
          type: "user_input_request",
          requestId: RuntimeRequestId.make("input-request"),
          questions: [],
        },
      ];
      const entries = deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: items.map((item, position) => ({
          ...source,
          item,
          position,
          sourceItemId: item.id,
        })),
        optimisticMessages: [],
      });
      expect(entries.map((entry) => entry.kind)).toEqual(["work", "work", "work"]);
      const rows = deriveMessagesTimelineRows({
        timelineEntries: entries,
        isWorking: status === "waiting",
        runningRunId: fixture.runId,
        activeTurnStartedAt: fixture.time(0),
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
      const workRows = rows.filter((row) => row.kind === "work-toggle" || row.kind === "work-live");
      expect(workRows).toHaveLength(1);
      expect(workRows[0]).toMatchObject({ expanded: false });
      const expandedRows = deriveMessagesTimelineRows({
        timelineEntries: entries,
        isWorking: status === "waiting",
        runningRunId: fixture.runId,
        activeTurnStartedAt: fixture.time(0),
        turnDiffSummaries: [],
        supportsConversationRollback: false,
        expandedWorkGroupIds: new Set([workRows[0]!.groupId]),
      });
      const expanded = expandedRows.find((row) => row.kind === "work" && row.isExpandedToolGroup);
      expect(
        expanded?.kind === "work" && expanded.groupedEntries.map((entry) => entry.itemType),
      ).toEqual(["command_execution", "approval_request", "user_input_request"]);
      expect(rows.some((row) => row.kind === "event")).toBe(false);
      expect(workRows[0]).not.toMatchObject({ expanded: true });
      expect(workRows[0]).not.toMatchObject({ isExpandedToolGroup: true });
      const pendingRows = deriveMessagesTimelineRows({
        timelineEntries: entries,
        pendingApprovalRequestIds: new Set([RuntimeRequestId.make("approval-request")]),
        isWorking: status === "waiting",
        runningRunId: fixture.runId,
        activeTurnStartedAt: fixture.time(0),
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
      expect(pendingRows.filter((row) => row.kind === "work")).toContainEqual(
        expect.objectContaining({
          groupedEntries: [expect.objectContaining({ itemType: "approval_request" })],
          isExpandedToolGroup: false,
        }),
      );
      expect(
        pendingRows
          .filter((row) => row.kind === "work-live")
          .flatMap((row) => row.groupedEntries)
          .some((entry) => entry.itemType === "approval_request"),
      ).toBe(false);
      const approvalOnlyRows = deriveMessagesTimelineRows({
        timelineEntries: entries.slice(1, 2),
        pendingApprovalRequestIds: new Set([RuntimeRequestId.make("approval-request")]),
        isWorking: status === "waiting",
        runningRunId: fixture.runId,
        activeTurnStartedAt: fixture.time(0),
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
      expect(approvalOnlyRows.some((row) => row.kind === "thinking")).toBe(false);
    },
  );

  it.each(["running", "completed", "superseded"] as const)(
    "keeps system notices visible as non-failing warnings through %s work",
    (state) => {
      const fixture = makeStreamingTimelineFixture();
      const message =
        "Claude changed its safety mode.\nReview the active permission settings before continuing.";
      const source: OrchestrationV2ProjectedTurnItem = {
        ...fixture.visibleTurnItems[0]!,
        sourceItemId: TurnItemId.make("safety-notice"),
        item: {
          id: TurnItemId.make("safety-notice"),
          threadId: fixture.threadId,
          runId: fixture.runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          startedAt: DateTime.makeUnsafe(fixture.time(1)),
          completedAt: DateTime.makeUnsafe(fixture.time(1)),
          updatedAt: DateTime.makeUnsafe(fixture.time(1)),
          type: "system_notice",
          message,
          title: message,
          status: "completed",
        },
      };
      const [notice] = deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: [source],
        optimisticMessages: [],
      });
      if (notice?.kind !== "work") throw new Error("Expected a notice work entry");
      expect(notice.entry.projectedItem).toBe(source);
      expect(notice.entry.sourceActivityKind).toBe("runtime.warning");
      expect(workEntryDisplayLabel(notice.entry, undefined)).toBe(message);
      expect(workEntryDisplayIndicatesToolFailure(notice.entry)).toBe(false);
      const rows = deriveMessagesTimelineRows({
        timelineEntries: [
          {
            ...notice,
            ...(state === "superseded"
              ? {
                  attempt: {
                    id: "old-attempt" as never,
                    runId: fixture.runId,
                    status: "superseded" as const,
                    attemptOrdinal: 0,
                    rootNodeId: "old-root" as never,
                    completedAt: null,
                  },
                }
              : {}),
          },
          {
            id: "nearby-tool",
            kind: "work",
            createdAt: notice.createdAt,
            entry: {
              id: "nearby-tool",
              runId: fixture.runId,
              createdAt: notice.createdAt,
              label: "Ran command",
              tone: "tool",
              toolLifecycleStatus: "completed",
            },
          },
          {
            id: "terminal-message",
            kind: "message",
            createdAt: notice.createdAt,
            message: {
              id: MessageId.make("terminal-message"),
              runId: fixture.runId,
              role: "assistant",
              text: "Continuing with the selected settings.",
              createdAt: notice.createdAt,
              updatedAt: notice.createdAt,
              streaming: state === "running",
            },
          },
        ],
        isWorking: state === "running",
        activeTurnStartedAt: notice.createdAt,
        latestRun: {
          runId: fixture.runId,
          status: state === "running" ? "running" : "completed",
          startedAt: notice.createdAt,
          completedAt: state === "running" ? null : notice.createdAt,
        },
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
      const row = rows.find(
        (row) => row.kind === "work" && row.groupedEntries.includes(notice.entry),
      );
      expect(row).toMatchObject({ kind: "work", groupedEntries: [notice.entry] });
    },
  );

  it.each([false, true])(
    "gives live compaction the activity slot and restores Thinking (runless: %s)",
    (runless) => {
      const fixture = makeStreamingTimelineFixture();
      const last = fixture.visibleTurnItems.at(-1)!;
      if (last.item.type !== "assistant_message") throw new Error("Expected assistant fixture");
      const compact = {
        ...last,
        item: {
          ...last.item,
          type: "compaction" as const,
          status: "running" as const,
          driver: null,
          beforeTokenCount: 899_000,
        },
      };
      const input = {
        isWorking: true,
        runningRunId: fixture.runId,
        activeTurnStartedAt: fixture.time(5),
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      };
      const runningEntries = deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: [...fixture.visibleTurnItems.slice(0, -1), compact],
        optimisticMessages: [],
      });
      const runningRows = deriveMessagesTimelineRows({
        ...input,
        runningRunId: runless ? null : fixture.runId,
        runlessWorkActive: runless,
        timelineEntries: runless
          ? runningEntries.map((entry) =>
              entry.kind === "work" ? { ...entry, entry: { ...entry.entry, runId: null } } : entry,
            )
          : runningEntries,
      });
      expect(runningRows.find((row) => row.kind === "context-compaction")).toMatchObject({
        active: true,
        label: "Compacting context",
      });
      expect(runningRows.some((row) => row.kind === "thinking")).toBe(false);

      const completedRows = deriveMessagesTimelineRows({
        ...input,
        timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems: [
            ...fixture.visibleTurnItems.slice(0, -1),
            {
              ...compact,
              item: { ...compact.item, status: "completed", afterTokenCount: 19_000 },
            },
          ],
          optimisticMessages: [],
        }),
      });
      expect(completedRows.find((row) => row.kind === "context-compaction")).toMatchObject({
        active: false,
        label: "Context compacted 899K → 19K tokens",
        tokenCounts: { before: "899K", after: "19K" },
      });
      expect(completedRows.at(-1)?.kind).toBe("thinking");

      const settledRows = deriveMessagesTimelineRows({
        ...input,
        isWorking: false,
        timelineEntries: runningEntries,
      });
      expect(settledRows.find((row) => row.kind === "context-compaction")).toMatchObject({
        active: false,
      });
      const stable = computeStableMessagesTimelineRows(runningRows, {
        result: [],
        byId: new Map(),
      });
      expect(computeStableMessagesTimelineRows(settledRows, stable).result).toEqual(settledRows);
    },
  );

  it("shows each compaction trigger as one live status, then a reasoned token divider", () => {
    const fixture = makeStreamingTimelineFixture();
    const [history0, history1, history2, liveUser, , liveAssistant] = fixture.visibleTurnItems;
    if (liveUser?.item.type !== "user_message" || liveAssistant?.item.type !== "assistant_message")
      throw new Error("Expected live fixture items");
    const compactPrompt = (idleCompaction: "beforeCacheExpires" | "onReturn" | undefined) => ({
      ...liveUser,
      item: { ...liveUser.item, text: "/compact", idleCompaction },
    });
    const compaction = {
      ...liveAssistant,
      item: {
        ...liveAssistant.item,
        type: "compaction" as const,
        driver: null,
        beforeTokenCount: 899_000,
      },
    };
    const rowsFor = (visibleTurnItems: OrchestrationV2ProjectedTurnItem[], isWorking = true) =>
      deriveMessagesTimelineRows({
        timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems: [history0!, history1!, history2!, ...visibleTurnItems],
          optimisticMessages: [],
        }),
        isWorking,
        runningRunId: fixture.runId,
        latestRun: {
          runId: fixture.runId,
          status: isWorking ? "running" : "completed",
          startedAt: fixture.time(5),
          completedAt: isWorking ? null : fixture.time(9),
        },
        activeTurnStartedAt: fixture.time(5),
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });

    // Only compacting on return holds a sent message back, so only it speaks through the working
    // row; the others keep their live divider.
    for (const [reason, live, title] of [
      [
        "beforeCacheExpires",
        {
          kind: "context-compaction",
          active: true,
          label: "Compacting before the cache expires…",
        },
        "Context automatically compacted before cache expiry",
      ],
      ["onReturn", { kind: "working", compacting: true }, "Context compacted before sending"],
      [undefined, { kind: "context-compaction", active: true }, undefined],
    ] as const) {
      const prompt = compactPrompt(reason);
      for (const rows of [rowsFor([prompt]), rowsFor([prompt, compaction])]) {
        const liveRows = rows.slice(
          rows.findIndex((row) => row.id.includes("history-assistant")) + 1,
        );
        expect(liveRows).toMatchObject([live]);
      }
      const completed = rowsFor(
        [
          prompt,
          {
            ...compaction,
            item: { ...compaction.item, status: "completed", afterTokenCount: 19_000 },
          },
        ],
        false,
      );
      const liveRows = completed.slice(
        completed.findIndex((row) => row.id.includes("history-assistant")) + 1,
      );
      expect(liveRows).toMatchObject([
        {
          kind: "context-compaction",
          active: false,
          tokenCounts: { before: "899K", after: "19K" },
        },
      ]);
      expect(liveRows[0]?.kind === "context-compaction" ? liveRows[0].title : null).toBe(title);
      const terminalCompaction = {
        ...compaction,
        item: { ...compaction.item, status: "completed" as const, afterTokenCount: 19_000 },
      };
      const finishingRows = rowsFor([prompt, terminalCompaction]);
      const finishingLiveRows = finishingRows.slice(
        finishingRows.findIndex((row) => row.id.includes("history-assistant")) + 1,
      );
      expect(finishingLiveRows).toEqual(liveRows);
      const continuingRows = rowsFor([
        prompt,
        terminalCompaction,
        { ...liveAssistant, item: { ...liveAssistant.item, id: TurnItemId.make("continued") } },
      ]);
      expect(continuingRows.filter((row) => row.kind === "context-compaction")).toHaveLength(1);
      expect(continuingRows.filter((row) => row.kind === "working")).toMatchObject([
        { kind: "working" },
      ]);
      expect(continuingRows.some((row) => row.kind === "working" && row.compacting)).toBe(false);
      const retries = rowsFor(
        [
          prompt,
          {
            ...compaction,
            item: { ...compaction.item, status: "failed", summary: "retry needed" },
          },
          {
            ...compaction,
            item: {
              ...compaction.item,
              id: TurnItemId.make("retry-compaction"),
              status: "completed",
            },
          },
        ],
        false,
      ).filter((row) => row.kind === "context-compaction");
      expect(retries).toHaveLength(2);
      expect(retries[0]).toMatchObject({ failed: true, failure: "retry needed" });
      expect(new Set(retries.map((row) => row.id)).size).toBe(2);
      const stable = computeStableMessagesTimelineRows(retries, { result: [], byId: new Map() });
      expect(computeStableMessagesTimelineRows(retries, stable).result).toEqual(retries);
    }
  });

  it.each(["/compact", "Continue"])(
    "keeps a completed compaction divider visible while other settled work folds for %s",
    (promptText) => {
      const fixture = makeStreamingTimelineFixture();
      const [, , , liveUser, liveWork, liveAssistant] = fixture.visibleTurnItems;
      if (
        liveUser?.item.type !== "user_message" ||
        liveAssistant?.item.type !== "assistant_message" ||
        !liveWork
      )
        throw new Error("Expected live fixture items");
      const rows = deriveMessagesTimelineRows({
        timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems: [
            { ...liveUser, item: { ...liveUser.item, text: promptText } },
            liveWork,
            {
              ...liveAssistant,
              item: {
                ...liveAssistant.item,
                type: "compaction",
                driver: null,
                status: "completed",
                beforeTokenCount: 100_000,
                afterTokenCount: 20_000,
              },
            },
          ],
          optimisticMessages: [],
        }),
        isWorking: false,
        latestRun: {
          runId: fixture.runId,
          status: "completed",
          startedAt: fixture.time(5),
          completedAt: fixture.time(8),
        },
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
      expect(rows.filter((row) => row.kind === "turn-fold")).toHaveLength(1);
      expect(rows.some((row) => row.kind === "work")).toBe(false);
      expect(rows.filter((row) => row.kind === "context-compaction")).toMatchObject([
        { active: false, tokenCounts: { before: "100K", after: "20K" } },
      ]);
      if (promptText === "/compact") {
        expect(rows.some((row) => row.kind === "message")).toBe(false);
      }
    },
  );

  it("folds an answered compact-on-return question into its compaction row", () => {
    const fixture = makeStreamingTimelineFixture();
    const [history0, history1, history2, liveUser, liveWork, liveAssistant] =
      fixture.visibleTurnItems;
    if (liveWork?.item.type !== "dynamic_tool" || liveAssistant?.item.type !== "assistant_message")
      throw new Error("Expected live fixture items");
    const { toolName: _toolName, input: _input, output: _output, ...workBase } = liveWork.item;
    const question =
      "This session is 1h 5m old and uses 412,000 tokens. Compact it before continuing?";
    const requestId = RuntimeRequestId.make("resume-compaction");
    const answered = {
      ...liveWork,
      item: {
        ...workBase,
        type: "user_input_request" as const,
        requestId,
        questions: [],
        questionAnswer: {
          requestId,
          questionTextById: { resume: question },
          answers: { resume: "Compact and continue" },
          attachmentsByQuestionId: {},
        },
      },
    };
    const assistantItem = liveAssistant.item;
    // The answer can come long after the turn starts; the row times the compaction itself.
    const compactionStartedAt = DateTime.makeUnsafe(fixture.time(65));
    const compactionAt = (status: "running" | "completed") => ({
      ...liveAssistant,
      item: {
        ...assistantItem,
        type: "compaction" as const,
        status,
        driver: null,
        startedAt: compactionStartedAt,
      },
    });
    const rowsFor = (status: "running" | "completed", laterCompaction = false) =>
      deriveMessagesTimelineRows({
        timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems: [
            history0!,
            history1!,
            history2!,
            liveUser!,
            answered,
            compactionAt(laterCompaction ? "completed" : status),
            ...(laterCompaction
              ? [
                  {
                    ...compactionAt(status),
                    item: {
                      ...compactionAt(status).item,
                      id: TurnItemId.make("later-compaction"),
                    },
                  },
                ]
              : []),
          ],
          optimisticMessages: [],
        }),
        isWorking: status === "running",
        runningRunId: fixture.runId,
        activeTurnStartedAt: fixture.time(5),
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
    const liveRows = (status: "running" | "completed") => {
      const rows = rowsFor(status);
      return rows.slice(rows.findIndex((row) => row.id.includes("live-user")) + 1);
    };
    expect(liveRows("running")).toMatchObject([
      { kind: "working", compacting: true, createdAt: DateTime.formatIso(compactionStartedAt) },
    ]);
    expect(liveRows("completed")).toMatchObject([
      { kind: "context-compaction", title: "Context compacted after 1h 5m idle" },
    ]);
    const laterRows = rowsFor("running", true);
    const dividers = laterRows.filter((row) => row.kind === "context-compaction");
    expect(dividers).toHaveLength(2);
    expect(dividers[0]).toMatchObject({
      title: "Context compacted after 1h 5m idle",
      active: false,
    });
    expect(dividers[1]).toMatchObject({ active: true });
    expect(dividers[1]).not.toHaveProperty("title");
    expect(laterRows.some((row) => row.kind === "working" && row.compacting !== undefined)).toBe(
      false,
    );
  });

  it("shows a skipped compaction as stopped, without a separate interrupted divider", () => {
    const fixture = makeStreamingTimelineFixture();
    const [history0, history1, history2, liveUser, , liveAssistant] = fixture.visibleTurnItems;
    if (liveUser?.item.type !== "user_message" || liveAssistant?.item.type !== "assistant_message")
      throw new Error("Expected live fixture items");
    const prompt = {
      ...liveUser,
      item: { ...liveUser.item, text: "/compact", idleCompaction: "onReturn" as const },
    };
    const compaction = {
      ...liveAssistant,
      item: {
        ...liveAssistant.item,
        type: "compaction" as const,
        status: "interrupted" as const,
        driver: null,
      },
    };
    const interruptResult = {
      ...liveAssistant,
      item: {
        ...liveAssistant.item,
        id: TurnItemId.make("interrupt-result"),
        type: "run_interrupt_result" as const,
        status: "interrupted" as const,
        message: "Skipped compaction to send a queued message",
      },
    };
    const liveRowsFor = (visibleTurnItems: OrchestrationV2ProjectedTurnItem[]) => {
      const rows = deriveMessagesTimelineRows({
        timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems: [history0!, history1!, history2!, ...visibleTurnItems],
          optimisticMessages: [],
        }),
        isWorking: false,
        latestRun: {
          runId: fixture.runId,
          status: "interrupted",
          startedAt: fixture.time(5),
          completedAt: fixture.time(9),
        },
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
      return rows.slice(rows.findIndex((row) => row.id.includes("history-assistant")) + 1);
    };

    expect(liveRowsFor([prompt, compaction, interruptResult])).toMatchObject([
      { kind: "context-compaction", label: "Context compaction stopped" },
    ]);
    // Stopped before the provider started: no compaction row says so, so the interrupt stays.
    expect(liveRowsFor([prompt, interruptResult]).map((row) => row.id)).toContain(
      "interrupt-result",
    );
  });

  it("only enables assistant copy for the terminal assistant message in a turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-1-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Write a poem",
            runId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "I should ground this first.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Here is the poem.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      expandedRunIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows).toHaveLength(2);
    expect(assistantRows[0]?.showAssistantCopyButton).toBe(false);
    expect(assistantRows[1]?.showAssistantCopyButton).toBe(true);
  });

  it("projects assistant diffs and rewinds the first visible run to thread start after a rewind", () => {
    const assistantTurnDiffSummary = {
      runId: "turn-1" as never,
      completedAt: "2026-01-01T00:00:30Z",
      assistantMessageId: "assistant-1" as never,
      checkpointTurnCount: 2,
      checkpointRef: "checkpoint-1" as never,
      status: "ready" as const,
      files: [{ path: "src/index.ts", kind: "modified", additions: 3, deletions: 1 }],
    };

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Do the thing",
            runId: "turn-1" as never,
            inputIntent: "turn_start",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-1" as never,
            role: "assistant",
            text: "Done",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [assistantTurnDiffSummary],
      supportsConversationRollback: true,
      threadStartCheckpointReady: true,
    });

    const userRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "user",
    );
    const assistantRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(userRow?.revertTurnCount).toBe(0);
    expect(assistantRow?.assistantTurnDiffSummary).toBe(assistantTurnDiffSummary);
  });

  it("folds the first assistant message and settled work before the terminal response", () => {
    const timelineEntries = [
      {
        id: "user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        message: {
          id: "user-1" as never,
          role: "user" as const,
          text: "Build it",
          runId: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "assistant-first-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "assistant-first" as never,
          role: "assistant" as const,
          text: "Synthetic deployment checklist\n1. Confirm the deployment is ready.",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:06Z",
          streaming: false,
        },
      },
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:08Z",
        entry: {
          id: "work-1",
          createdAt: "2026-01-01T00:00:08Z",
          runId: "turn-1" as never,
          label: "Ran command",
          tone: "tool" as const,
        },
      },
      {
        id: "assistant-final-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:20Z",
        message: {
          id: "assistant-final" as never,
          role: "assistant" as const,
          text: "Done",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:20Z",
          updatedAt: "2026-01-01T00:00:22Z",
          streaming: false,
        },
      },
    ];

    const collapsedRows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    const foldRow = collapsedRows.find(
      (row): row is Extract<(typeof collapsedRows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    expect(foldRow?.runId).toBe("turn-1");
    expect(foldRow?.expanded).toBe(false);
    expect(foldRow?.label).toBe("Worked for 22s");
    expect(collapsedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-final-entry",
    ]);

    const expandedRows = deriveMessagesTimelineRows({
      timelineEntries,
      expandedRunIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(expandedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-first-entry",
      "work-entry-1",
      "assistant-final-entry",
    ]);
    expect(
      expandedRows.find((row) => row.kind === "turn-fold" && row.expanded === true),
    ).toBeDefined();
  });

  it.each([1, 2, 3])("folds %i completed activities after the terminal response", (count) => {
    const runId = RunId.make("turn-1");
    const timelineEntries = [
      {
        id: "work-entry-before-text",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:01Z",
        entry: {
          id: "work-before-text",
          createdAt: "2026-01-01T00:00:01Z",
          runId,
          label: "Status updated",
          tone: "info" as const,
        },
      },
      {
        id: "assistant-final-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "assistant-final" as never,
          role: "assistant" as const,
          text: "CI is re-running. Waiting.",
          runId,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:06Z",
          streaming: false,
        },
      },
      ...Array.from({ length: count }, (_, index) => ({
        id: `work-entry-after-text-${index}`,
        kind: "work" as const,
        createdAt: `2026-01-01T00:00:0${index + 7}Z`,
        entry: {
          id: `work-after-text-${index}`,
          createdAt: `2026-01-01T00:00:0${index + 7}Z`,
          runId,
          label: "Ran command",
          tone: "tool" as const,
          itemType: "command_execution" as const,
          toolLifecycleStatus: "completed" as const,
        },
      })),
    ];

    const input = {
      latestRun: {
        runId,
        status: "completed" as const,
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:10Z",
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    };
    const rows = deriveMessagesTimelineRows({ ...input, timelineEntries });

    expect(rows.map((row) => row.id)).toEqual(["turn-fold:turn-1", "assistant-final-entry"]);
    const expanded = deriveMessagesTimelineRows({
      ...input,
      timelineEntries,
      expandedRunIds: new Set([runId]),
    });
    expect(
      expanded.some(
        (row) =>
          row.id === "work-entry-after-text-0" ||
          (row.kind === "work-toggle" &&
            row.id === "work-toggle:work-entry-after-text-0" &&
            row.hiddenCount === count),
      ),
    ).toBe(true);

    const failedEntries = timelineEntries.map((entry) =>
      entry.kind === "work" && entry.id === "work-entry-after-text-0"
        ? { ...entry, entry: { ...entry.entry, toolLifecycleStatus: "failed" as const } }
        : entry,
    );
    const failedRows = deriveMessagesTimelineRows({ ...input, timelineEntries: failedEntries });
    expect(failedRows.some((row) => row.id === "work-entry-after-text-0")).toBe(true);

    const pendingEntries = timelineEntries.map((entry) =>
      entry.kind === "work" && entry.id === "work-entry-after-text-0"
        ? { ...entry, entry: { ...entry.entry, toolLifecycleStatus: "inProgress" as const } }
        : entry,
    );
    const pendingRows = deriveMessagesTimelineRows({
      ...input,
      timelineEntries: pendingEntries,
      latestRun: { ...input.latestRun, status: "running", completedAt: null },
      isWorking: true,
      activeTurnStartedAt: input.latestRun.startedAt,
    });
    expect(
      pendingRows.some((row) => row.kind === "work-live" && row.entry.id === "work-after-text-0"),
    ).toBe(true);
  });

  it("derives a sane duration for a steer-superseded turn with one instant commentary message", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user" as const,
            text: "do it once more",
            runId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "work-entry-before-message",
          kind: "work",
          createdAt: "2026-01-01T00:00:07Z",
          entry: {
            id: "work-before-message",
            createdAt: "2026-01-01T00:00:07Z",
            runId: "turn-1" as never,
            label: "Status updated",
            tone: "info" as const,
          },
        },
        {
          id: "assistant-commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:09Z",
          message: {
            id: "assistant-commentary" as never,
            role: "assistant" as const,
            text: "Kicking off call 1.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:09Z",
            updatedAt: "2026-01-01T00:00:09Z",
            streaming: false,
          },
        },
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:12Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:12Z",
            runId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
        {
          id: "steer-user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:14Z",
          message: {
            id: "user-2" as never,
            role: "user" as const,
            text: "actually do 15",
            runId: null,
            createdAt: "2026-01-01T00:00:14Z",
            updatedAt: "2026-01-01T00:00:14Z",
            streaming: false,
          },
        },
        {
          id: "assistant-next-turn-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:17Z",
          message: {
            id: "assistant-next" as never,
            role: "assistant" as const,
            text: "One down — adjusting.",
            runId: "turn-2" as never,
            createdAt: "2026-01-01T00:00:17Z",
            updatedAt: "2026-01-01T00:00:17Z",
            streaming: true,
          },
        },
      ],
      latestRun: {
        runId: "turn-2" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:14Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:14Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    const foldRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    expect(foldRow?.runId).toBe("turn-1");
    expect(foldRow?.label).toBe("Worked for 12s");
  });

  it("uses latest-turn timings and the stopped label for an interrupted latest turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "interrupted",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:47Z",
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows).toEqual([
      expect.objectContaining({
        kind: "turn-fold",
        runId: "turn-1",
        label: "You stopped after 47s",
        expanded: false,
      }),
    ]);
  });

  it.each(["steer", "promoted_queued_to_steer"] as const)(
    "keeps the duration header at the initiating prompt when %s arrives before output",
    (inputIntent) => {
      const runId = RunId.make("steered-run");
      const time = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
      const prompt = (id: string, second: number, intent: "turn_start" | typeof inputIntent) => ({
        kind: "message" as const,
        id,
        createdAt: time(second),
        message: {
          id: MessageId.make(id),
          role: "user" as const,
          text: id,
          runId,
          inputIntent: intent,
          createdAt: time(second),
          updatedAt: time(second),
          streaming: false,
        },
      });
      const entries = [prompt("initial-prompt", 0, "turn_start"), prompt("steer", 5, inputIntent)];
      const work = {
        kind: "work" as const,
        id: "work",
        createdAt: time(8),
        entry: {
          id: "work",
          createdAt: time(8),
          runId,
          label: "Ran command",
          tone: "tool" as const,
        },
      };
      const final = {
        kind: "message" as const,
        id: "final",
        createdAt: time(20),
        message: {
          id: MessageId.make("final"),
          role: "assistant" as const,
          text: "Done",
          runId,
          createdAt: time(20),
          updatedAt: time(20),
          streaming: false,
        },
      };
      for (const isWorking of [true, false]) {
        for (const expanded of [true, false]) {
          const rows = deriveMessagesTimelineRows({
            timelineEntries: [...entries, work, final],
            latestRun: {
              runId,
              status: isWorking ? "running" : "completed",
              startedAt: time(0),
              completedAt: isWorking ? null : time(20),
            },
            isWorking,
            activeTurnStartedAt: time(0),
            expandedRunIds: expanded ? new Set([runId]) : new Set(),
            turnDiffSummaries: [],
            supportsConversationRollback: false,
          });
          expect(rows.slice(0, 3).map((row) => row.id)).toEqual([
            "initial-prompt",
            isWorking ? "working-indicator-row" : `turn-fold:${runId}`,
            "steer",
          ]);
          expect(rows[1]?.createdAt).toBe(time(0));
          if (!isWorking) expect(rows[1]).toMatchObject({ label: "Worked for 20s", expanded });
          expect(rows.some((row) => row.id === "final")).toBe(true);
          expect(rows.some((row) => row.id === "work")).toBe(isWorking || expanded);
        }
      }
    },
  );

  it("splits a settled turn's work at each steer and keeps the total time on top", () => {
    const runId = RunId.make("steered-run");
    const time = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
    const message = (
      id: string,
      second: number,
      role: "user" | "assistant",
      inputIntent?: "turn_start" | "steer",
    ): TimelineEntry => ({
      kind: "message",
      id,
      createdAt: time(second),
      message: {
        id: MessageId.make(id),
        role,
        text: id,
        runId,
        ...(inputIntent ? { inputIntent } : {}),
        createdAt: time(second),
        updatedAt: time(second),
        streaming: false,
      },
    });
    const work = (id: string, second: number): TimelineEntry => ({
      kind: "work",
      id,
      createdAt: time(second),
      entry: { id, createdAt: time(second), runId, label: "Ran command", tone: "tool" },
    });
    const rows = (expandedRunIds: ReadonlySet<RunId>) =>
      deriveMessagesTimelineRows({
        timelineEntries: [
          message("prompt", 0, "user", "turn_start"),
          work("work-before-steer", 4),
          message("steer", 10, "user", "steer"),
          work("work-after-steer", 15),
          message("final", 30, "assistant"),
        ],
        latestRun: { runId, status: "completed", startedAt: time(0), completedAt: time(30) },
        isWorking: false,
        expandedRunIds,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });

    const segmentKey = RunId.make(`${runId}:steer:steer`);
    const collapsed = rows(new Set());
    expect(collapsed.map((row) => row.id)).toEqual([
      "prompt",
      `turn-fold:${runId}`,
      "steer",
      `turn-fold:${segmentKey}`,
      "final",
    ]);
    expect(collapsed[1]).toMatchObject({ label: "Worked for 30s" });
    expect(collapsed[3]).toMatchObject({ label: "Continued for 20s", createdAt: time(10) });

    expect(rows(new Set([segmentKey])).map((row) => row.id)).toEqual([
      "prompt",
      `turn-fold:${runId}`,
      "steer",
      `turn-fold:${segmentKey}`,
      "work-after-steer",
      "final",
    ]);
  });

  it("keeps the previous turn folded while a newly sent message awaits its turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Done",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:22Z",
            streaming: false,
          },
        },
        {
          id: "user-followup-entry",
          kind: "message",
          createdAt: "2026-01-01T00:01:00Z",
          message: {
            id: "user-followup" as never,
            role: "user",
            text: "yooo",
            runId: null,
            createdAt: "2026-01-01T00:01:00Z",
            updatedAt: "2026-01-01T00:01:00Z",
            streaming: false,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:22Z",
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.map((row) => row.id)).toEqual([
      "turn-fold:turn-1",
      "assistant-final-entry",
      "user-followup-entry",
      "working-indicator-row",
      "live-activity-row",
    ]);
    const finalRow = rows.find((row) => row.id === "assistant-final-entry");
    expect(finalRow?.kind === "message" && finalRow.showAssistantMeta).toBe(true);
    expect(rows.at(-1)).toMatchObject({ kind: "thinking" });
  });

  it("does not show Thinking once the open run's provider turn has ended", () => {
    const input = {
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message" as const,
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user" as never,
            role: "user" as const,
            text: "Take over the queue",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "running" as const,
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    };

    expect(deriveMessagesTimelineRows(input).at(-1)?.kind).toBe("thinking");
    const ended = deriveMessagesTimelineRows({
      ...input,
      latestRun: { ...input.latestRun, turnEnded: true },
    });
    expect(ended.some((row) => row.kind === "thinking")).toBe(false);
  });

  it("keeps a promptless restart in one active visual response", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "keep going",
            runId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "old-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "old-work",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-before-restart" as never,
            label: "Searched files",
            command: "rg restart",
            tone: "tool" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
        {
          id: "old-stale-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:06Z",
          entry: {
            id: "old-stale-work",
            createdAt: "2026-01-01T00:00:06Z",
            runId: "turn-before-restart" as never,
            label: "Running stale command",
            command: "rg stale",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
        {
          id: "old-commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:08Z",
          message: {
            id: "old-commentary" as never,
            role: "assistant",
            text: "the server restarted, continuing here.",
            runId: "turn-before-restart" as never,
            createdAt: "2026-01-01T00:00:08Z",
            updatedAt: "2026-01-01T00:00:08Z",
            streaming: false,
          },
        },
        {
          id: "new-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:01:05Z",
          entry: {
            id: "new-work",
            createdAt: "2026-01-01T00:01:05Z",
            runId: "turn-after-restart" as never,
            label: "Running tests",
            command: "vp test run",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-after-restart" as never,
        status: "running",
        startedAt: "2026-01-01T00:01:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.some((row) => row.kind === "turn-fold")).toBe(false);
    expect(rows.filter((row) => row.id === "working-indicator-row")).toHaveLength(1);
    expect(rows.findIndex((row) => row.id === "working-indicator-row")).toBeLessThan(
      rows.findIndex((row) => row.id === "old-work-entry"),
    );
    expect(rows.find((row) => row.id === "working-indicator-row")).toMatchObject({
      createdAt: "2026-01-01T00:01:00Z",
    });
    expect(rows.find((row) => row.id === "old-commentary-entry")).toMatchObject({
      showAssistantMeta: false,
      showAssistantCopyButton: false,
      assistantCopyStreaming: true,
    });
    expect(rows.filter((row) => row.kind === "work-live" && row.active)).toEqual([
      expect.objectContaining({ entry: expect.objectContaining({ id: "new-work" }) }),
    ]);
    expect(rows.some((row) => row.kind === "thinking")).toBe(false);
  });

  it("carries the latest thought on the live row while a later tool runs", () => {
    type WorkEntry = Extract<
      Parameters<typeof deriveMessagesTimelineRows>[0]["timelineEntries"][number],
      { kind: "work" }
    >;
    const work = (
      id: string,
      at: string,
      fields: Omit<WorkEntry["entry"], "id" | "createdAt" | "runId" | "label">,
    ): WorkEntry => ({
      id: `${id}-entry`,
      kind: "work",
      createdAt: at,
      entry: { id, createdAt: at, runId: "turn-1" as never, label: id, ...fields },
    });
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        work("old-thought", "2026-01-01T00:00:01Z", {
          itemType: "reasoning",
          detail: "First idea.",
          tone: "thinking" as const,
          toolLifecycleStatus: "completed" as const,
        }),
        work("new-thought", "2026-01-01T00:00:02Z", {
          itemType: "reasoning",
          detail: "Found the cause.",
          tone: "thinking" as const,
          toolLifecycleStatus: "completed" as const,
        }),
        work("running-command", "2026-01-01T00:00:03Z", {
          command: "rg cause",
          requestKind: "command",
          tone: "tool" as const,
          toolLifecycleStatus: "inProgress" as const,
        }),
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.find((row) => row.kind === "work-live")).toMatchObject({
      entry: { id: "running-command" },
      thought: { id: "new-thought" },
    });
  });

  it("keeps an actually running tool in the shared activity row", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "running-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "running-command",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-1" as never,
            label: "Running rg",
            command: "rg toolCall",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
        {
          id: "completed-edit-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:06Z",
          entry: {
            id: "completed-edit",
            createdAt: "2026-01-01T00:00:06Z",
            runId: "turn-1" as never,
            label: "Edited files",
            requestKind: "file-change",
            changedFiles: ["src/one.ts", "src/two.ts"],
            tone: "tool" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
        {
          id: "completed-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:07Z",
          entry: {
            id: "completed-command",
            createdAt: "2026-01-01T00:00:07Z",
            runId: "turn-1" as never,
            label: "Ran tests",
            command: "vp test run",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.map((row) => row.kind)).toEqual(["working", "work-live"]);
    expect(rows.some((row) => row.kind === "thinking")).toBe(false);
    expect(rows.find((row) => row.kind === "work-live")).toMatchObject({
      entry: { id: "running-command" },
      active: true,
      groupedEntries: [
        { id: "running-command" },
        { id: "completed-edit" },
        { id: "completed-command" },
      ],
    });
  });

  it("folds each run of a provider-native subagent thread like a normal turn", () => {
    const threadId = ThreadId.make("subagent-child");
    const rootNodeId = NodeId.make("task-root");
    const at = (second: number) =>
      DateTime.makeUnsafe(new Date(Date.UTC(2026, 8, 25, 22, 51, second)).toISOString());
    const base = (id: string, ordinal: number, second: number, endSecond = second) => ({
      id: TurnItemId.make(id),
      threadId,
      runId: null,
      nodeId: rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed" as const,
      title: null,
      startedAt: at(second),
      completedAt: at(endSecond),
      updatedAt: at(endSecond),
    });
    const prompt = (id: string, ordinal: number, second: number) => ({
      ...base(id, ordinal, second),
      type: "user_message" as const,
      messageId: MessageId.make(id),
      text: `Prompt ${id}`,
      attachments: [],
      inputIntent: "turn_start" as const,
      createdBy: "agent" as const,
      creationSource: "provider" as const,
    });
    const answer = (id: string, ordinal: number, second: number) => ({
      ...base(id, ordinal, second),
      type: "assistant_message" as const,
      messageId: MessageId.make(id),
      text: `Answer ${id}`,
      streaming: false,
    });
    type ResumeState = "running" | "completed" | "failed";
    const items = (resume: ResumeState) =>
      [
        prompt("launch", 1, 0),
        { ...base("launch-ls", 2, 4), type: "command_execution" as const, input: "ls src" },
        {
          ...base("launch-thinking", 3, 8),
          type: "reasoning" as const,
          title: "Thinking",
          text: "Not there.",
          streaming: false,
        },
        answer("launch-answer", 4, 8),
        prompt("resume", 5, 72),
        {
          ...base("resume-ls", 6, 77),
          type: "command_execution" as const,
          input: "ls src",
          status: resume === "running" ? ("running" as const) : ("completed" as const),
          completedAt: resume === "running" ? null : at(77),
        },
        ...(resume === "failed"
          ? [
              {
                ...base("resume-error", 7, 80),
                type: "error" as const,
                status: "failed" as const,
                failure: {
                  class: "provider_error" as const,
                  message: "Subagent failed",
                  code: null,
                  retryable: null,
                },
              },
            ]
          : []),
        ...(resume === "running" ? [] : [answer("resume-answer", 8, 80)]),
      ].map((item, position) => ({
        position,
        visibility: "local" as const,
        sourceThreadId: threadId,
        sourceItemId: item.id,
        item,
      }));
    const rows = (input: {
      resume: ResumeState;
      working: boolean;
      expandedRunIds?: ReadonlySet<RunId>;
    }) =>
      deriveMessagesTimelineRows({
        timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems: items(input.resume),
          optimisticMessages: [],
        }),
        latestRun: null,
        isWorking: input.working,
        runlessWorkActive: input.working,
        ...(input.expandedRunIds === undefined ? {} : { expandedRunIds: input.expandedRunIds }),
        activeTurnStartedAt: input.working ? DateTime.formatIso(at(72)) : null,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
    const shape = (timeline: ReadonlyArray<MessagesTimelineRow>) =>
      timeline.map((row) =>
        row.kind === "turn-fold"
          ? `fold:${row.label}`
          : row.kind === "message"
            ? `${row.message.role}:${row.message.id}`
            : row.kind,
      );

    const settled = rows({ resume: "completed", working: false });
    expect(shape(settled)).toEqual([
      "user:launch",
      "fold:Worked for 8.0s",
      "assistant:launch-answer",
      "user:resume",
      "fold:Worked for 8.0s",
      "assistant:resume-answer",
    ]);

    const launchFold = settled.find((row) => row.kind === "turn-fold");
    if (launchFold?.kind !== "turn-fold") throw new Error("Expected the launch fold");
    const expanded = rows({
      resume: "completed",
      working: false,
      expandedRunIds: new Set([launchFold.runId]),
    });
    expect(shape(expanded)).toEqual([
      "user:launch",
      "fold:Worked for 8.0s",
      "work-toggle",
      "assistant:launch-answer",
      "user:resume",
      "fold:Worked for 8.0s",
      "assistant:resume-answer",
    ]);

    expect(shape(rows({ resume: "running", working: true }))).toEqual([
      "user:launch",
      "fold:Worked for 8.0s",
      "assistant:launch-answer",
      "user:resume",
      "working",
      "work-live",
    ]);

    expect(shape(rows({ resume: "failed", working: false }))).toEqual([
      "user:launch",
      "fold:Worked for 8.0s",
      "assistant:launch-answer",
      "user:resume",
      "work",
      "work",
      "assistant:resume-answer",
    ]);
  });

  it("keeps answered questions in their own row outside tool groups and turn folds", () => {
    const threadId = ThreadId.make("answered-question-thread");
    const runId = RunId.make("answered-question-run");
    const requestId = RuntimeRequestId.make("scope-question");
    const at = (second: number) =>
      DateTime.makeUnsafe(new Date(Date.UTC(2026, 9, 17, 12, 0, second)).toISOString());
    const base = (id: string, ordinal: number, second: number) => ({
      id: TurnItemId.make(id),
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed" as const,
      title: null,
      startedAt: at(second),
      completedAt: at(second),
      updatedAt: at(second),
    });
    const command = (id: string, ordinal: number, second: number) => ({
      ...base(id, ordinal, second),
      type: "command_execution" as const,
      input: `cat ${id}`,
    });
    const items = (settled: boolean) =>
      [
        {
          ...base("prompt", 0, 0),
          type: "user_message" as const,
          messageId: MessageId.make("prompt"),
          text: "Pick a repository",
          attachments: [],
          inputIntent: "turn_start" as const,
          createdBy: "user" as const,
          creationSource: "web" as const,
        },
        command("before", 1, 1),
        {
          ...base("question", 2, 2),
          type: "user_input_request" as const,
          requestId,
          questions: [],
          questionAnswer: {
            requestId,
            questionTextById: { scope: "Which repository?" },
            answers: { scope: "The private one" },
            attachmentsByQuestionId: {},
          },
        },
        command("after", 3, 3),
        settled
          ? {
              ...base("answer", 4, 5),
              type: "assistant_message" as const,
              messageId: MessageId.make("answer"),
              text: "Done",
              streaming: false,
            }
          : { ...command("running", 4, 4), status: "running" as const, completedAt: null },
      ].map((item, position) => ({
        position,
        visibility: "local" as const,
        sourceThreadId: threadId,
        sourceItemId: item.id,
        item,
      }));
    const rows = (settled: boolean, expandedRunIds?: ReadonlySet<RunId>) =>
      deriveMessagesTimelineRows({
        timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems: items(settled),
          optimisticMessages: [],
        }),
        latestRun: {
          runId,
          status: settled ? "completed" : "running",
          startedAt: DateTime.formatIso(at(0)),
          completedAt: settled ? DateTime.formatIso(at(5)) : null,
        },
        runningRunId: settled ? null : runId,
        isWorking: !settled,
        activeTurnStartedAt: settled ? null : DateTime.formatIso(at(0)),
        ...(expandedRunIds === undefined ? {} : { expandedRunIds }),
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
    const shape = (timeline: ReadonlyArray<MessagesTimelineRow>) =>
      timeline.map((row) =>
        row.kind === "turn-fold"
          ? "fold"
          : row.kind === "message"
            ? `${row.message.role}:${row.message.id}`
            : row.kind === "work" || row.kind === "work-live"
              ? `${row.kind}:${row.groupedEntries.map((entry) => entry.id).join(" + ")}`
              : row.kind,
      );

    expect(shape(rows(true))).toEqual(["user:prompt", "fold", "work:question", "assistant:answer"]);
    expect(shape(rows(true, new Set([runId])))).toEqual([
      "user:prompt",
      "fold",
      "work:before",
      "work:question",
      "work:after",
      "assistant:answer",
    ]);
    expect(shape(rows(false))).toEqual([
      "user:prompt",
      "working",
      "work:before",
      "work:question",
      "work-live:after + running",
    ]);
  });

  it("keeps imported V1 turns folded once the thread's first V2 run starts", () => {
    const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, "0")}Z`;
    const message = (
      id: string,
      role: "user" | "assistant",
      second: number,
      runId: string | null = null,
    ) => ({
      id,
      kind: "message" as const,
      createdAt: at(second),
      message: {
        id: id as never,
        role,
        text: id,
        runId: runId as never,
        createdAt: at(second),
        updatedAt: at(second),
        streaming: false,
      },
    });
    const rows = (tail: ReadonlyArray<ReturnType<typeof message>>) =>
      deriveMessagesTimelineRows({
        timelineEntries: [
          message("imported-prompt", "user", 0),
          message("imported-update", "assistant", 4),
          {
            id: "imported-command",
            kind: "work",
            createdAt: at(5),
            entry: {
              id: "imported-command",
              createdAt: at(5),
              runId: null,
              label: "Ran git",
              command: "git status",
              requestKind: "command",
              tone: "tool" as const,
              toolLifecycleStatus: "completed" as const,
            },
          },
          message("imported-answer", "assistant", 8),
          ...tail,
        ],
        latestRun: {
          runId: "run-1" as never,
          status: "running",
          startedAt: at(20),
          completedAt: null,
        },
        isWorking: true,
        activeTurnStartedAt: at(20),
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      }).map((row) =>
        row.kind === "message" ? `${row.message.role}:${row.message.id}` : row.kind,
      );

    expect(rows([message("new-prompt", "user", 20, "run-1")]).slice(0, 4)).toEqual([
      "user:imported-prompt",
      "turn-fold",
      "assistant:imported-answer",
      "user:new-prompt",
    ]);
    const withoutPrompt = rows([]);
    expect(withoutPrompt).toContain("turn-fold");
    expect(withoutPrompt).not.toContain("assistant:imported-update");

    const timelineEntries = [
      message("imported-prompt", "user", 0),
      message("imported-update", "assistant", 4),
      message("imported-answer", "assistant", 8),
    ];
    const foldInput = { timelineEntries, latestRun: null, isWorking: false };
    const foldRunIds = timelineTurnFoldRunIdsByEntryId(foldInput);
    const foldRunId = foldRunIds.get("imported-update") ?? null;
    expect(foldRunId).not.toBeNull();
    const foldRow = deriveMessagesTimelineRows({
      ...foldInput,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    }).find((row) => row.kind === "turn-fold");
    expect(foldRow?.kind === "turn-fold" ? foldRow.runId : null).toBe(foldRunId);
    expect(foldRunIds.get("imported-answer") ?? null).toBeNull();
    const expanded = deriveMessagesTimelineRows({
      ...foldInput,
      expandedRunIds: new Set([foldRunId!]),
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(
      expanded.some((row) => row.kind === "message" && row.message.id === "imported-update"),
    ).toBe(true);
  });

  it("does not treat runless entries as live work on a thread with runs", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "runless-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "runless-command",
            createdAt: "2026-01-01T00:00:05Z",
            runId: null,
            label: "Running git",
            command: "git status",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.some((row) => row.kind === "work-live")).toBe(false);
    expect(rows.at(-1)?.kind).toBe("thinking");
  });

  it("keeps separated in-progress tool runs visible", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "first-running-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "first-running",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-1" as never,
            label: "Running first command",
            command: "rg first",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
        {
          id: "assistant-commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:06Z",
          message: {
            id: "assistant-commentary" as never,
            role: "assistant",
            text: "Starting another command.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:06Z",
            updatedAt: "2026-01-01T00:00:06Z",
            streaming: false,
          },
        },
        {
          id: "second-running-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:07Z",
          entry: {
            id: "second-running",
            createdAt: "2026-01-01T00:00:07Z",
            runId: "turn-1" as never,
            label: "Running second command",
            command: "rg second",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.map((row) => row.kind)).toEqual(["working", "work-live", "message", "work-live"]);
    expect(rows.filter((row) => row.kind === "work-live").map((row) => row.entry.id)).toEqual([
      "first-running",
      "second-running",
    ]);
  });

  it("does not revive stale in-progress tools before a fresh send has a turn id", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "stale-running-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "stale-running",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-1" as never,
            label: "Running stale command",
            command: "rg stale",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
        {
          id: "user-followup-entry",
          kind: "message",
          createdAt: "2026-01-01T00:01:00Z",
          message: {
            id: "user-followup" as never,
            role: "user",
            text: "continue",
            runId: null,
            createdAt: "2026-01-01T00:01:00Z",
            updatedAt: "2026-01-01T00:01:00Z",
            streaming: false,
          },
        },
      ],
      latestRun: null,
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.some((row) => row.kind === "work-live")).toBe(false);
  });

  it.each([
    ["inProgress", true],
    ["completed", false],
    ["failed", null],
  ] as const)(
    "respects the %s lifecycle of trailing task progress",
    (toolLifecycleStatus, active) => {
      const runId = RunId.make("turn-task-progress");
      const rows = deriveMessagesTimelineRows({
        timelineEntries: [
          {
            id: "task-progress-entry",
            kind: "work",
            createdAt: "2026-01-01T00:00:05Z",
            entry: {
              id: "task-progress",
              createdAt: "2026-01-01T00:00:05Z",
              runId,
              label: "Task progress",
              tone: "thinking",
              sourceActivityKind: "task.progress",
              ...(toolLifecycleStatus ? { toolLifecycleStatus } : {}),
            },
          },
        ],
        latestRun: {
          runId,
          status: "running",
          startedAt: "2026-01-01T00:00:00Z",
          completedAt: null,
        },
        isWorking: true,
        activeTurnStartedAt: "2026-01-01T00:00:00Z",
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });

      const workLiveRow = rows.find((row) => row.kind === "work-live");
      if (active === null) {
        expect(workLiveRow).toBeUndefined();
        expect(rows.at(-1)).toMatchObject({ kind: "thinking", id: "live-activity-row" });
      } else {
        expect(workLiveRow).toMatchObject({ active });
      }
    },
  );

  it("reuses one activity row for initial thinking and the latest tool", () => {
    const deriveRows = (
      toolLifecycleStatus: "inProgress" | "completed" | "failed" | "declined" | null,
      expandedWorkGroupIds?: ReadonlySet<string>,
    ) =>
      deriveMessagesTimelineRows({
        ...(expandedWorkGroupIds ? { expandedWorkGroupIds } : {}),
        timelineEntries:
          toolLifecycleStatus === null
            ? []
            : [
                {
                  id: "latest-command-entry",
                  kind: "work",
                  createdAt: "2026-01-01T00:00:05Z",
                  entry: {
                    id: "latest-command",
                    createdAt: "2026-01-01T00:00:05Z",
                    runId: "turn-1" as never,
                    label: toolLifecycleStatus === "inProgress" ? "Running rg" : "Ran rg",
                    command: "rg toolCall",
                    requestKind: "command",
                    tone: "tool" as const,
                    toolLifecycleStatus,
                    ...(toolLifecycleStatus === "inProgress" ? { detail: "exit code 1" } : {}),
                  },
                },
              ],
        latestRun: {
          runId: "turn-1" as never,
          status: "running",
          startedAt: "2026-01-01T00:00:00Z",
          completedAt: null,
        },
        isWorking: true,
        activeTurnStartedAt: "2026-01-01T00:00:00Z",
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });

    const initialRows = deriveRows(null);
    const runningRows = deriveRows("inProgress");
    const completedRows = deriveRows("completed");
    const failedRows = deriveRows("failed");
    const declinedRows = deriveRows("declined");
    const initialActivityRow = initialRows.find((row) => row.id === "live-activity-row");
    const runningActivityRow = runningRows.find((row) => row.id === "live-activity-row");
    const completedActivityRow = completedRows.find((row) => row.id === "live-activity-row");

    expect(initialActivityRow).toMatchObject({ kind: "thinking" });
    expect(runningActivityRow).toMatchObject({ kind: "work-live", active: true });
    expect(completedActivityRow).toMatchObject({ kind: "work-live", active: true });
    expect(failedRows.some((row) => row.kind === "work-live")).toBe(false);
    expect(failedRows.at(-1)).toMatchObject({ kind: "thinking", id: "live-activity-row" });
    const failedThinkingRow = failedRows.at(-1);
    const failedGroupId =
      failedThinkingRow?.kind === "thinking" ? failedThinkingRow.groupId : undefined;
    expect(failedGroupId).toBeDefined();
    const expandedFailedRows = deriveRows("failed", new Set([failedGroupId!]));
    expect(expandedFailedRows.slice(-2)).toMatchObject([
      { kind: "thinking", id: "live-activity-row", expanded: true },
      {
        kind: "work",
        isExpandedToolGroup: true,
        groupedEntries: [{ id: "latest-command" }],
      },
    ]);
    expect(declinedRows.find((row) => row.kind === "work-live")).toMatchObject({ active: false });
    expect(declinedRows.at(-1)).toMatchObject({ kind: "thinking", id: "live-activity-row" });
    expect(initialRows.filter((row) => row.id === "live-activity-row")).toHaveLength(1);
    expect(runningRows.filter((row) => row.id === "live-activity-row")).toHaveLength(1);
    expect(completedRows.filter((row) => row.id === "live-activity-row")).toHaveLength(1);
    expect(failedRows.filter((row) => row.id === "live-activity-row")).toHaveLength(1);
    expect(declinedRows.filter((row) => row.id === "live-activity-row")).toHaveLength(1);
  });

  it("does not fold the session's running turn when latestRun regresses", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "previous-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "previous-work",
            createdAt: "2026-01-01T00:00:05Z",
            runId: "turn-1" as never,
            label: "Read files",
            tone: "tool" as const,
          },
        },
        {
          id: "user-followup-entry",
          kind: "message",
          createdAt: "2026-01-01T00:01:00Z",
          message: {
            id: "user-followup" as never,
            role: "user",
            text: "continue",
            runId: null,
            createdAt: "2026-01-01T00:01:00Z",
            updatedAt: "2026-01-01T00:01:00Z",
            streaming: false,
          },
        },
        {
          id: "running-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:01:05Z",
          entry: {
            id: "running-work",
            createdAt: "2026-01-01T00:01:05Z",
            runId: "turn-2" as never,
            label: "Searched files",
            tone: "tool" as const,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:25Z",
      },
      runningRunId: "turn-2" as never,
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.filter((row) => row.kind === "turn-fold").map((row) => row.runId)).toEqual([
      "turn-1",
    ]);
    expect(rows.map((row) => row.id)).toContain("live-activity-row");
  });

  it.each([
    ["the later success is hidden", ["failed", "completed", "info"], false],
    ["the later success is visible", ["failed", "info", "completed"], false],
    ["an error-toned entry recovers", ["error", "info", "completed"], false],
    ["the final failure is hidden", ["completed", "failed", "info"], true],
    ["the final failure is visible", ["failed", "info", "failed"], true],
    ["the only failure is visible", ["completed", "info", "failed"], true],
  ] as const)(
    "uses the final tool call for mixed work groups when %s",
    (_, statuses, hasFailure) => {
      const timelineEntries = statuses.map((status, index) => {
        const id = `work-${index}`;
        const createdAt = `2026-01-01T00:00:0${index}Z`;

        return {
          id: `work-entry-${index}`,
          kind: "work" as const,
          createdAt,
          entry:
            status === "info"
              ? { id, createdAt, label: "Status updated", tone: "info" as const }
              : status === "error"
                ? { id, createdAt, label: "Command failed", tone: "error" as const }
                : {
                    id,
                    createdAt,
                    label: "Ran command",
                    tone: "tool" as const,
                    toolLifecycleStatus: status,
                  },
        };
      });

      const rows = deriveMessagesTimelineRows({
        timelineEntries,
        isWorking: false,
        activeTurnStartedAt: null,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });

      expect(rows.find((row) => row.kind === "work-toggle")).toMatchObject({
        hiddenCount: statuses.some((status) => status === "error") ? 2 : 3,
        summary: statuses.some((status) => status === "error")
          ? "Received 1 update and used 1 tool"
          : "Used 2 tools and received 1 update",
        hasFailure,
      });
      if (statuses.some((status) => status === "error")) {
        expect(rows[0]).toMatchObject({
          kind: "work",
          groupedEntries: [{ tone: "error", label: "Command failed" }],
        });
      }
    },
  );
});

describe("v2 run and attempt history", () => {
  it("folds settled-turn commentary and work behind a Worked-for row", () => {
    const timelineEntries = [
      {
        id: "user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        message: {
          id: "user-1" as never,
          role: "user" as const,
          text: "Build it",
          runId: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "assistant-thought-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "assistant-thought" as never,
          role: "assistant" as const,
          text: "Looking around first.",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:06Z",
          streaming: false,
        },
      },
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:08Z",
        entry: {
          id: "work-1",
          createdAt: "2026-01-01T00:00:08Z",
          runId: "turn-1" as never,
          label: "Ran command",
          tone: "tool" as const,
        },
      },
      {
        id: "provider-recovered-entry",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:09Z",
        entry: {
          id: "provider-recovered",
          createdAt: "2026-01-01T00:00:09Z",
          runId: "turn-1" as never,
          label: "Provider recovered (2/5 retries)",
          tone: "info" as const,
          itemType: "error" as const,
          toolLifecycleStatus: "completed" as const,
        },
      },
      {
        id: "thread-created-entry",
        kind: "event" as const,
        createdAt: "2026-01-01T00:00:10Z",
        projectedItem: {
          item: {
            type: "thread_created",
          },
        } as never,
      },
      {
        id: "assistant-final-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:20Z",
        message: {
          id: "assistant-final" as never,
          role: "assistant" as const,
          text: "Done",
          runId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:20Z",
          updatedAt: "2026-01-01T00:00:22Z",
          streaming: false,
        },
      },
    ];

    const collapsedRows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    const foldRow = collapsedRows.find(
      (row): row is Extract<(typeof collapsedRows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    expect(foldRow?.runId).toBe("turn-1");
    expect(foldRow?.expanded).toBe(false);
    expect(foldRow?.label).toBe("Worked for 22s");
    expect(collapsedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "thread-created-entry",
      "assistant-final-entry",
    ]);

    const expandedRows = deriveMessagesTimelineRows({
      timelineEntries,
      expandedRunIds: new Set(["turn-1" as never]),
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(expandedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-thought-entry",
      "work-toggle:work-entry-1",
      "thread-created-entry",
      "assistant-final-entry",
    ]);
    expect(
      expandedRows.find((row) => row.kind === "turn-fold" && row.expanded === true),
    ).toBeDefined();
    const openedActivity = deriveMessagesTimelineRows({
      timelineEntries,
      expandedRunIds: new Set(["turn-1" as never]),
      expandedWorkGroupIds: new Set(["work-group:work-entry-1"]),
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    const expandedWork = openedActivity.find((row) => row.kind === "work");
    expect(expandedWork?.kind === "work" ? expandedWork.groupedEntries : []).toEqual([
      expect.objectContaining({ id: "work-1" }),
      expect.objectContaining({ id: "provider-recovered" }),
    ]);
  });
  it("collapses only output from a superseded V2 attempt within the active logical run", () => {
    const runId = "run-steered" as never;
    const supersededAttemptId = "attempt-1" as never;
    const activeAttemptId = "attempt-2" as never;
    const supersededAttempt = {
      id: supersededAttemptId,
      runId,
      attemptOrdinal: 1,
      rootNodeId: "node-attempt-1" as never,
      status: "superseded" as const,
      completedAt: null,
    };
    const activeAttempt = {
      id: activeAttemptId,
      runId,
      attemptOrdinal: 2,
      rootNodeId: "node-attempt-2" as never,
      status: "running" as const,
      completedAt: null,
    };
    const timelineEntries = [
      {
        id: "context-handoff-entry",
        kind: "event" as const,
        createdAt: "2026-01-01T00:00:00Z",
        attempt: supersededAttempt,
        projectedItem: {
          item: { type: "handoff", runId },
        } as never,
      },
      {
        id: "initial-user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        attempt: supersededAttempt,
        message: {
          id: "initial-user" as never,
          role: "user" as const,
          text: "Build it",
          runId,
          inputIntent: "turn_start" as const,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "superseded-assistant-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:02Z",
        attempt: supersededAttempt,
        message: {
          id: "superseded-assistant" as never,
          role: "assistant" as const,
          text: "Partial old response",
          runId,
          createdAt: "2026-01-01T00:00:02Z",
          updatedAt: "2026-01-01T00:00:03Z",
          streaming: false,
        },
      },
      {
        id: "superseded-work-entry",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:04Z",
        attempt: supersededAttempt,
        entry: {
          id: "superseded-work",
          createdAt: "2026-01-01T00:00:04Z",
          runId,
          label: "Old command",
          tone: "tool" as const,
          projectedItem: {
            sourceItemId: "old-work-anchor",
            item: {
              type: "command_execution",
              deferredWork: { cursor: "old-work", itemCount: 200, lastOrdinal: 200 },
            },
          } as never,
        },
      },
      {
        id: "superseded-thread-created-entry",
        kind: "event" as const,
        createdAt: "2026-01-01T00:00:04.500Z",
        attempt: supersededAttempt,
        projectedItem: {
          item: {
            type: "thread_created",
          },
        } as never,
      },
      {
        id: "steer-user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        attempt: activeAttempt,
        message: {
          id: "steer-user" as never,
          role: "user" as const,
          text: "Change direction",
          runId,
          inputIntent: "steer" as const,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:05Z",
          streaming: false,
        },
      },
      {
        id: "active-assistant-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:06Z",
        attempt: activeAttempt,
        message: {
          id: "active-assistant" as never,
          role: "assistant" as const,
          text: "Current response",
          runId,
          createdAt: "2026-01-01T00:00:06Z",
          updatedAt: "2026-01-01T00:00:07Z",
          streaming: true,
        },
      },
    ];
    const common = {
      timelineEntries,
      latestRun: {
        runId,
        status: "running" as const,
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    };

    const collapsedRows = deriveMessagesTimelineRows(common);
    expect(collapsedRows.map((row) => row.id)).toEqual([
      "context-handoff-entry",
      "initial-user-entry",
      `attempt-fold:${supersededAttemptId}`,
      "superseded-thread-created-entry",
      "steer-user-entry",
      "active-assistant-entry",
    ]);
    expect(collapsedRows.find((row) => row.kind === "attempt-fold")).toMatchObject({
      attemptId: supersededAttemptId,
      runId,
      label: "Superseded attempt",
      expanded: false,
      deferredWorkItemIds: ["old-work-anchor"],
    });

    const expandedRows = deriveMessagesTimelineRows({
      ...common,
      expandedAttemptIds: new Set([supersededAttemptId]),
    });
    expect(expandedRows.map((row) => row.id)).toEqual([
      "context-handoff-entry",
      "initial-user-entry",
      `attempt-fold:${supersededAttemptId}`,
      "superseded-assistant-entry",
      "superseded-work-entry",
      "superseded-thread-created-entry",
      "steer-user-entry",
      "active-assistant-entry",
    ]);
    const settledRows = deriveMessagesTimelineRows({
      ...common,
      latestRun: { ...common.latestRun, status: "completed", completedAt: "2026-01-01T00:00:08Z" },
      timelineEntries: timelineEntries.map((entry) =>
        entry.kind === "message" && entry.id === "active-assistant-entry"
          ? { ...entry, message: { ...entry.message, streaming: false } }
          : entry,
      ),
      expandedRunIds: new Set([runId]),
    });
    expect(settledRows.find((row) => row.kind === "attempt-fold")).toMatchObject({
      deferredWorkItemIds: ["old-work-anchor"],
    });
    expect(
      settledRows
        .filter((row) => row.kind === "turn-fold")
        .flatMap((row) => row.deferredWorkItemIds ?? []),
    ).not.toContain("old-work-anchor");
    const deferredTailRows = deriveMessagesTimelineRows({
      ...common,
      timelineEntries: [
        timelineEntries[0]!,
        timelineEntries[2]!,
        timelineEntries[1]!,
        ...timelineEntries.slice(3),
      ].map((entry) => ({
        ...entry,
        attempt:
          entry.attempt.id === supersededAttemptId
            ? { ...entry.attempt, completedAt: DateTime.makeUnsafe("2026-01-01T00:00:08Z") }
            : entry.attempt,
        ...(entry.id === "superseded-assistant-entry"
          ? {
              projectedItem: {
                item: {
                  type: "assistant_message",
                  ordinal: 2,
                  status: "completed",
                  completedAt: DateTime.makeUnsafe("2026-01-01T00:00:03Z"),
                },
              } as never,
            }
          : {}),
      })),
    });
    expect(deferredTailRows.some((row) => row.kind === "attempt-fold")).toBe(true);
  });

  describe("a steer that supersedes an attempt", () => {
    const runId = RunId.make("run-steered");
    const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, "0")}Z`;
    const supersededAttempt = {
      id: RunAttemptId.make("attempt-1"),
      runId,
      attemptOrdinal: 1,
      rootNodeId: NodeId.make("node-attempt-1"),
      status: "superseded" as const,
      completedAt: DateTime.makeUnsafe(at(10)),
    };
    const nextAttempt = {
      id: RunAttemptId.make("attempt-2"),
      runId,
      attemptOrdinal: 2,
      rootNodeId: NodeId.make("node-attempt-2"),
      status: "completed" as const,
      completedAt: DateTime.makeUnsafe(at(14)),
    };
    const assistantEntry = (
      id: string,
      attempt: typeof supersededAttempt | typeof nextAttempt,
      completedSecond: number,
    ): TimelineEntry => ({
      id,
      kind: "message",
      createdAt: at(2),
      attempt,
      message: {
        id: MessageId.make(id),
        role: "assistant",
        text: `${id} text`,
        runId,
        createdAt: at(2),
        updatedAt: at(completedSecond),
        streaming: false,
      },
      projectedItem: {
        item: {
          type: "assistant_message",
          status: "completed",
          completedAt: DateTime.makeUnsafe(at(completedSecond)),
        },
      } as never,
    });
    const rowsFor = (
      replyCompletedSecond: number,
      runStatus: "running" | "completed" = "completed",
    ) =>
      deriveMessagesTimelineRows({
        timelineEntries: [
          {
            id: "initial-user-entry",
            kind: "message",
            createdAt: at(0),
            attempt: supersededAttempt,
            message: {
              id: MessageId.make("initial-user"),
              role: "user",
              text: "Build it",
              runId,
              inputIntent: "turn_start",
              createdAt: at(0),
              updatedAt: at(0),
              streaming: false,
            },
          },
          {
            id: "old-work-entry",
            kind: "work",
            createdAt: at(1),
            attempt: supersededAttempt,
            entry: { id: "old-work", createdAt: at(1), runId, label: "Read", tone: "tool" },
          },
          assistantEntry("old-reply-entry", supersededAttempt, replyCompletedSecond),
          {
            id: "steer-user-entry",
            kind: "message",
            createdAt: at(10),
            attempt: nextAttempt,
            message: {
              id: MessageId.make("steer-user"),
              role: "user",
              text: "What are you working on?",
              runId,
              inputIntent: "steer",
              createdAt: at(10),
              updatedAt: at(10),
              streaming: false,
            },
          },
          assistantEntry("new-reply-entry", nextAttempt, 14),
        ],
        latestRun: {
          runId,
          status: runStatus,
          startedAt: at(0),
          completedAt: runStatus === "completed" ? at(14) : null,
        },
        isWorking: false,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });

    it.each(["running", "completed"] as const)(
      "keeps a reply that finished before the steer visible while the run is %s",
      (runStatus) => {
        const rows = rowsFor(4, runStatus);
        expect(rows.some((row) => row.kind === "attempt-fold")).toBe(false);
        expect(rows.map((row) => row.id)).toContain("old-reply-entry");
      },
    );

    it("folds a reply the steer cut off as partial output", () => {
      const rows = rowsFor(11, "running");
      expect(rows.find((row) => row.kind === "attempt-fold")).toMatchObject({
        attemptId: supersededAttempt.id,
        label: "Superseded attempt",
      });
      expect(rows.map((row) => row.id)).not.toContain("old-reply-entry");
    });
  });

  it("hides the interruption request while keeping intervening work and the result", () => {
    const runId = "turn-1" as never;
    const interruptEvent = (type: "run_interrupt_request" | "run_interrupt_result") => ({
      position: type === "run_interrupt_request" ? 0 : 2,
      visibility: "local" as const,
      sourceThreadId: "thread-1" as never,
      sourceItemId: `item-${type}` as never,
      item: {
        id: `item-${type}`,
        threadId: "thread-1",
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: type === "run_interrupt_request" ? 0 : 2,
        status: "completed",
        title: null,
        startedAt: null,
        completedAt: null,
        updatedAt: {},
        type,
        message: type === "run_interrupt_request" ? "Stopping" : "Stopped",
      },
    });
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "interrupt-request",
          kind: "event",
          createdAt: "2026-01-01T00:00:01Z",
          projectedItem: interruptEvent("run_interrupt_request") as never,
        },
        {
          id: "work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:02Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:02Z",
            runId,
            label: "Finishing tool output",
            tone: "tool",
          },
        },
        {
          id: "interrupt-result",
          kind: "event",
          createdAt: "2026-01-01T00:00:03Z",
          projectedItem: interruptEvent("run_interrupt_result") as never,
        },
      ],
      latestRun: {
        runId,
        status: "interrupted",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:03Z",
      },
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

    expect(rows.map((row) => row.id)).toEqual(["work-entry", "interrupt-result"]);
    expect(rows.some((row) => row.kind === "turn-fold")).toBe(false);

    const stoppedRows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "stopped-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:01Z",
          entry: {
            id: "stopped-command",
            createdAt: "2026-01-01T00:00:01Z",
            runId,
            label: "Ran command",
            tone: "tool",
            itemType: "command_execution",
            command: "/bin/bash -lc 'sleep 90 && echo slept'",
            toolLifecycleStatus: "stopped",
          },
        },
        {
          id: "interrupt-result",
          kind: "event",
          createdAt: "2026-01-01T00:00:03Z",
          projectedItem: interruptEvent("run_interrupt_result") as never,
        },
      ],
      latestRun: {
        runId,
        status: "interrupted",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:03Z",
      },
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(stoppedRows.map((row) => row.id)).toEqual(["stopped-command-entry", "interrupt-result"]);
    expect(stoppedRows[0]).toMatchObject({
      kind: "work",
      displayLabel: "sleep 90 && echo slept",
    });
  });
});

it.each([
  [undefined, ["first"]],
  [["first"], ["second"]],
  [["first"], []],
  [
    ["first", "second"],
    ["second", "first"],
  ],
  [undefined, []],
] as const)("keeps deferred fold anchors current from %j to %j", (before, after) => {
  const row: Extract<MessagesTimelineRow, { kind: "turn-fold" }> = {
    kind: "turn-fold",
    id: "fold",
    runId: RunId.make("run"),
    createdAt: "2026-01-01T00:00:00Z",
    label: "Worked for 1m",
    expanded: true,
    ...(before === undefined ? {} : { deferredWorkItemIds: before }),
  };
  const previous = computeStableMessagesTimelineRows([row], { result: [], byId: new Map() });
  const nextRow = { ...row, deferredWorkItemIds: after };
  const next = computeStableMessagesTimelineRows([nextRow], previous);
  const fold = next.result[0];
  expect(fold?.kind === "turn-fold" ? (fold.deferredWorkItemIds ?? []) : null).toEqual(after);
  expect(
    computeStableMessagesTimelineRows([{ ...nextRow, deferredWorkItemIds: [...after] }], next),
  ).toBe(next);
});

describe("streaming v2 row projection", () => {
  function fixture(text = "") {
    const source = makeStreamingTimelineFixture(text);
    const timelineInput = { visibleTurnItems: source.visibleTurnItems, optimisticMessages: [] };
    const timeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(timelineInput);
    const input = {
      timelineEntries: timeline.entries,
      latestRun: {
        runId: source.runId,
        status: "running" as const,
        startedAt: source.time(5),
        completedAt: null,
      },
      runningRunId: source.runId,
      isWorking: true,
      activeTurnStartedAt: source.time(5),
      turnDiffSummaries: [
        {
          runId: source.historyRunId,
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("refs/t3/checkpoints/history"),
          status: "ready",
          files: [],
          assistantMessageId: MessageId.make("history-assistant"),
          completedAt: source.time(4),
        },
      ] satisfies ReadonlyArray<TurnDiffSummary>,
      supportsConversationRollback: true,
    } satisfies Parameters<typeof deriveMessagesTimelineRows>[0];
    return { ...source, timelineInput, timeline, input };
  }

  function updateText(items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>, text: string) {
    return items.map((row) =>
      row.item.type === "assistant_message" && row.item.streaming
        ? {
            ...row,
            item: { ...row.item, text, updatedAt: DateTime.makeUnsafe("2026-09-04T00:00:08.000Z") },
          }
        : row,
    );
  }

  it.each([
    ["", "Now visible"],
    [" \n", "Now visible"],
    ["Visible", ""],
    ["", " \t\n"],
    ["Visible", "★ Insight\nKeep these line breaks"],
  ])("keeps row parity and history identity from %j to %j", (before, after) => {
    const initial = fixture(before);
    const previous = deriveMessagesTimelineRowsWithState({
      ...initial.input,
      availableRevertTurnCounts: new Set([0]),
      pendingApprovalRequestIds: new Set<RuntimeRequestId>(),
    });
    Object.freeze(previous.rows);
    for (const row of previous.rows) Object.freeze(row);
    const timelineInput = {
      ...initial.timelineInput,
      visibleTurnItems: updateText(initial.visibleTurnItems, after),
    };
    const timeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(
      timelineInput,
      initial.timeline,
    );
    const input = {
      ...initial.input,
      timelineEntries: timeline.entries,
      latestRun: { ...initial.input.latestRun },
      turnDiffSummaries: initial.input.turnDiffSummaries.map((summary) => ({ ...summary })),
      availableRevertTurnCounts: new Set([0]),
      pendingApprovalRequestIds: new Set<RuntimeRequestId>(),
    };
    const next = deriveMessagesTimelineRowsWithState(input, previous);
    expect(next.rows).toEqual(
      deriveMessagesTimelineRows({
        ...input,
        timelineEntries: deriveTimelineEntriesFromVisibleTurnItems(timelineInput),
      }),
    );
    for (const [index, row] of previous.rows.entries()) {
      if (
        (row.kind === "message" || row.kind === "assistant-meta") &&
        row.message.id === "live-assistant"
      ) {
        expect(next.rows[index]).toMatchObject({ message: { text: after } });
        expect(next.rows[index]).toHaveProperty(
          "projectedItem",
          timelineInput.visibleTurnItems.at(-1),
        );
        expect(row.message.text).toBe(before);
      } else {
        expect(next.rows[index]).toBe(row);
      }
    }
  });

  it.each(["file", "image", "handoff", "streaming-image"] as const)(
    "keeps history references with %s previews through the v2 materializer",
    (kind) => {
      const initial = fixture("Partial");
      const image = {
        type: "image" as const,
        id: "image",
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 42,
      };
      const file = {
        type: "file" as const,
        id: "file",
        name: "file.txt",
        mimeType: "text/plain",
        sizeBytes: 8,
      };
      const timelineInput = {
        ...initial.timelineInput,
        visibleTurnItems: initial.visibleTurnItems.map((row, index) =>
          (row.item.type === "user_message" && index === 0) ||
          (row.item.type === "assistant_message" &&
            row.item.streaming &&
            kind === "streaming-image")
            ? {
                ...row,
                item: { ...row.item, attachments: kind === "file" ? [file] : [image, file] },
              }
            : row,
        ),
        attachmentUrlById: new Map([
          [image.id, kind === "handoff" ? "blob:handoff" : "https://server.test/image"],
        ]),
      };
      const timeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(timelineInput);
      const input = { ...initial.input, timelineEntries: timeline.entries };
      const previous = deriveMessagesTimelineRowsWithState(input);
      const nextTimelineInput = {
        ...timelineInput,
        visibleTurnItems: updateText(timelineInput.visibleTurnItems, "Next token"),
        attachmentUrlById: new Map(timelineInput.attachmentUrlById),
      };
      const nextTimeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(
        nextTimelineInput,
        timeline,
      );
      const nextInput = { ...input, timelineEntries: nextTimeline.entries };
      const next = deriveMessagesTimelineRowsWithState(nextInput, previous);
      expect(next.rows).toEqual(deriveMessagesTimelineRows(nextInput));
      for (const [index, row] of previous.rows.entries()) {
        if (
          (row.kind === "message" || row.kind === "assistant-meta") &&
          row.message.id === "live-assistant"
        )
          continue;
        expect(next.rows[index]).toBe(row);
      }
      const renewedInput = {
        ...nextTimelineInput,
        attachmentUrlById: new Map([[image.id, "https://renewed.test/image"]]),
      };
      const renewedTimeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(
        renewedInput,
        nextTimeline,
      );
      const renewedRowsInput = { ...input, timelineEntries: renewedTimeline.entries };
      const renewed = deriveMessagesTimelineRowsWithState(renewedRowsInput, next);
      expect(renewed.rows).toEqual(deriveMessagesTimelineRows(renewedRowsInput));
      if (kind !== "file") {
        expect(renewed.rows.find((row) => row.id === "history-user")).toMatchObject({
          message: { attachments: [{ previewUrl: "https://renewed.test/image" }, file] },
        });
      }
    },
  );

  it("rebuilds for completion, late failure, metadata, expansion, and older history", () => {
    const initial = fixture("Partial");
    let timeline = initial.timeline;
    let timelineInput = initial.timelineInput;
    let input: Parameters<typeof deriveMessagesTimelineRows>[0] = initial.input;
    let projection = deriveMessagesTimelineRowsWithState(input);
    const check = (changes: Partial<typeof input> = {}) => {
      const previous = projection;
      timeline = deriveTimelineEntriesFromVisibleTurnItemsWithState(timelineInput, timeline);
      input = { ...input, ...changes, timelineEntries: timeline.entries };
      projection = deriveMessagesTimelineRowsWithState(input, previous);
      expect(projection.rows).toEqual(
        deriveMessagesTimelineRows({
          ...input,
          timelineEntries: deriveTimelineEntriesFromVisibleTurnItems(timelineInput),
        }),
      );
      expect(previous.rows).toEqual(deriveMessagesTimelineRows(previous.input));
    };
    timelineInput = {
      ...timelineInput,
      visibleTurnItems: timelineInput.visibleTurnItems.map((row) =>
        row.item.type === "assistant_message" && row.item.streaming
          ? {
              ...row,
              item: {
                ...row.item,
                streaming: false,
                status: "completed",
                text: "Complete",
                updatedAt: DateTime.makeUnsafe(initial.time(9)),
              },
            }
          : row,
      ),
    };
    check({
      latestRun: { ...initial.input.latestRun, status: "completed", completedAt: initial.time(9) },
      runningRunId: null,
      isWorking: false,
    });
    const lateFailure = initial.visibleTurnItems[1]!;
    timelineInput = {
      ...timelineInput,
      visibleTurnItems: [
        ...timelineInput.visibleTurnItems,
        {
          ...lateFailure,
          position: 6,
          sourceItemId: TurnItemId.make("late-failure"),
          item: {
            ...lateFailure.item,
            id: TurnItemId.make("late-failure"),
            runId: initial.runId,
            ordinal: 10,
            startedAt: DateTime.makeUnsafe(initial.time(10)),
          },
        },
      ],
    };
    check();
    timelineInput = {
      ...timelineInput,
      visibleTurnItems: timelineInput.visibleTurnItems.map((row) =>
        row.item.type === "assistant_message" && row.item.messageId === "live-assistant"
          ? {
              ...row,
              item: {
                ...row.item,
                text: "Corrected final text",
                updatedAt: DateTime.makeUnsafe(initial.time(11)),
              },
            }
          : row,
      ),
    };
    check();
    check({
      latestRun: {
        ...initial.input.latestRun,
        status: "interrupted",
        completedAt: initial.time(12),
      },
    });
    check({ expandedRunIds: new Set([initial.historyRunId, initial.runId]) });
    const group = projection.rows.find((row) => row.kind === "work-toggle");
    check({ expandedWorkGroupIds: new Set(group ? [group.groupId] : []) });
    const first = initial.visibleTurnItems[0]!;
    if (first.item.type !== "user_message") throw new Error("Expected user fixture");
    timelineInput = {
      ...timelineInput,
      visibleTurnItems: [
        {
          ...first,
          sourceItemId: TurnItemId.make("older-user-item"),
          item: {
            ...first.item,
            id: TurnItemId.make("older-user-item"),
            messageId: MessageId.make("older-user"),
            startedAt: DateTime.makeUnsafe(initial.time(-60)),
          },
        },
        ...timelineInput.visibleTurnItems,
      ].map((row, position) => ({ ...row, position })),
    };
    check();
    check({ supportsConversationRollback: false });
    check({
      turnDiffSummaries: initial.input.turnDiffSummaries.map((summary) => ({
        ...summary,
        status: "stale" as const,
      })),
    });
  });
});

describe("linked timeline resources", () => {
  const runId = RunId.make("resource-run");
  const event = (id: string, type: "subagent" | "thread_created", eventRunId = runId) => ({
    id,
    kind: "event" as const,
    createdAt: "2026-09-08T10:00:02Z",
    projectedItem: { item: { id, type, runId: eventRunId } } as OrchestrationV2ProjectedTurnItem,
  });
  const common = { isWorking: false, turnDiffSummaries: [], supportsConversationRollback: false };

  it("groups adjacent subagents without merging across a resource or run boundary", () => {
    const rows = deriveMessagesTimelineRows({
      ...common,
      timelineEntries: [
        event("a", "subagent"),
        event("b", "subagent"),
        event("c", "thread_created"),
        event("d", "subagent"),
        event("e", "subagent", RunId.make("other-run")),
      ],
      expandedRunIds: new Set([runId, RunId.make("other-run")]),
    });
    expect(rows.map((row) => row.id)).toEqual([
      "turn-fold:resource-run",
      "a",
      "c",
      "d",
      "turn-fold:other-run",
      "e",
    ]);
    expect(rows[1]).toMatchObject({ subagents: [{ item: { id: "a" } }, { item: { id: "b" } }] });
  });

  it.each([
    { status: "completed", envelope: "direct", role: "general" },
    { status: "completed", envelope: "structured", role: "general" },
    { status: "completed", envelope: "text", role: "general" },
    { status: "completed", envelope: "structured", role: "research" },
    { status: "running", envelope: "direct", role: "general" },
    { status: "running", envelope: "direct", role: "research" },
  ] as const)(
    "matches $status $role delegation calls by child identity with $envelope output",
    ({ status, envelope, role }) => {
      const child = (id: string) => {
        const entry = event(id, "subagent");
        return {
          ...entry,
          projectedItem: {
            item: {
              ...entry.projectedItem.item,
              origin: "app_owned",
              subagentId: id,
              prompt:
                role === "general" ? id : `Act as the ${role} sub-agent for this task.\n\n${id}`,
              childThreadId: null,
            },
          } as OrchestrationV2ProjectedTurnItem,
        };
      };
      const delegation = (id: string, taskId: string, failed = false): TimelineEntry => ({
        id,
        kind: "work",
        createdAt: "2026-09-08T10:00:02Z",
        entry: {
          id,
          runId,
          createdAt: "2026-09-08T10:00:02Z",
          label: "Delegated a child task",
          tone: failed ? "error" : "tool",
          itemType: "dynamic_tool",
          toolLifecycleStatus: failed
            ? "failed"
            : status === "running"
              ? "inProgress"
              : "completed",
          projectedItem: {
            item: {
              id,
              runId,
              type: "dynamic_tool",
              status: failed ? "failed" : status,
              toolName: "t3-code.delegate_task",
              input: { task: taskId === "b" ? "a" : taskId, role },
              ...(status === "completed"
                ? {
                    output:
                      envelope === "structured"
                        ? { content: JSON.stringify({ taskId }), structuredContent: { taskId } }
                        : envelope === "text"
                          ? { content: [{ type: "text", text: JSON.stringify({ taskId }) }] }
                          : { taskId },
                  }
                : {}),
            },
          } as OrchestrationV2ProjectedTurnItem,
        },
      });
      const rows = deriveMessagesTimelineRows({
        ...common,
        isWorking: status === "running",
        runningRunId: status === "running" ? runId : null,
        timelineEntries: [
          child("a"),
          delegation("delegate-a", "a"),
          ...(status === "completed" ? [child("b")] : []),
          delegation("delegate-b", "b"),
          delegation("unmatched", "other-child"),
          child("c"),
          delegation("failed", "c", true),
          child("d"),
        ],
        expandedRunIds: new Set([runId]),
      });
      if (status === "completed") {
        expect(rows.find((row) => row.id === "a")).toMatchObject({
          subagents: [{ item: { id: "a" } }, { item: { id: "b" } }],
        });
        expect(rows.some((row) => row.id === "b")).toBe(false);
      } else {
        expect(rows.find((row) => row.id === "a")).toBeDefined();
        expect(rows.find((row) => row.id === "b")).toBeUndefined();
      }
      expect(rows.find((row) => row.id === "c")).toBeDefined();
      expect(rows.find((row) => row.id === "d")).toBeDefined();
      const visibleTools = rows.flatMap((row) =>
        row.kind === "work" || row.kind === "work-live"
          ? row.groupedEntries.map((entry) => entry.id)
          : [],
      );
      expect(visibleTools).toContain("unmatched");
      expect(visibleTools).toContain("failed");
      expect(visibleTools.includes("delegate-a")).toBe(status === "running");
      expect(visibleTools.includes("delegate-b")).toBe(status === "running");
    },
  );

  it("keeps created-chat summaries after the final answer and folds only their timeline rows", () => {
    const timelineEntries = [
      {
        kind: "message" as const,
        id: "intro",
        createdAt: "2026-09-08T10:00:00Z",
        message: {
          id: MessageId.make("intro"),
          role: "assistant" as const,
          text: "Creating the chat",
          runId,
          streaming: false,
          createdAt: "2026-09-08T10:00:00Z",
          updatedAt: "2026-09-08T10:00:00Z",
        },
      },
      event("created", "thread_created"),
      {
        kind: "message" as const,
        id: "final",
        createdAt: "2026-09-08T10:00:04Z",
        message: {
          id: MessageId.make("final"),
          role: "assistant" as const,
          text: "Chat is ready",
          runId,
          streaming: false,
          createdAt: "2026-09-08T10:00:04Z",
          updatedAt: "2026-09-08T10:00:04Z",
        },
      },
    ];
    const collapsed = deriveMessagesTimelineRows({ ...common, timelineEntries });
    expect(collapsed.map((row) => row.id)).toEqual([
      "turn-fold:resource-run",
      "final",
      "summary:created",
      "assistant-meta:final",
    ]);
    expect(collapsed.find((row) => row.id === "summary:created")).toMatchObject({
      resourceSummary: true,
    });
    const expanded = deriveMessagesTimelineRows({
      ...common,
      timelineEntries,
      expandedRunIds: new Set([runId]),
    });
    expect(expanded.map((row) => row.id)).toEqual([
      "turn-fold:resource-run",
      "intro",
      "created",
      "final",
      "summary:created",
      "assistant-meta:final",
    ]);
  });

  it("shows a created chat after a steer only when that steer's segment is open", () => {
    const message = (id: string, role: "user" | "assistant", second: number) => ({
      kind: "message" as const,
      id,
      createdAt: `2026-09-08T10:00:0${second}Z`,
      message: {
        id: MessageId.make(id),
        role,
        text: id,
        runId,
        ...(role === "user" ? { inputIntent: "steer" as const } : {}),
        streaming: false,
        createdAt: `2026-09-08T10:00:0${second}Z`,
        updatedAt: `2026-09-08T10:00:0${second}Z`,
      },
    });
    const timelineEntries = [
      message("intro", "assistant", 0),
      message("steer", "user", 1),
      event("created", "thread_created"),
      message("after-steer", "assistant", 3),
      message("final", "assistant", 4),
    ];
    const segmentKey = RunId.make(`${runId}:steer:steer`);
    const rowIds = (expanded: RunId[]) =>
      deriveMessagesTimelineRows({
        ...common,
        timelineEntries,
        expandedRunIds: new Set(expanded),
      }).map((row) => row.id);
    expect(rowIds([runId])).not.toContain("created");
    expect(rowIds([segmentKey])).toEqual([
      `turn-fold:${runId}`,
      "steer",
      `turn-fold:${segmentKey}`,
      "created",
      "after-steer",
      "final",
      "summary:created",
      "assistant-meta:final",
    ]);
  });
});

it.each([true, false])(
  "keeps completed responses folded across notification wakes, working=%s",
  (isWorking) => {
    const time = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
    const work = (id: string, run: string, second: number, notification = false) => ({
      kind: "work" as const,
      id,
      createdAt: time(second),
      entry: {
        id,
        runId: RunId.make(run),
        createdAt: time(second),
        label: id,
        tone: "info" as const,
        ...(notification ? { itemType: "notification" as const } : {}),
      },
    });
    const answer = (id: string, run: string, second: number) => ({
      kind: "message" as const,
      id,
      createdAt: time(second),
      message: {
        id: MessageId.make(id),
        role: "assistant" as const,
        text: id,
        runId: RunId.make(run),
        createdAt: time(second),
        updatedAt: time(second),
        streaming: false,
      },
    });
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        work("launch-tools", "initial", 1),
        answer("launched", "initial", 5),
        work("notification-a", "wake-a", 20, true),
        work("read-a", "wake-a", 21),
        answer("ack-a", "wake-a", 25),
        work("notification-b", "wake-b", 40, true),
        work("read-b", "wake-b", 41),
        ...(!isWorking ? [answer("ack-b", "wake-b", 45)] : []),
      ],
      latestRun: {
        runId: RunId.make("wake-b"),
        status: isWorking ? "running" : "completed",
        startedAt: time(40),
        completedAt: isWorking ? null : time(45),
      },
      isWorking,
      activeTurnStartedAt: time(40),
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    const ids = rows.map((row) => row.id);
    expect(ids).toContain("turn-fold:initial");
    expect(ids).not.toContain("launch-tools");
    expect(ids).toContain("turn-fold:wake-a");
    expect(ids.indexOf("notification-a")).toBeLessThan(ids.indexOf("turn-fold:wake-a"));
    expect(ids.indexOf("turn-fold:wake-a")).toBeLessThan(ids.indexOf("ack-a"));
    const boundary = isWorking ? "working-indicator-row" : "turn-fold:wake-b";
    expect(ids).toContain(boundary);
    expect(ids.indexOf("notification-b")).toBeLessThan(ids.indexOf(boundary));
    if (isWorking) expect(rows.find((row) => row.id === boundary)?.createdAt).toBe(time(40));
  },
);

it("keeps the working header in place across worktree setup handoff", () => {
  const snapshot: WorktreeSetupSnapshot = {
    threadId: ThreadId.make("thread-setup"),
    phase: "running",
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: null,
    branch: "feature",
    baseRef: "main",
    worktreePath: null,
    setupScript: null,
    stages: [],
    error: null,
    sequence: 3,
  };
  const userEntry = {
    id: "user-entry",
    kind: "message",
    createdAt: "2026-01-01T00:00:00Z",
    message: {
      id: "user-1" as never,
      role: "user",
      text: "Build it",
      runId: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      streaming: false,
    },
  } as const;
  const assistantEntry = {
    id: "assistant-entry",
    kind: "message",
    createdAt: "2026-01-01T00:00:30Z",
    message: {
      id: "assistant-1" as never,
      role: "assistant",
      text: "On it",
      runId: "turn-1" as never,
      createdAt: "2026-01-01T00:00:30Z",
      updatedAt: "2026-01-01T00:00:30Z",
      streaming: true,
    },
  } as const;
  const withoutMessages = deriveMessagesTimelineRows({
    timelineEntries: [],
    isWorking: true,
    activeTurnStartedAt: "2026-01-01T00:00:00Z",
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    worktreeSetup: snapshot,
  });
  expect(withoutMessages).toEqual([
    { kind: "working", id: "working-indicator-row", createdAt: snapshot.startedAt },
    {
      kind: "worktree-setup",
      id: "worktree-setup-row",
      createdAt: "2026-01-01T00:00:00Z",
      snapshot,
      embedded: false,
    },
  ]);

  const withMessages = deriveMessagesTimelineRows({
    timelineEntries: [userEntry, assistantEntry],
    isWorking: true,
    activeTurnStartedAt: "2026-01-01T00:00:00Z",
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    worktreeSetup: { ...snapshot, phase: "failed" },
  });
  expect(withMessages.map((row) => row.kind)).toEqual([
    "message",
    "worktree-setup",
    "working",
    "message",
    "thinking",
  ]);

  const stage = (id: "agent" | "setup-script", status: "done" | "running") =>
    ({
      id,
      status,
      startedAt: "2026-01-01T00:00:10Z",
      endedAt: status === "done" ? "2026-01-01T00:00:11Z" : null,
      percent: null,
      detail: null,
      tail: [],
    }) as const;
  const asyncSnapshot: WorktreeSetupSnapshot = {
    ...snapshot,
    stages: [stage("setup-script", "running"), stage("agent", "done")],
  };
  const liveTurn = {
    runId: "turn-1" as never,
    status: "running",
    startedAt: "2026-01-01T00:00:11Z",
    completedAt: null,
  } as const;
  const asyncRows = deriveMessagesTimelineRows({
    timelineEntries: [userEntry],
    latestRun: liveTurn,
    isWorking: true,
    activeTurnStartedAt: "2026-01-01T00:00:00Z",
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    worktreeSetup: asyncSnapshot,
  });
  expect(asyncRows.map((row) => row.kind)).toEqual(["message", "working", "thinking"]);

  const handoffRows = deriveMessagesTimelineRows({
    timelineEntries: [userEntry],
    isWorking: true,
    activeTurnStartedAt: "2026-01-01T00:00:00Z",
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    worktreeSetup: asyncSnapshot,
  });
  expect(handoffRows.map((row) => row.kind)).toEqual(["message", "working", "worktree-setup"]);
  expect(handoffRows[2]).toMatchObject({ kind: "worktree-setup", embedded: false });

  const settledRows = deriveMessagesTimelineRows({
    timelineEntries: [userEntry],
    isWorking: true,
    activeTurnStartedAt: "2026-01-01T00:00:00Z",
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    worktreeSetup: {
      ...snapshot,
      phase: "done",
      stages: [stage("setup-script", "done"), stage("agent", "done")],
    },
  });
  expect(settledRows.map((row) => row.kind)).toEqual(["message", "working", "worktree-setup"]);

  const finishedRows = deriveMessagesTimelineRows({
    timelineEntries: [userEntry],
    latestRun: liveTurn,
    isWorking: true,
    activeTurnStartedAt: "2026-01-01T00:00:00Z",
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    worktreeSetup: {
      ...asyncSnapshot,
      stages: [stage("setup-script", "done"), stage("agent", "done")],
    },
  });
  expect(finishedRows.map((row) => row.kind)).toEqual(["message", "working", "thinking"]);
});

describe("failed turn transcript", () => {
  it.each(["provider_error", "usage_limit"] as const)(
    "keeps historical %s failures and preceding work visible without disclosures",
    (failureClass) => {
      const runId = RunId.make("failed-run");
      const threadId = ThreadId.make("failed-thread");
      const at = DateTime.makeUnsafe("2026-09-20T12:00:00Z");
      const base = {
        threadId,
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        title: null,
        startedAt: at,
        completedAt: at,
        updatedAt: at,
      };
      const items: OrchestrationV2ProjectedTurnItem[] = [
        {
          position: 0,
          visibility: "local",
          sourceThreadId: threadId,
          sourceItemId: TurnItemId.make("user"),
          item: {
            ...base,
            id: TurnItemId.make("user"),
            type: "user_message",
            status: "completed",
            messageId: MessageId.make("user"),
            createdBy: "user",
            creationSource: "web",
            inputIntent: "turn_start",
            text: "Build it",
            attachments: [],
          },
        },
        {
          position: 1,
          visibility: "local",
          sourceThreadId: threadId,
          sourceItemId: TurnItemId.make("command"),
          item: {
            ...base,
            id: TurnItemId.make("command"),
            type: "command_execution",
            status: "completed",
            input: "pwd",
            output: "",
            exitCode: 0,
          },
        },
        {
          position: 2,
          visibility: "local",
          sourceThreadId: threadId,
          sourceItemId: TurnItemId.make("failure"),
          item: {
            ...base,
            id: TurnItemId.make("failure"),
            type: "error",
            status: "failed",
            failure: {
              class: failureClass,
              message: "The provider stopped this turn.\nRetry later.",
              code: null,
              retryable: true,
            },
          },
        },
      ];
      const rows = deriveMessagesTimelineRows({
        timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems: items,
          optimisticMessages: [],
        }).map((entry) => ({
          ...entry,
          attempt: {
            id: RunAttemptId.make("superseded-attempt"),
            runId,
            attemptOrdinal: 1,
            rootNodeId: NodeId.make("superseded-root"),
            status: "superseded" as const,
            completedAt: null,
          },
        })),
        latestRun: {
          runId: RunId.make("newer-run"),
          status: "completed",
          startedAt: DateTime.formatIso(at),
          completedAt: DateTime.formatIso(at),
        },
        isWorking: false,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
      expect(
        rows.some(
          (row) =>
            row.kind === "turn-fold" || row.kind === "attempt-fold" || row.kind === "work-toggle",
        ),
      ).toBe(false);
      const work = rows.flatMap((row) => (row.kind === "work" ? row.groupedEntries : []));
      expect(work.map((entry) => entry.id)).toEqual(["command", "failure"]);
      expect(work.at(-1)?.detail).toBe("The provider stopped this turn.\nRetry later.");
      expect(work.at(-1)?.createdAt).toBe("2026-09-20T12:00:00.000Z");
      const entriesWithoutTools = deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: items.filter((row) => row.item.type !== "command_execution"),
        optimisticMessages: [],
      });
      entriesWithoutTools.splice(1, 0, {
        kind: "message",
        id: "assistant-before-failure",
        createdAt: DateTime.formatIso(at),
        message: {
          id: MessageId.make("assistant-before-failure"),
          role: "assistant",
          runId,
          text: "Checking the workspace.",
          createdAt: DateTime.formatIso(at),
          updatedAt: DateTime.formatIso(at),
          streaming: false,
        },
      });
      const compactRows = deriveMessagesTimelineRows({
        timelineEntries: entriesWithoutTools,
        isWorking: false,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      });
      expect(compactRows.map((row) => row.kind)).toEqual([
        "message",
        "message",
        "work",
        "assistant-meta",
      ]);
      expect(compactRows[1]).toMatchObject({ showAssistantMeta: false });
      expect(compactRows.at(-1)).toMatchObject({
        kind: "assistant-meta",
        showAssistantCopyButton: true,
        message: { id: "assistant-before-failure" },
      });
    },
  );
});

describe("live subagents after their parent turn settles", () => {
  const runId = RunId.make("parent-run");
  const threadId = ThreadId.make("parent-thread");
  const providerTurnId = ProviderTurnId.make("parent-provider-turn");
  const at = (second: number) =>
    DateTime.makeUnsafe(`2026-10-06T10:00:${String(second).padStart(2, "0")}Z`);
  const base = (id: string, second: number) => ({
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: second,
    title: null,
    startedAt: at(second),
    completedAt: at(second),
    updatedAt: at(second),
  });
  const projected = (item: OrchestrationV2TurnItem): OrchestrationV2ProjectedTurnItem => ({
    position: item.ordinal,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: item.id,
    item,
  });
  const child = (
    id: string,
    second: number,
    status: OrchestrationV2TurnItem["status"],
    origin: "app_owned" | "provider_native" = "app_owned",
  ): OrchestrationV2TurnItem => ({
    ...base(id, second),
    status,
    completedAt: status === "running" ? null : at(second),
    type: "subagent",
    subagentId: NodeId.make(id),
    origin,
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    childThreadId: origin === "app_owned" ? ThreadId.make(`${id}-thread`) : null,
    prompt: `Inspect ${id}`,
    result: null,
  });
  const rowsFor = (children: ReadonlyArray<OrchestrationV2TurnItem>) =>
    deriveMessagesTimelineRows({
      timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: (
          [
            {
              ...base("user", 0),
              status: "completed",
              type: "user_message",
              messageId: MessageId.make("user"),
              createdBy: "user",
              creationSource: "web",
              inputIntent: "turn_start",
              text: "Delegate the review",
              attachments: [],
            },
            {
              ...base("reasoning", 1),
              status: "completed",
              type: "reasoning",
              text: "Two children can split this.",
              streaming: false,
            },
            {
              ...base("command", 2),
              status: "completed",
              type: "command_execution",
              input: "pwd",
              output: "/repo",
              exitCode: 0,
            },
            ...children,
            {
              ...base("assistant", 8),
              status: "completed",
              type: "assistant_message",
              messageId: MessageId.make("assistant"),
              text: "Both children are running.",
              streaming: false,
            },
          ] satisfies OrchestrationV2TurnItem[]
        ).map(projected),
        optimisticMessages: [],
      }),
      latestRun: {
        runId,
        status: "completed",
        startedAt: DateTime.formatIso(at(0)),
        completedAt: DateTime.formatIso(at(8)),
      },
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });

  it.each(["app_owned", "provider_native"] as const)(
    "keeps a running %s child visible while the rest of the settled turn folds",
    (origin) => {
      const rows = rowsFor([child("child", 3, "running", origin)]);
      expect(rows.map((row) => row.id)).toEqual([
        "user",
        `turn-fold:${runId}`,
        "child",
        "assistant",
      ]);
    },
  );

  it("keeps a launch batch visible while any member is still running", () => {
    const rows = rowsFor([child("done", 3, "completed"), child("live", 4, "running")]);
    expect(rows.map((row) => row.id)).toEqual(["user", `turn-fold:${runId}`, "done", "assistant"]);
    expect(rows.find((row) => row.id === "done")).toMatchObject({
      subagents: [{ item: { id: "done" } }, { item: { id: "live" } }],
    });
  });

  it("keeps a running child visible when a steer supersedes its attempt", () => {
    const attempt = {
      id: RunAttemptId.make("superseded-attempt"),
      runId,
      attemptOrdinal: 1,
      rootNodeId: NodeId.make("superseded-root"),
      status: "superseded" as const,
      completedAt: null,
    };
    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: (
        [
          {
            ...base("command", 2),
            status: "completed",
            type: "command_execution",
            input: "pwd",
            output: "/repo",
            exitCode: 0,
          },
          child("child", 3, "running"),
        ] satisfies OrchestrationV2TurnItem[]
      ).map(projected),
      optimisticMessages: [],
    }).map((entry) => ({ ...entry, attempt }));
    const rows = deriveMessagesTimelineRows({
      timelineEntries: entries,
      latestRun: {
        runId,
        status: "running",
        startedAt: DateTime.formatIso(at(0)),
        completedAt: null,
      },
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(rows.map((row) => row.id)).toEqual([`attempt-fold:${attempt.id}`, "child"]);
  });
});

describe("subagent continued by a later turn", () => {
  const threadId = ThreadId.make("parent-thread");
  const run1 = RunId.make("run-1");
  const run2 = RunId.make("run-2");
  const at = (second: number) =>
    DateTime.makeUnsafe(`2026-10-09T10:00:${String(second).padStart(2, "0")}Z`);
  const base = (id: string, runId: RunId, ordinal: number, second: number) => ({
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at(second),
    completedAt: at(second),
    updatedAt: at(second),
  });
  const user = (id: string, runId: RunId, ordinal: number, second: number) => ({
    ...base(id, runId, ordinal, second),
    type: "user_message" as const,
    messageId: MessageId.make(id),
    createdBy: "user" as const,
    creationSource: "web" as const,
    inputIntent: "turn_start" as const,
    text: `Prompt ${id}`,
    attachments: [],
  });
  const assistant = (id: string, runId: RunId, ordinal: number, second: number) => ({
    ...base(id, runId, ordinal, second),
    type: "assistant_message" as const,
    messageId: MessageId.make(id),
    text: `Answer ${id}`,
    streaming: false,
  });
  const reasoning = (id: string, runId: RunId, ordinal: number, second: number) => ({
    ...base(id, runId, ordinal, second),
    type: "reasoning" as const,
    text: "Thinking",
    streaming: false,
  });
  const items: OrchestrationV2TurnItem[] = [
    user("prompt-1", run1, 1_000_001, 0),
    reasoning("reasoning-1", run1, 1_000_002, 1),
    {
      ...base("subagent", run2, 1_000_003, 2),
      completedAt: at(40),
      updatedAt: at(40),
      type: "subagent",
      subagentId: NodeId.make("subagent"),
      origin: "provider_native",
      driver: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      childThreadId: null,
      prompt: "Research the bug",
      result: "Found it",
    },
    assistant("answer-1", run1, 1_000_004, 3),
    user("prompt-2", run2, 2_000_001, 30),
    reasoning("reasoning-2", run2, 2_000_002, 31),
    assistant("answer-2", run2, 2_000_003, 32),
    {
      ...base("send-message", run2, 2_000_004, 33),
      type: "dynamic_tool",
      toolName: "SendMessage",
      input: { to: "subagent" },
      output: "Sent",
    },
    assistant("closing-2", run2, 2_000_005, 41),
  ];

  it("keeps each turn's fold between its own prompt and answer", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: items.map((item) => ({
          position: item.ordinal,
          visibility: "local",
          sourceThreadId: threadId,
          sourceItemId: item.id,
          item,
        })),
        optimisticMessages: [],
      }),
      latestRun: {
        runId: run2,
        status: "completed",
        startedAt: DateTime.formatIso(at(30)),
        completedAt: DateTime.formatIso(at(41)),
      },
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(rows.map((row) => row.id)).toEqual([
      "prompt-1",
      `turn-fold:${run1}`,
      "answer-1",
      "prompt-2",
      `turn-fold:${run2}`,
      "closing-2",
    ]);
  });
});

describe("shouldCollapseUserMessage", () => {
  it("measures a quote chip by its label, not its encoded link", () => {
    const quote = "A long assistant paragraph that the user quoted. ".repeat(40);
    const citation = serializeAssistantCitation({
      version: 1,
      environmentId: EnvironmentId.make("environment"),
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make("source"),
      text: quote,
      comment: "Why does this matter?",
      start: 0,
      end: quote.length,
      prefix: "",
      suffix: "",
    });

    expect(shouldCollapseUserMessage(`${citation} Can you expand on this?`)).toBe(false);
    expect(shouldCollapseUserMessage(`${citation} ${"More text. ".repeat(60)}`)).toBe(true);
  });
});
