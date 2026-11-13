import {
  DateTime,
  MessageId,
  RunId,
  RuntimeRequestId,
  TurnItemId,
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  deriveTimelineEntriesFromVisibleTurnItems,
  describe,
  expect,
  it,
  makeStreamingTimelineFixture,
  workEntryDisplayIndicatesToolFailure,
  workEntryDisplayLabel,
  type OrchestrationV2ProjectedTurnItem,
  type TimelineEntry,
} from "./MessagesTimeline.logic-fixtures.ts";

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
});
