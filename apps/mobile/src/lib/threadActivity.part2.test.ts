import {
  MessageId,
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  RuntimeRequestId,
  NodeId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RunAttemptId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { deriveThreadCheckpointSummaries } from "@t3tools/client-runtime/state/thread-checkpoints";
import { summarizeToolGroup } from "@t3tools/client-runtime/work-log/presentation";
import { getReviewSectionIdForCheckpoint } from "../features/review/reviewModel";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadFeed,
  workEntryRowLabel,
  threadFeedCompactionLabels,
  createThreadFeedCache,
  deriveThreadFeedPresentation,
  messageFoldRunId,
  type ThreadFeedCache,
  type ThreadFeedEntry,
  type ThreadFeedLatestRun,
} from "./threadActivity";
import { runId } from "./threadActivity.testkit";
import { assistantMessage, base, command, projected, sourceThreadId, threadId, userMessage } from "./threadActivity.testkit";


describe("buildThreadFeed", () => {
  it("keeps async answers in question history instead of user bubbles", () => {
    const requestId = RuntimeRequestId.make("question");
    const question: OrchestrationV2TurnItem = {
      ...base("question", "2026-06-20T00:00:01.000Z", 0),
      type: "user_input_request",
      requestId,
      questions: [],
      questionAnswer: { requestId, answers: { color: "Blue" }, attachmentsByQuestionId: {} },
    };
    const reply: OrchestrationV2TurnItem = {
      ...userMessage(),
      id: TurnItemId.make("answer"),
      messageId: MessageId.make(`async-answer:${requestId}`),
    };
    const feed = buildThreadFeed([projected(question, 0), projected(reply, 1)]);
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      type: "activity-group",
      activities: [{ workEntry: { questionAnswer: question.questionAnswer } }],
    });
    expect(buildThreadFeed([projected(reply, 0)])[0]?.type).toBe("message");
  });

  it.each([false, true])(
    "keeps answered questions outside settled work (attachments only: %s)",
    (attachmentsOnly) => {
      const requestId = RuntimeRequestId.make("answered-question");
      const question: OrchestrationV2TurnItem = {
        ...base("answered-question", "2026-06-20T00:00:02.500Z", 2),
        type: "user_input_request",
        requestId,
        questions: [],
        questionAnswer: {
          requestId,
          questionTextById: { color: "Which color?" },
          answers: { color: attachmentsOnly ? "" : "Blue" },
          attachmentsByQuestionId: attachmentsOnly
            ? {
                color: [
                  {
                    type: "file",
                    id: "color-file",
                    name: "color.txt",
                    mimeType: "text/plain",
                    sizeBytes: 4,
                  },
                ],
              }
            : {},
        },
      };
      const feed = buildThreadFeed([
        projected(userMessage(), 0),
        projected(command(), 1),
        projected(question, 2),
        projected(assistantMessage(), 3),
      ]);
      const presented = deriveThreadFeedPresentation(feed, null, new Set());
      expect(presented.map((entry) => entry.type)).toEqual([
        "message",
        "run-fold",
        "activity-group",
        "message",
      ]);
      expect(presented[2]).toMatchObject({
        activities: [{ workEntry: { questionAnswer: question.questionAnswer } }],
      });
      expect(
        deriveThreadFeedPresentation(feed, null, new Set([runId])).map((entry) => entry.type),
      ).toEqual(["message", "run-fold", "activity-group", "activity-group", "message"]);
    },
  );

  it.each([false, true])(
    "carries a late checkpoint to only the final answer without changing cached messages (cache: %s)",
    (cached) => {
      const cache = cached ? createThreadFeedCache() : undefined;
      const earlier = {
        ...assistantMessage(),
        id: TurnItemId.make("earlier-item"),
        messageId: MessageId.make("earlier-message"),
        text: "Working on the files",
      };
      const final = assistantMessage("2026-06-20T00:00:04.000Z");
      const rows = [projected(earlier, 0), projected(final, 1)];
      const before = buildThreadFeed(rows, { cache });
      const [summary] = deriveThreadCheckpointSummaries({
        messages: [earlier, final].map((message) => ({
          ...message,
          id: message.messageId,
          role: "assistant",
          createdBy: "agent",
          creationSource: "provider",
          attachments: [],
          createdAt: message.startedAt,
        })),
        checkpoints: [
          {
            id: CheckpointId.make("checkpoint-final"),
            threadId,
            scopeId: CheckpointScopeId.make("scope"),
            runId,
            nodeId: NodeId.make("node"),
            parentCheckpointId: null,
            ordinalWithinScope: 1,
            appRunOrdinal: 2,
            ref: CheckpointRef.make("checkpoint-ref"),
            status: "ready",
            capturedAt: final.updatedAt,
            files: [
              { path: "src/one.ts", kind: "modified", additions: 10, deletions: 2 },
              { path: "src/two.ts", kind: "added", additions: 5, deletions: 0 },
            ],
          },
        ],
      });
      expect(summary).toBeDefined();
      if (!summary) return;
      const after = buildThreadFeed(rows, { checkpointSummaries: [summary], cache });
      expect(after[0]).toBe(before[0]);
      expect(after[1]).toMatchObject({
        type: "message",
        message: { id: final.messageId, checkpointSummary: summary },
      });
      expect(before[1]).not.toHaveProperty("message.checkpointSummary");
      expect(getReviewSectionIdForCheckpoint(summary)).toBe("turn:2");
      const fallback = deriveThreadFeedPresentation(
        [after.at(-1)!],
        null,
        new Set(),
        new Set(),
        null,
        false,
        cache,
      );
      expect(fallback.at(-1)).toMatchObject({ message: { checkpointSummary: summary } });
      const workRows = [
        projected(userMessage(), 0),
        projected(command(), 1),
        projected({ ...command(), id: TurnItemId.make("second-command") }, 2),
        projected(final, 3),
      ];
      const workBefore = buildThreadFeed(workRows, { cache });
      deriveThreadFeedPresentation(workBefore, null, new Set(), new Set(), null, false, cache);
      const workAfter = buildThreadFeed(workRows, { checkpointSummaries: [summary], cache });
      for (const expanded of [new Set<RunId>(), new Set([runId])]) {
        const presented = deriveThreadFeedPresentation(
          workAfter,
          null,
          expanded,
          new Set(),
          null,
          false,
          cache,
        );
        expect(presented.find((entry) => entry.type === "run-fold")).toMatchObject({
          checkpointSummary: summary,
        });
        expect(presented.at(-1)).not.toHaveProperty("message.checkpointSummary");
      }
      const active = deriveThreadFeedPresentation(
        workAfter,
        {
          runId,
          status: "running",
          startedAt: "2026-06-20T00:00:00.000Z",
          completedAt: null,
        },
        new Set(),
        new Set(),
        null,
        false,
        cache,
      );
      expect(active.find((entry) => entry.type === "work-toggle")).toMatchObject({
        checkpointSummary: summary,
      });
      expect(active.at(-1)).not.toHaveProperty("message.checkpointSummary");
      expect(workBefore.at(-1)).not.toHaveProperty("message.checkpointSummary");

      for (const checkpoint of [
        { ...summary, files: [] },
        ...(["missing", "error", "stale"] as const).map((status) => ({ ...summary, status })),
        { ...summary, runId: RunId.make("another-run") },
        { ...summary, assistantMessageId: MessageId.make("unloaded-message") },
      ]) {
        expect(buildThreadFeed(rows, { checkpointSummaries: [checkpoint], cache })).toEqual(before);
      }
      expect(buildThreadFeed(rows, { cache })).toEqual(before);
    },
  );

  it("omits cached tool output and patch bodies from expanded and copied activity", () => {
    const rawOutput = "RAW_TOOL_OUTPUT";
    const items: OrchestrationV2TurnItem[] = [
      { ...command(), output: rawOutput },
      {
        ...base("dynamic-output", "2026-06-20T00:00:03.000Z", 2),
        type: "dynamic_tool",
        toolName: "example",
        input: { query: "keep input" },
        output: { text: rawOutput },
      },
      {
        ...base("file-output", "2026-06-20T00:00:04.000Z", 3),
        type: "file_change",
        fileName: "src/example.ts",
        diffStr: rawOutput,
        oldStr: rawOutput,
        newStr: rawOutput,
      },
    ];
    const activities = buildThreadFeed(items.map((item, index) => projected(item, index))).flatMap(
      (entry) => (entry.type === "activity-group" ? entry.activities : []),
    );
    expect(activities).toHaveLength(3);
    for (const activity of activities) {
      expect(activity.workEntry.detail).toBeUndefined();
      expect(activity.getFullDetail()).not.toContain(rawOutput);
      expect(activity.getCopyText()).not.toContain(rawOutput);
    }
    expect(activities[0]?.detail).toBe("vp check");
    expect(activities[1]?.getFullDetail()).toContain("keep input");
    expect(activities[2]?.detail).toBe("src/example.ts");
    expect(items[0]).toMatchObject({ output: rawOutput });
  });

  it("counts every file of a multi-file patch", () => {
    const item: OrchestrationV2TurnItem = {
      ...base("multi-file-change", "2026-06-20T00:00:04.000Z", 3),
      type: "file_change",
      fileName: "src/a.ts",
      changes: [
        { operation: "update", path: "src/a.ts" },
        { operation: "add", path: "src/b.ts" },
        { operation: "update", path: "src/renamed.ts", oldPath: "src/original.ts" },
      ],
    };
    const activity = buildThreadFeed([projected(item, 0)]).flatMap((entry) =>
      entry.type === "activity-group" ? entry.activities : [],
    )[0]!;
    expect(workEntryRowLabel(activity.workEntry)).toBe("src/a.ts +2 more");
    expect(summarizeToolGroup([activity.workEntry]).summary).toBe("Changed 3 files");
  });

  it("anchors feedback before later committed turns", () => {
    const laterUser = {
      ...userMessage("2026-08-29T00:00:05.000Z"),
      id: TurnItemId.make("item-later-user"),
      messageId: MessageId.make("message-later-user"),
      ordinal: 2,
      text: "Later user turn",
    };
    const laterAssistant = {
      ...assistantMessage("2026-08-29T00:00:04.000Z"),
      id: TurnItemId.make("item-later-assistant"),
      messageId: MessageId.make("message-later-assistant"),
      ordinal: 3,
      text: "Later assistant turn",
    };
    const localMessage = (id: string, role: "user" | "assistant") => ({
      id: MessageId.make(id),
      role,
      text: id,
      turnId: null,
      streaming: false,
      createdAt: "2026-08-29T00:00:03.000Z",
      updatedAt: "2026-08-29T00:00:03.000Z",
    });
    const feed = buildThreadFeed(
      [
        projected(userMessage("2026-08-29T00:00:01.000Z"), 0),
        projected(laterUser, 1),
        projected(laterAssistant, 2),
      ],
      {
        anchoredMessages: [
          localMessage("feedback-user", "user"),
          localMessage("feedback-assistant", "assistant"),
          localMessage("message-later-user", "user"),
        ],
      },
    );
    const messages = feed.filter((entry) => entry.type === "message");

    expect(messages.map((entry) => entry.id)).toEqual([
      "message-user",
      "feedback-user",
      "feedback-assistant",
      "message-later-user",
      "message-later-assistant",
    ]);
    expect(
      messages
        .filter((entry) => entry.id.startsWith("feedback-"))
        .every((entry) => entry.message.projectedItem === undefined),
    ).toBe(true);
  });

  it("preserves authoritative V2 order instead of sorting reconstructed collections", () => {
    const rows = [
      projected(userMessage("2026-06-20T00:00:03.000Z"), 0),
      projected(command("2026-06-20T00:00:01.000Z"), 1),
      projected(assistantMessage("2026-06-20T00:00:02.000Z"), 2),
    ];

    const feed = buildThreadFeed(rows);
    expect(feed.map((entry) => entry.type)).toEqual(["message", "activity-group", "message"]);
    expect(feed.map((entry) => entry.id)).toEqual([
      "message-user",
      "local:thread-1:item-command",
      "message-assistant",
    ]);
    const activity = feed.find((entry) => entry.type === "activity-group")?.activities[0];
    expect(activity?.projectedItem).toBe(rows[1]);
    expect(activity?.getFullDetail()).toContain('"input": "vp check"');
  });

  it("keeps adjacent work from different V2 attempts in separate groups", () => {
    const firstRootNodeId = NodeId.make("node-attempt-1");
    const secondRootNodeId = NodeId.make("node-attempt-2");
    const firstCommand = { ...command(), nodeId: firstRootNodeId };
    const secondCommand = {
      ...command("2026-06-20T00:00:03.000Z"),
      id: TurnItemId.make("item-command-retry"),
      ordinal: 2,
      nodeId: secondRootNodeId,
    };
    const attempts = [
      {
        id: RunAttemptId.make("attempt-1"),
        runId,
        attemptOrdinal: 1,
        rootNodeId: firstRootNodeId,
        providerInstanceId: ProviderInstanceId.make("provider-instance-1"),
        providerThreadId: ProviderThreadId.make("provider-thread-1"),
        providerTurnId: null,
        reason: "initial",
        status: "completed",
        startedAt: DateTime.makeUnsafe("2026-06-20T00:00:01.000Z"),
        completedAt: DateTime.makeUnsafe("2026-06-20T00:00:02.000Z"),
      },
      {
        id: RunAttemptId.make("attempt-2"),
        runId,
        attemptOrdinal: 2,
        rootNodeId: secondRootNodeId,
        providerInstanceId: ProviderInstanceId.make("provider-instance-1"),
        providerThreadId: ProviderThreadId.make("provider-thread-1"),
        providerTurnId: null,
        reason: "retry",
        status: "completed",
        startedAt: DateTime.makeUnsafe("2026-06-20T00:00:02.000Z"),
        completedAt: DateTime.makeUnsafe("2026-06-20T00:00:03.000Z"),
      },
    ] satisfies ReadonlyArray<OrchestrationV2RunAttempt>;

    const feed = buildThreadFeed([projected(firstCommand, 0), projected(secondCommand, 1)], {
      attempts,
    });

    expect(feed).toHaveLength(2);
    expect(
      feed.map((entry) =>
        entry.type === "activity-group" ? entry.activities[0]?.attemptId : null,
      ),
    ).toEqual(["attempt-1", "attempt-2"]);
  });

  it("retains inherited and synthetic rows with their original projected identity", () => {
    const inherited = projected(command(), 0, "inherited");
    const { providerThreadId: _providerThreadId, ...forkBase } = base(
      "item-fork",
      "2026-06-20T00:00:03.000Z",
      2,
    );
    const synthetic = projected(
      {
        ...forkBase,
        type: "fork",
        source: { type: "run", threadId: sourceThreadId, runId },
        targetThreadId: threadId,
      },
      1,
      "synthetic",
    );

    const feed = buildThreadFeed([inherited, synthetic]);
    const activities = feed.flatMap((entry) =>
      entry.type === "activity-group" ? entry.activities : [],
    );
    expect(activities.map((activity) => activity.projectedItem)).toEqual([inherited, synthetic]);
    expect(activities.map((activity) => activity.projectedItem.visibility)).toEqual([
      "inherited",
      "synthetic",
    ]);
    expect(activities.at(-1)?.prominent).toBe(true);
  });

  it.each([
    ["local", undefined],
    ["inherited", undefined],
    ["synthetic", undefined],
    ["synthetic", "Forked from conversation"],
  ] as const)(
    "labels a %s fork row with title %s without exposing its target ID",
    (visibility, title) => {
      const { providerThreadId: _providerThreadId, ...forkBase } = base(
        "item-fork",
        "2026-06-20T00:00:03.000Z",
        2,
      );
      const activity = buildThreadFeed([
        projected(
          {
            ...forkBase,
            type: "fork",
            title: title ?? null,
            source: { type: "run", threadId: sourceThreadId, runId },
            targetThreadId: threadId,
          },
          0,
          visibility,
        ),
      ]).flatMap((entry) => (entry.type === "activity-group" ? entry.activities : []))[0]!;

      expect(workEntryRowLabel(activity.workEntry)).toBe(title ?? "Thread forked");
      expect(workEntryRowLabel(activity.workEntry, true)).toBe(title ?? "Thread forked");
      expect(activity.canExpand).toBe(true);
      expect(activity.getFullDetail()).toContain(threadId);
    },
  );

  it("names the fold that hides a progress message, with or without a run", () => {
    const middle = {
      ...assistantMessage("2026-06-20T00:00:02.500Z"),
      id: TurnItemId.make("item-middle"),
      messageId: MessageId.make("message-middle"),
      text: "Needle found in the build config.",
    };
    const items = [userMessage(), command(), middle, assistantMessage()];
    for (const runless of [false, true]) {
      const feed = buildThreadFeed(
        items.map((item, position) =>
          projected(runless ? { ...item, runId: null } : item, position),
        ),
      );
      const foldRunId = messageFoldRunId(feed, "message-middle");
      expect(foldRunId, String(runless)).toBe(runless ? "runless:message-user" : runId);
      const ids = (expanded: ReadonlySet<RunId>) =>
        deriveThreadFeedPresentation(feed, null, expanded).map((entry) => entry.id);
      expect(ids(new Set())).not.toContain("message-middle");
      expect(ids(new Set([foldRunId!]))).toContain("message-middle");
    }
    expect(messageFoldRunId(buildThreadFeed([projected(userMessage(), 0)]), "message-user")).toBe(
      null,
    );
  });

  it("folds progress messages while keeping the final assistant answer visible", () => {
    const opening = {
      ...assistantMessage("2026-06-20T00:00:01.500Z"),
      id: TurnItemId.make("item-opening"),
      messageId: MessageId.make("message-opening"),
      text: "I will check the deployment configuration.",
    };
    const middle = {
      ...assistantMessage("2026-06-20T00:00:02.500Z"),
      id: TurnItemId.make("item-middle"),
      messageId: MessageId.make("message-middle"),
      text: "The configuration is valid; checking the build next.",
    };
    const feed = buildThreadFeed([
      projected(userMessage(), 0),
      projected(opening, 1),
      projected(command(), 2),
      projected(middle, 3),
      projected(assistantMessage(), 4),
    ]);
    const latestRun = {
      runId,
      status: "completed" as const,
      startedAt: "2026-06-20T00:00:01.000Z",
      completedAt: "2026-06-20T00:00:03.000Z",
    };

    const collapsed = deriveThreadFeedPresentation(feed, latestRun, new Set());
    expect(collapsed.map((entry) => entry.id)).toEqual([
      "message-user",
      "run-fold:run-1",
      "message-assistant",
    ]);
    expect(collapsed[1]).toMatchObject({
      type: "run-fold",
      createdAt: "2026-06-20T00:00:01.500Z",
      label: "Worked for 2s",
    });

    const expanded = deriveThreadFeedPresentation(feed, latestRun, new Set([runId]));
    expect(expanded.map((entry) => entry.type)).toEqual([
      "message",
      "run-fold",
      "message",
      "activity-group",
      "message",
      "message",
    ]);
    const anchor = {
      ...command(),
      deferredWork: { cursor: "old-work", itemCount: 100, lastOrdinal: 100 },
    };
    const deferredFeed = buildThreadFeed([projected(userMessage(), 0), projected(anchor, 1)]);
    const running = { ...latestRun, status: "running" as const, completedAt: null };
    const deferredRows = deriveThreadFeedPresentation(deferredFeed, running, new Set());
    const disclosure = deferredRows.find((entry) => entry.type === "run-fold");
    expect(disclosure).toMatchObject({ deferredWorkItemIds: [anchor.id], expanded: false });
    if (disclosure?.type !== "run-fold") throw new Error("Expected deferred work disclosure");
    expect(
      deriveThreadFeedPresentation(deferredFeed, running, new Set([disclosure.runId])).some(
        (entry) => entry.type === "activity-group",
      ),
    ).toBe(true);
    expect(expanded[4]).toMatchObject({ message: { id: middle.messageId, text: middle.text } });

    const active = deriveThreadFeedPresentation(
      feed,
      { ...latestRun, status: "running", completedAt: null },
      new Set(),
    );
    expect(active.filter((entry) => entry.type === "message").map((entry) => entry.id)).toEqual([
      "message-user",
      "message-opening",
      "message-middle",
      "message-assistant",
    ]);
  });

  // regression: #21393 show plans and fold settled progress notes
  it("folds progress even when a response has no tool calls", () => {
    const feed = buildThreadFeed([
      projected(userMessage(), 0),
      projected(
        {
          ...assistantMessage("2026-06-20T00:00:02.000Z"),
          id: TurnItemId.make("item-opening"),
          messageId: MessageId.make("message-opening"),
          text: "The result is ready.",
        },
        1,
      ),
      projected(assistantMessage(), 2),
    ]);

    const presented = deriveThreadFeedPresentation(feed, null, new Set());
    expect(presented.map((entry) => entry.id)).toEqual([
      "message-user",
      "run-fold:run-1",
      "message-assistant",
    ]);
  });

  it("folds subagents while keeping created-thread and fork cards visible", () => {
    const { providerThreadId: _providerThreadId, ...forkBase } = base(
      "item-fork",
      "2026-06-20T00:00:02.000Z",
      2,
    );
    const resourceItems = [
      {
        ...base("item-subagent", "2026-06-20T00:00:01.500Z", 1),
        type: "subagent",
        subagentId: NodeId.make("child-agent"),
        origin: "app_owned",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        childThreadId: sourceThreadId,
        prompt: "Inspect the deployment configuration",
        result: "Configuration is valid",
      },
      {
        ...forkBase,
        type: "fork",
        source: { type: "run", threadId, runId },
        targetThreadId: sourceThreadId,
      },
      {
        ...base("item-created-thread", "2026-06-20T00:00:04.000Z", 4),
        type: "thread_created",
        targetThreadId: sourceThreadId,
        targetRunId: null,
        targetProviderInstanceId: ProviderInstanceId.make("codex"),
        targetModel: "gpt-5.4",
      },
    ] satisfies ReadonlyArray<OrchestrationV2TurnItem>;
    const projectedResources = [
      projected(resourceItems[0]!, 1),
      projected(resourceItems[1]!, 2),
      projected(resourceItems[2]!, 4),
    ];
    const feed = buildThreadFeed([
      projected(userMessage(), 0),
      projectedResources[0]!,
      projectedResources[1]!,
      projected(command("2026-06-20T00:00:03.000Z"), 3),
      projectedResources[2]!,
      projected(assistantMessage("2026-06-20T00:00:05.000Z"), 5),
    ]);

    const collapsed = deriveThreadFeedPresentation(feed, null, new Set());
    expect(collapsed.map((entry) => entry.type)).toEqual([
      "message",
      "run-fold",
      "activity-group",
      "activity-group",
      "message",
    ]);
    expect(collapsed[1]).toMatchObject({
      type: "run-fold",
      createdAt: "2026-06-20T00:00:01.500Z",
    });
    expect(
      collapsed.flatMap((entry) =>
        entry.type === "activity-group"
          ? entry.activities.map((activity) => activity.projectedItem)
          : [],
      ),
    ).toEqual(projectedResources.slice(1));
    const expanded = deriveThreadFeedPresentation(feed, null, new Set([runId]));
    expect(
      expanded.some(
        (entry) =>
          entry.type === "activity-group" &&
          entry.activities.some((activity) => activity.projectedItem.item.type === "subagent"),
      ),
    ).toBe(true);
  });

  it("keeps a settled run's still-running subagents visible while its other work folds", () => {
    const subagent = (
      id: string,
      updatedAt: string,
      ordinal: number,
      status: OrchestrationV2TurnItem["status"],
    ): OrchestrationV2TurnItem => ({
      ...base(id, updatedAt, ordinal),
      providerTurnId: ProviderTurnId.make("provider-turn-1"),
      status,
      completedAt: status === "running" ? null : DateTime.makeUnsafe(updatedAt),
      type: "subagent",
      subagentId: NodeId.make(id),
      origin: "app_owned",
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      childThreadId: sourceThreadId,
      prompt: `Inspect ${id}`,
      result: null,
    });
    const latestRun = {
      runId,
      status: "completed" as const,
      startedAt: "2026-06-20T00:00:01.000Z",
      completedAt: "2026-06-20T00:00:05.000Z",
    };
    const present = (children: ReadonlyArray<OrchestrationV2TurnItem>) =>
      deriveThreadFeedPresentation(
        buildThreadFeed([
          projected(userMessage(), 0),
          projected(command("2026-06-20T00:00:02.000Z"), 1),
          ...children.map((child, index) => projected(child, index + 2)),
          projected(assistantMessage("2026-06-20T00:00:05.000Z"), 5),
        ]),
        latestRun,
        new Set(),
      );
    const visibleSubagentIds = (presented: ReadonlyArray<ThreadFeedEntry>) =>
      presented.flatMap((entry) =>
        entry.type === "activity-group"
          ? entry.activities.flatMap((activity) =>
              activity.projectedItem.item.type === "subagent"
                ? [activity.projectedItem.item.id]
                : [],
            )
          : [],
      );

    const live = present([subagent("item-live", "2026-06-20T00:00:03.000Z", 2, "running")]);
    expect(live.map((entry) => entry.type)).toEqual([
      "message",
      "run-fold",
      "activity-group",
      "message",
    ]);
    expect(visibleSubagentIds(live)).toEqual(["item-live"]);

    const mixed = present([
      subagent("item-done", "2026-06-20T00:00:03.000Z", 2, "completed"),
      subagent("item-live", "2026-06-20T00:00:04.000Z", 3, "running"),
    ]);
    expect(visibleSubagentIds(mixed)).toEqual(["item-done", "item-live"]);

    const finished = present([subagent("item-done", "2026-06-20T00:00:03.000Z", 2, "completed")]);
    expect(finished.map((entry) => entry.type)).toEqual(["message", "run-fold", "message"]);
  });

  it("folds each run of a provider-native subagent thread like a normal turn", () => {
    const runless = <T extends OrchestrationV2TurnItem>(item: T, id: string, ordinal: number) => ({
      ...item,
      id: TurnItemId.make(id),
      runId: null,
      ordinal,
    });
    const prompt = (id: string, ordinal: number, at: string) =>
      runless(
        { ...userMessage(at), messageId: MessageId.make(id), creationSource: "provider" as const },
        id,
        ordinal,
      );
    const answer = (id: string, ordinal: number, at: string) =>
      runless({ ...assistantMessage(at), messageId: MessageId.make(id) }, id, ordinal);
    const { exitCode: _exitCode, ...completedCommand } = command("2026-06-20T00:01:17.000Z");
    const feed = (resumeRunning: boolean) =>
      buildThreadFeed(
        [
          prompt("launch", 1, "2026-06-20T00:00:00.000Z"),
          runless(command("2026-06-20T00:00:04.000Z"), "launch-ls", 2),
          answer("launch-answer", 3, "2026-06-20T00:00:08.000Z"),
          prompt("resume", 4, "2026-06-20T00:01:12.000Z"),
          resumeRunning
            ? runless(
                { ...completedCommand, status: "running", completedAt: null, output: "" },
                "resume-ls",
                5,
              )
            : runless(command("2026-06-20T00:01:17.000Z"), "resume-ls", 5),
          ...(resumeRunning ? [] : [answer("resume-answer", 6, "2026-06-20T00:01:20.000Z")]),
        ].map((item, position) => projected(item, position)),
      );
    const shape = (entries: ReadonlyArray<ThreadFeedEntry>) =>
      entries.map((entry) =>
        entry.type === "run-fold"
          ? `fold:${entry.label}`
          : entry.type === "message"
            ? `${entry.message.role}:${entry.message.id}`
            : entry.type,
      );

    const settled = deriveThreadFeedPresentation(feed(false), null, new Set());
    expect(shape(settled)).toEqual([
      "user:launch",
      "fold:Worked for 8s",
      "assistant:launch-answer",
      "user:resume",
      "fold:Worked for 8s",
      "assistant:resume-answer",
    ]);
    const launchFold = settled.find((entry) => entry.type === "run-fold");
    if (launchFold?.type !== "run-fold") throw new Error("Expected the launch fold");
    expect(
      shape(deriveThreadFeedPresentation(feed(false), null, new Set([launchFold.runId]))),
    ).toEqual([
      "user:launch",
      "fold:Worked for 8s",
      "activity-group",
      "assistant:launch-answer",
      "user:resume",
      "fold:Worked for 8s",
      "assistant:resume-answer",
    ]);

    expect(
      shape(
        deriveThreadFeedPresentation(
          feed(true),
          null,
          new Set(),
          new Set(),
          "2026-06-20T00:01:12.000Z",
          true,
        ),
      ),
    ).toEqual([
      "user:launch",
      "fold:Worked for 8s",
      "assistant:launch-answer",
      "user:resume",
      "activity-group",
    ]);
  });

  it("keeps imported V1 turns folded once the thread's first V2 run starts", () => {
    const imported = <T extends OrchestrationV2TurnItem>(item: T, id: string) => ({
      ...item,
      id: TurnItemId.make(id),
      runId: null,
    });
    const presented = (start: OrchestrationV2TurnItem) =>
      deriveThreadFeedPresentation(
        buildThreadFeed(
          [
            imported(userMessage("2026-06-20T00:00:00.000Z"), "imported-prompt"),
            imported(
              {
                ...assistantMessage("2026-06-20T00:00:02.000Z"),
                messageId: MessageId.make("update"),
              },
              "imported-update",
            ),
            imported(command("2026-06-20T00:00:04.000Z"), "imported-ls"),
            imported(
              {
                ...assistantMessage("2026-06-20T00:00:08.000Z"),
                messageId: MessageId.make("answer"),
              },
              "imported-answer",
            ),
            start,
          ].map((item, position) => projected(item, position)),
        ),
        { runId, status: "running", startedAt: "2026-06-20T00:01:00.000Z", completedAt: null },
        new Set(),
        new Set(),
        "2026-06-20T00:01:00.000Z",
      )
        .slice(0, 3)
        .map((entry) => (entry.type === "message" ? entry.message.role : entry.type));

    expect(
      presented({
        ...userMessage("2026-06-20T00:01:00.000Z"),
        id: TurnItemId.make("new-prompt"),
        messageId: MessageId.make("new-prompt"),
      }),
    ).toEqual(["user", "run-fold", "assistant"]);
    expect(
      presented({
        ...base("wake", "2026-06-20T00:01:00.000Z", 4),
        type: "notification",
        source: { kind: "background_task" },
        outcome: "completed",
        summary: "Background task finished",
      }),
    ).toEqual(["user", "run-fold", "assistant"]);
  });

  it("keeps a provider-native subagent's runless tool call live while it works", () => {
    const startedAt = "2026-06-20T00:00:01.000Z";
    const { exitCode: _exitCode, ...completedCommand } = command();
    const runningCommand: OrchestrationV2TurnItem = {
      ...completedCommand,
      runId: null,
      status: "running",
      completedAt: null,
      output: "",
    };
    const feed = buildThreadFeed([
      projected({ ...userMessage(), runId: null }, 0),
      projected(runningCommand, 1),
    ]);

    const presented = deriveThreadFeedPresentation(
      feed,
      null,
      new Set(),
      new Set(),
      startedAt,
      true,
    );
    expect(presented.find((entry) => entry.type === "activity-group")).toMatchObject({
      id: "live-activity-row",
      activities: [{ live: true, groupStandIn: { label: "Running vp" } }],
    });
    expect(presented.some((entry) => entry.type === "thinking")).toBe(false);
  });

  it("does not show Thinking once the open run's provider turn has ended", () => {
    const startedAt = "2026-04-01T00:00:01.000Z";
    const run = { runId, status: "running" as const, startedAt, completedAt: null };
    expect(
      deriveThreadFeedPresentation(
        [],
        { ...run, turnEnded: true },
        new Set(),
        new Set(),
        startedAt,
      ),
    ).toEqual([]);
  });
});

