import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { OrchestrationEvent } from "@t3tools/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { OrchestrationEngine } from "./engine";
import type { OrchestrationEventStore } from "./eventStore";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("OrchestrationEngine", () => {
  it("replays to the same deterministic snapshot", async () => {
    const stateDir = makeTempDir("t3code-orchestration-");
    const createdAt = new Date().toISOString();
    const projectId = "project-1";
    const threadId = "thread-1";

    const engineA = new OrchestrationEngine(stateDir);
    await engineA.start();
    await engineA.dispatch({
      type: "project.create",
      commandId: "cmd-1",
      projectId,
      name: "demo",
      cwd: "/tmp/demo",
      model: "gpt-5-codex",
      createdAt,
    });
    await engineA.dispatch({
      type: "thread.create",
      commandId: "cmd-2",
      threadId,
      projectId,
      title: "Thread",
      model: "gpt-5-codex",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    await engineA.dispatch({
      type: "message.send",
      commandId: "cmd-3",
      threadId,
      messageId: "msg-1",
      role: "user",
      text: "hello",
      streaming: false,
      createdAt,
    });
    const snapshotA = engineA.getSnapshot();
    await engineA.stop();

    const engineB = new OrchestrationEngine(stateDir);
    await engineB.start();
    const snapshotB = engineB.getSnapshot();
    expect(snapshotB).toEqual(snapshotA);
    await engineB.stop();
  });

  it("fans out read-model updates to subscribers", async () => {
    const stateDir = makeTempDir("t3code-orchestration-fanout-");
    const engine = new OrchestrationEngine(stateDir);
    await engine.start();
    const updates: number[] = [];
    const unsubscribe = engine.subscribeToReadModel((snapshot) => {
      updates.push(snapshot.sequence);
    });
    await engine.dispatch({
      type: "project.create",
      commandId: "cmd-project",
      projectId: "project-2",
      name: "fanout",
      cwd: "/tmp/fanout",
      model: "gpt-5-codex",
      createdAt: new Date().toISOString(),
    });
    unsubscribe();
    expect(updates.length).toBeGreaterThan(0);
    await engine.stop();
  });

  it("replays append-only events from sequence", async () => {
    const stateDir = makeTempDir("t3code-orchestration-replay-");
    const engine = new OrchestrationEngine(stateDir);
    await engine.start();
    await engine.dispatch({
      type: "project.create",
      commandId: "cmd-a",
      projectId: "project-replay",
      name: "replay",
      cwd: "/tmp/replay",
      model: "gpt-5-codex",
      createdAt: new Date().toISOString(),
    });
    await engine.dispatch({
      type: "project.delete",
      commandId: "cmd-b",
      projectId: "project-replay",
      createdAt: new Date().toISOString(),
    });
    const events = await engine.replayEvents(0);
    expect(events.length).toBe(2);
    expect(events[0]?.type).toBe("project.created");
    expect(events[1]?.type).toBe("project.deleted");
    await engine.stop();
  });

  it("stores completed turn summaries even when no files changed", async () => {
    const stateDir = makeTempDir("t3code-orchestration-turn-diff-");
    const engine = new OrchestrationEngine(stateDir);
    const completedAt = new Date().toISOString();
    await engine.start();
    await engine.dispatch({
      type: "project.create",
      commandId: "cmd-project-turn-diff",
      projectId: "project-turn-diff",
      name: "turn-diff",
      cwd: "/tmp/turn-diff",
      model: "gpt-5-codex",
      createdAt: completedAt,
    });
    await engine.dispatch({
      type: "thread.create",
      commandId: "cmd-thread-turn-diff",
      threadId: "thread-turn-diff",
      projectId: "project-turn-diff",
      title: "Turn diff thread",
      model: "gpt-5-codex",
      branch: null,
      worktreePath: null,
      createdAt: completedAt,
    });
    await engine.dispatch({
      type: "thread.turnDiff.complete",
      commandId: "cmd-turn-diff-complete",
      threadId: "thread-turn-diff",
      turnId: "turn-1",
      completedAt,
      status: "completed",
      files: [],
      checkpointTurnCount: 1,
      createdAt: completedAt,
    });

    const firstThread = engine.getSnapshot().threads.find((thread) => thread.id === "thread-turn-diff");
    expect(firstThread?.turnDiffSummaries).toEqual([
      {
        turnId: "turn-1",
        completedAt,
        status: "completed",
        files: [],
        checkpointTurnCount: 1,
      },
    ]);
    await engine.stop();

    const restartedEngine = new OrchestrationEngine(stateDir);
    await restartedEngine.start();
    const restartedThread = restartedEngine
      .getSnapshot()
      .threads.find((thread) => thread.id === "thread-turn-diff");
    expect(restartedThread?.turnDiffSummaries).toEqual([
      {
        turnId: "turn-1",
        completedAt,
        status: "completed",
        files: [],
        checkpointTurnCount: 1,
      },
    ]);
    await restartedEngine.stop();
  });

  it("reverts thread messages and turn summaries to a checkpoint", async () => {
    const stateDir = makeTempDir("t3code-orchestration-revert-");
    const engine = new OrchestrationEngine(stateDir);
    const createdAt = new Date().toISOString();
    await engine.start();
    await engine.dispatch({
      type: "project.create",
      commandId: "cmd-project-revert",
      projectId: "project-revert",
      name: "revert",
      cwd: "/tmp/revert",
      model: "gpt-5-codex",
      createdAt,
    });
    await engine.dispatch({
      type: "thread.create",
      commandId: "cmd-thread-revert",
      threadId: "thread-revert",
      projectId: "project-revert",
      title: "Revert thread",
      model: "gpt-5-codex",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    await engine.dispatch({
      type: "message.send",
      commandId: "cmd-msg-1-user",
      threadId: "thread-revert",
      messageId: "user-1",
      role: "user",
      text: "first",
      streaming: false,
      createdAt,
    });
    await engine.dispatch({
      type: "message.send",
      commandId: "cmd-msg-1-assistant",
      threadId: "thread-revert",
      messageId: "assistant:turn-1",
      role: "assistant",
      text: "first-response",
      streaming: false,
      createdAt,
    });
    await engine.dispatch({
      type: "thread.turnDiff.complete",
      commandId: "cmd-turn-1-complete",
      threadId: "thread-revert",
      turnId: "turn-1",
      completedAt: createdAt,
      status: "completed",
      files: [],
      assistantMessageId: "assistant:turn-1",
      checkpointTurnCount: 1,
      createdAt,
    });

    const createdAtSecond = new Date(Date.now() + 1_000).toISOString();
    await engine.dispatch({
      type: "message.send",
      commandId: "cmd-msg-2-user",
      threadId: "thread-revert",
      messageId: "user-2",
      role: "user",
      text: "second",
      streaming: false,
      createdAt: createdAtSecond,
    });
    await engine.dispatch({
      type: "message.send",
      commandId: "cmd-msg-2-assistant",
      threadId: "thread-revert",
      messageId: "assistant:turn-2",
      role: "assistant",
      text: "second-response",
      streaming: false,
      createdAt: createdAtSecond,
    });
    await engine.dispatch({
      type: "thread.turnDiff.complete",
      commandId: "cmd-turn-2-complete",
      threadId: "thread-revert",
      turnId: "turn-2",
      completedAt: createdAtSecond,
      status: "completed",
      files: [],
      assistantMessageId: "assistant:turn-2",
      checkpointTurnCount: 2,
      createdAt: createdAtSecond,
    });

    await engine.dispatch({
      type: "thread.revert",
      commandId: "cmd-thread-revert-apply",
      threadId: "thread-revert",
      turnCount: 1,
      messageCount: 2,
      createdAt: createdAtSecond,
    });

    const thread = engine.getSnapshot().threads.find((entry) => entry.id === "thread-revert");
    expect(thread?.messages.map((message) => message.id)).toEqual(["user-1", "assistant:turn-1"]);
    expect(thread?.turnDiffSummaries.map((summary) => summary.turnId)).toEqual(["turn-1"]);
    expect(thread?.latestTurnId).toBe("turn-1");
    await engine.stop();

    const restarted = new OrchestrationEngine(stateDir);
    await restarted.start();
    const restartedThread = restarted
      .getSnapshot()
      .threads.find((entry) => entry.id === "thread-revert");
    expect(restartedThread?.messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant:turn-1",
    ]);
    expect(restartedThread?.turnDiffSummaries.map((summary) => summary.turnId)).toEqual(["turn-1"]);
    await restarted.stop();
  });

  it("allows stop to be called multiple times", async () => {
    const stateDir = makeTempDir("t3code-orchestration-stop-");
    const engine = new OrchestrationEngine(stateDir);
    await engine.start();
    await engine.stop();
    await expect(engine.stop()).resolves.toBeUndefined();
  });

  it("keeps processing queued commands after a storage failure", async () => {
    const events: OrchestrationEvent[] = [];
    let nextSequence = 1;
    let shouldFailFirstAppend = true;

    const flakyStore: OrchestrationEventStore = {
      append(event) {
        if (shouldFailFirstAppend) {
          shouldFailFirstAppend = false;
          return Effect.sync(() => {
            throw new Error("append failed");
          });
        }
        const savedEvent = {
          ...event,
          sequence: nextSequence,
        } satisfies OrchestrationEvent;
        nextSequence += 1;
        events.push(savedEvent);
        return Effect.succeed(savedEvent);
      },
      readFromSequence(sequenceExclusive) {
        return Effect.succeed(events.filter((event) => event.sequence > sequenceExclusive));
      },
      readAll() {
        return Effect.succeed(events);
      },
      close() {},
    };

    const engine = new OrchestrationEngine(flakyStore);
    const createdAt = new Date().toISOString();
    await engine.start();

    await expect(
      engine.dispatch({
        type: "project.create",
        commandId: "cmd-flaky-1",
        projectId: "project-flaky-fail",
        name: "flaky-fail",
        cwd: "/tmp/flaky-fail",
        model: "gpt-5-codex",
        createdAt,
      }),
    ).rejects.toThrow("append failed");

    const result = await engine.dispatch({
      type: "project.create",
      commandId: "cmd-flaky-2",
      projectId: "project-flaky-ok",
      name: "flaky-ok",
      cwd: "/tmp/flaky-ok",
      model: "gpt-5-codex",
      createdAt,
    });

    expect(result.sequence).toBe(1);
    expect(engine.getSnapshot().projects.map((project) => project.id)).toEqual(["project-flaky-ok"]);

    await engine.stop();
  });
});
