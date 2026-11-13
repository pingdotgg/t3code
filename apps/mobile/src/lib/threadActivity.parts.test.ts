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
import { assistantMessage, base, command, projected, runId, userMessage } from "./threadActivity.testkit";


it("shows a captured MCP app for a failed deferred write", () => {
  const mcpApp = {
    attachmentId: "deferred-app-html",
    server: "github",
    tool: "create_pull_request",
    resourceUri: "ui://github-mcp-server/pr-create",
  };
  const item: OrchestrationV2TurnItem = {
    ...base("deferred-app", "2026-08-29T00:00:00.000Z", 1),
    type: "dynamic_tool",
    toolName: "github.create_pull_request",
    status: "failed",
    input: {},
    output: { t3McpApp: mcpApp, result: { content: [], isError: true } },
  };
  expect(buildThreadFeed([projected(item, 0)])).toMatchObject([{ type: "mcp-app", app: mcpApp }]);
});

it("keeps historical plan detail accessible from its paged turn item", () => {
  const item = {
    ...base("historical-plan", "2026-08-29T00:00:00.000Z", 1),
    type: "proposed_plan",
    planId: "plan-historical",
    markdown: "Full historical plan text",
    streaming: false,
  } as OrchestrationV2TurnItem;

  const entries = buildThreadFeed([projected(item, 0)]);
  const activity = entries.flatMap((entry) =>
    entry.type === "activity-group" ? entry.activities : [],
  )[0];
  expect(activity?.detail).toBe("Full historical plan text");
  expect(activity?.getFullDetail()).toBe("Full historical plan text");
  expect(activity?.getCopyText()).toBe("Full historical plan text\n");
  expect(activity?.prominent).toBe(true);
  const presented = deriveThreadFeedPresentation(
    buildThreadFeed([
      projected(userMessage(), 0),
      projected(command(), 1),
      projected(item, 2),
      projected(assistantMessage(), 3),
    ]),
    null,
    new Set(),
  );
  expect(presented.map((entry) => entry.type)).toEqual([
    "message",
    "run-fold",
    "activity-group",
    "message",
  ]);
  expect(presented[2]).toMatchObject({ activities: [{ projectedItem: { item } }] });
});

it("shows a compact command as one mobile divider before, during, and after compaction", () => {
  const startedAt = "2026-06-20T00:00:01.000Z";
  const prompt = projected({ ...userMessage(), text: "/compact", idleCompaction: "onReturn" }, 0);
  const latestRun = { runId, status: "running" as const, startedAt, completedAt: null };
  const present = (items: OrchestrationV2ProjectedTurnItem[]) =>
    deriveThreadFeedPresentation(
      buildThreadFeed(items),
      latestRun,
      new Set(),
      new Set(),
      startedAt,
    );

  const waiting = present([prompt]);
  expect(waiting.map((entry) => entry.type)).toEqual(["message"]);
  expect(waiting[0]?.type === "message" ? waiting[0].message.idleCompaction : null).toBe(
    "onReturn",
  );
  for (const status of ["running", "completed", "failed"] as const) {
    const compaction = projected(
      {
        ...base("compaction", "2026-06-20T00:00:02.000Z", 1),
        type: "compaction",
        driver: ProviderDriverKind.make("claude"),
        status,
        beforeTokenCount: 100_000,
        ...(status === "completed" ? { afterTokenCount: 20_000 } : {}),
        ...(status === "failed" ? { summary: "Not enough messages to compact." } : {}),
      },
      1,
    );
    const rows = present([prompt, compaction]);
    expect(rows.map((entry) => entry.type)).toEqual(["activity-group"]);
    expect(
      rows[0]?.type === "activity-group" ? rows[0].activities[0]?.projectedItem.item : null,
    ).toMatchObject({ type: "compaction", status });
  }
});

it("shows a skipped compaction as one stopped row, without a separate interrupted row", () => {
  const prompt = projected({ ...userMessage(), text: "/compact", idleCompaction: "onReturn" }, 0);
  const compaction = projected(
    {
      ...base("compaction", "2026-06-20T00:00:02.000Z", 1),
      type: "compaction",
      driver: ProviderDriverKind.make("claude"),
      status: "interrupted",
    },
    1,
  );
  const interrupted = projected(
    {
      ...base("interrupt-result", "2026-06-20T00:00:03.000Z", 2),
      type: "run_interrupt_result",
      status: "interrupted",
      message: "Skipped compaction to send a queued message",
    },
    2,
  );
  const rows = deriveThreadFeedPresentation(
    buildThreadFeed([prompt, compaction, interrupted]),
    {
      runId,
      status: "interrupted",
      startedAt: "2026-06-20T00:00:01.000Z",
      completedAt: "2026-06-20T00:00:03.000Z",
    },
    new Set(),
  );

  expect(rows.map((entry) => entry.type)).toEqual(["activity-group"]);
  expect(
    rows[0]?.type === "activity-group"
      ? rows[0].activities.map((a) => a.projectedItem.item.type)
      : null,
  ).toEqual(["compaction"]);
});

it("keeps the interrupted row for a compaction stopped before its provider started", () => {
  const rows = deriveThreadFeedPresentation(
    buildThreadFeed([
      projected({ ...userMessage(), text: "/compact" }, 0),
      projected(
        {
          ...base("interrupt-result", "2026-06-20T00:00:03.000Z", 1),
          type: "run_interrupt_result",
          status: "interrupted",
          message: "Run interrupted before provider start",
        },
        1,
      ),
    ]),
    {
      runId,
      status: "interrupted",
      startedAt: "2026-06-20T00:00:01.000Z",
      completedAt: "2026-06-20T00:00:03.000Z",
    },
    new Set(),
  );

  expect(
    rows.flatMap((entry) =>
      entry.type === "activity-group"
        ? entry.activities.map((activity) => activity.projectedItem.item.type)
        : [],
    ),
  ).toContain("run_interrupt_result");
});

it.each(["/compact", "Continue"])(
  "keeps a completed compaction divider visible while other settled work folds for %s",
  (promptText) => {
    const rows = deriveThreadFeedPresentation(
      buildThreadFeed([
        projected({ ...userMessage(), text: promptText }, 0),
        projected(command(), 1),
        projected(
          {
            ...base("compaction", "2026-06-20T00:00:03.000Z", 2),
            type: "compaction",
            driver: ProviderDriverKind.make("claude"),
            status: "completed",
            beforeTokenCount: 100_000,
            afterTokenCount: 20_000,
          },
          2,
        ),
      ]),
      {
        runId,
        status: "completed",
        startedAt: "2026-06-20T00:00:01.000Z",
        completedAt: "2026-06-20T00:00:03.000Z",
      },
      new Set(),
    );
    expect(rows.filter((entry) => entry.type === "run-fold")).toHaveLength(1);
    const activities = rows.flatMap((entry) =>
      entry.type === "activity-group" ? entry.activities : [],
    );
    expect(activities.map((activity) => activity.projectedItem.item)).toMatchObject([
      {
        type: "compaction",
        status: "completed",
        beforeTokenCount: 100_000,
        afterTokenCount: 20_000,
      },
    ]);
    if (promptText === "/compact") {
      expect(rows.some((entry) => entry.type === "message")).toBe(false);
    }
  },
);

it("binds a persisted resume answer only to the next compaction in its run", () => {
  const requestId = RuntimeRequestId.make("resume-compaction");
  const question = projected(
    {
      ...base("resume-question", "2026-06-20T00:00:02.000Z", 1),
      type: "user_input_request",
      requestId,
      questions: [],
      questionAnswer: {
        requestId,
        questionTextById: {
          resume:
            "This session is 2h 10m old and uses 200,000 tokens. Compact it before continuing?",
        },
        answers: { resume: "Compact and continue" },
        attachmentsByQuestionId: {},
      },
    },
    1,
  );
  const compaction = (id: string, position: number, status: "running" | "completed") =>
    projected(
      {
        ...base(id, `2026-06-20T00:00:0${position + 1}.000Z`, position),
        type: "compaction",
        driver: ProviderDriverKind.make("claude"),
        status,
        beforeTokenCount: 200_000,
      },
      position,
    );
  for (const status of ["running", "completed"] as const) {
    // Rebuild from persisted items, without a live question or prior feed cache.
    const feed = buildThreadFeed([
      projected(userMessage(), 0),
      question,
      compaction("resume-compact", 2, "completed"),
      compaction("auto-compact", 3, status),
    ]);
    const labels = threadFeedCompactionLabels(feed);
    const compactRows = feed.filter(
      (entry) =>
        entry.type === "activity-group" &&
        entry.activities[0]?.projectedItem.item.type === "compaction",
    );
    expect(compactRows).toHaveLength(2);
    expect(labels.get(compactRows[0]!.id)).toEqual({
      title: "Context compacted after 2h 10m idle",
      compacting: "Compacting…",
    });
    expect(labels.get(compactRows[1]!.id)).toBeUndefined();
  }
});

