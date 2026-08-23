import { describe, expect, it } from "vite-plus/test";

import {
  grokAutoCompactEvents,
  grokBackgroundTaskEvents,
  grokHookEvents,
  grokQueueChangedEvents,
  grokSessionRecapEvents,
  parseXAiAutoCompact,
  parseXAiBackgroundTask,
  parseXAiHookExecution,
  parseXAiQueueChanged,
  parseXAiSessionRecap,
  parseXAiTurnCompletedUsage,
} from "./GrokAcpSessionExtras.ts";

describe("GrokAcpSessionExtras", () => {
  it("maps hook_execution runs onto hook.started then hook.completed", () => {
    const parsed = parseXAiHookExecution({
      update: {
        sessionUpdate: "hook_execution",
        event_name: "user_prompt_submit",
        runs: [
          {
            name: "global/settings:user_prompt_submit[0].hooks[0]",
            status: { status: "success", elapsed_ms: 177 },
          },
        ],
      },
    });
    expect(parsed?.hookEvent).toBe("user_prompt_submit");
    expect(grokHookEvents(parsed!)).toEqual([
      {
        type: "hook.started",
        payload: {
          hookId: "global/settings:user_prompt_submit[0].hooks[0]",
          hookName: "global/settings:user_prompt_submit[0].hooks[0]",
          hookEvent: "user_prompt_submit",
        },
      },
      {
        type: "hook.completed",
        payload: {
          hookId: "global/settings:user_prompt_submit[0].hooks[0]",
          outcome: "success",
        },
      },
    ]);
  });

  it("maps auto_compact_started onto the context window with compactsAutomatically", () => {
    const parsed = parseXAiAutoCompact({
      update: {
        sessionUpdate: "auto_compact_started",
        tokens_used: 402_072,
        context_window: 500_000,
        percentage: 80,
        reason: "Context window 80% full",
      },
    });
    const events = grokAutoCompactEvents(parsed!, undefined, false);
    expect(events).toContainEqual({
      type: "thread.token-usage.updated",
      payload: {
        usage: {
          usedTokens: 402_072,
          lastUsedTokens: 402_072,
          maxTokens: 500_000,
          compactsAutomatically: true,
        },
      },
    });
    expect(events[0]).toMatchObject({
      type: "session.state.changed",
      payload: { state: "waiting", reason: "Context window 80% full" },
    });
  });

  it("maps auto_compact_completed onto compacted thread state", () => {
    const parsed = parseXAiAutoCompact({
      update: {
        sessionUpdate: "auto_compact_completed",
        tokens_before: 402_072,
        tokens_after: 42_380,
        elapsed_ms: 118_411,
      },
    });
    const events = grokAutoCompactEvents(
      parsed!,
      {
        usedTokens: 402_072,
        maxTokens: 500_000,
        lastUsedTokens: 402_072,
        compactsAutomatically: true,
      },
      false,
    );
    expect(events).toEqual([
      {
        type: "thread.token-usage.updated",
        payload: {
          usage: {
            usedTokens: 42_380,
            lastUsedTokens: 402_072,
            totalProcessedTokens: 402_072,
            maxTokens: 500_000,
            compactsAutomatically: true,
          },
        },
      },
      {
        type: "session.state.changed",
        payload: { state: "ready", reason: "compaction completed", detail: parsed },
      },
      {
        type: "thread.state.changed",
        payload: { state: "compacted", detail: parsed },
      },
    ]);
  });

  it("keeps compaction-complete running only while a turn is live", () => {
    const parsed = parseXAiAutoCompact({
      update: {
        sessionUpdate: "auto_compact_completed",
        tokens_before: 402_072,
        tokens_after: 42_380,
      },
    });
    const events = grokAutoCompactEvents(parsed!, undefined, true);
    expect(events).toContainEqual({
      type: "session.state.changed",
      payload: { state: "running", reason: "compaction completed", detail: parsed },
    });
  });

  it("publishes session_recap onto thread.metadata, never as a title", () => {
    const parsed = parseXAiSessionRecap({
      update: {
        sessionUpdate: "session_recap",
        summary: "Mapped Grok extras onto T3 runtime events.",
        auto: true,
      },
    });
    expect(grokSessionRecapEvents(parsed!)).toEqual([
      {
        type: "thread.metadata.updated",
        payload: {
          metadata: {
            recap: "Mapped Grok extras onto T3 runtime events.",
            recapAuto: true,
          },
        },
      },
    ]);
  });

  it("reads complete PromptUsage costUsdTicks and skips incomplete bills", () => {
    const complete = parseXAiTurnCompletedUsage({
      update: {
        sessionUpdate: "turn_completed",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          costUsdTicks: 1_626_488_800,
        },
      },
    });
    expect(complete?.usage.usedTokens).toBe(120);
    expect(complete?.costUsd).toBeCloseTo(0.16264888);

    const incomplete = parseXAiTurnCompletedUsage({
      update: {
        sessionUpdate: "turn_completed",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          costUsdTicks: 100,
          incomplete: true,
        },
      },
    });
    expect(incomplete?.usage.usedTokens).toBe(120);
    expect(incomplete?.costUsd).toBeUndefined();
  });

  it("maps backgrounded shells onto local_bash tasks", () => {
    const started = parseXAiBackgroundTask({
      update: {
        sessionUpdate: "task_backgrounded",
        task_id: "call-bg-1",
        command: "sleep 10",
        output_file: "/tmp/out.log",
        description: "Wait in the background",
      },
    });
    expect(grokBackgroundTaskEvents(started!)[0]).toMatchObject({
      type: "task.started",
      payload: { taskId: "call-bg-1", taskType: "local_bash", outputFile: "/tmp/out.log" },
    });

    const finished = parseXAiBackgroundTask({
      update: {
        sessionUpdate: "task_completed",
        task_snapshot: {
          task_id: "call-bg-1",
          command: "sleep 10",
          exit_code: 0,
          output: "done",
        },
      },
    });
    expect(grokBackgroundTaskEvents(finished!)[0]).toMatchObject({
      type: "task.completed",
      payload: { status: "completed", summary: "done" },
    });
  });

  it("projects queue length onto session state without inventing a third surface", () => {
    const parsed = parseXAiQueueChanged({
      sessionId: "sess-1",
      entries: [{ prompt: "follow up" }],
    });
    expect(grokQueueChangedEvents(parsed!, true)).toEqual([
      {
        type: "session.state.changed",
        payload: {
          state: "waiting",
          reason: "queue:1",
          detail: { queueLength: 1 },
        },
      },
      {
        type: "thread.metadata.updated",
        payload: { metadata: { grokQueueLength: 1 } },
      },
    ]);
  });
});
