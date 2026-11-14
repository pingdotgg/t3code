import {
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadFeed, deriveThreadFeedPresentation, type ThreadFeedEntry } from "./threadActivity";
import {
  assistantMessage,
  base,
  command,
  projected,
  runId,
  sourceThreadId,
  userMessage,
} from "./threadActivity.testkit";

describe("buildThreadFeed", () => {
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
