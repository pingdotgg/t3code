import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { OrchestrationEvent } from "@t3tools/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  OrchestrationEventRepository,
  type OrchestrationEventRepositoryShape,
} from "../persistence/Services/OrchestrationEvents";

import { Layer, ManagedRuntime } from "effect";

import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite";

import { OrchestrationEngineLive } from "./Layer";
import { OrchestrationEngineService } from "./Service";
import { OrchestrationEventRepositoryLive } from "../persistence/Layers/OrchestrationEvents";

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

export async function createOrchestrationSystem(stateDir: string) {
  const dbPath = path.join(stateDir, "orchestration.sqlite");
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationEventRepositoryLive),
    Layer.provide(makeSqlitePersistenceLive(dbPath)),
  );
  const runtime = ManagedRuntime.make(orchestrationLayer);
  const engine = await runtime.runPromise(OrchestrationEngineService);
  return {
    engine,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

describe("OrchestrationEngine", () => {
  it("replays to the same deterministic snapshot", async () => {
    const stateDir = makeTempDir("t3code-orchestration-");
    const createdAt = new Date().toISOString();
    const projectId = "project-1";
    const threadId = "thread-1";

    const firstSystem = await createOrchestrationSystem(stateDir);
    const engineA = firstSystem.engine;
    await firstSystem.run(
      engineA.dispatch({
        type: "thread.create",
        commandId: "cmd-1",
        threadId,
        projectId,
        title: "Thread",
        model: "gpt-5-codex",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await firstSystem.run(
      engineA.dispatch({
        type: "message.send",
        commandId: "cmd-3",
        threadId,
        messageId: "msg-1",
        role: "user",
        text: "hello",
        streaming: false,
        createdAt,
      }),
    );
    const snapshotA = await firstSystem.run(engineA.getSnapshot());
    await firstSystem.dispose();

    const secondSystem = await createOrchestrationSystem(stateDir);
    const engineB = secondSystem.engine;
    const snapshotB = await secondSystem.run(engineB.getSnapshot());
    expect(snapshotB).toEqual(snapshotA);
    await secondSystem.dispose();
  });

  it("fans out read-model updates to subscribers", async () => {
    const stateDir = makeTempDir("t3code-orchestration-fanout-");
    const system = await createOrchestrationSystem(stateDir);
    const engine = system.engine;
    const updates: number[] = [];
    const unsubscribe = await system.run(
      engine.subscribeToReadModel((snapshot) => {
        updates.push(snapshot.sequence);
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: "cmd-thread",
        threadId: "thread-2",
        projectId: "project-2",
        title: "fanout",
        model: "gpt-5-codex",
        branch: null,
        worktreePath: null,
        createdAt: new Date().toISOString(),
      }),
    );
    unsubscribe();
    expect(updates.length).toBeGreaterThan(0);
    await system.dispose();
  });

  it("replays append-only events from sequence", async () => {
    const stateDir = makeTempDir("t3code-orchestration-replay-");
    const system = await createOrchestrationSystem(stateDir);
    const engine = system.engine;
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: "cmd-a",
        threadId: "thread-replay",
        projectId: "project-replay",
        title: "replay",
        model: "gpt-5-codex",
        branch: null,
        worktreePath: null,
        createdAt: new Date().toISOString(),
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.delete",
        commandId: "cmd-b",
        threadId: "thread-replay",
        createdAt: new Date().toISOString(),
      }),
    );
    const events = await system.run(engine.replayEvents(0));
    expect(events.length).toBe(2);
    expect(events[0]?.type).toBe("thread.created");
    expect(events[1]?.type).toBe("thread.deleted");
    await system.dispose();
  });

  it("stores completed turn summaries even when no files changed", async () => {
    const stateDir = makeTempDir("t3code-orchestration-turn-diff-");
    const firstSystem = await createOrchestrationSystem(stateDir);
    const engine = firstSystem.engine;
    const completedAt = new Date().toISOString();
    await firstSystem.run(
      engine.dispatch({
        type: "thread.create",
        commandId: "cmd-thread-turn-diff",
        threadId: "thread-turn-diff",
        projectId: "project-turn-diff",
        title: "Turn diff thread",
        model: "gpt-5-codex",
        branch: null,
        worktreePath: null,
        createdAt: completedAt,
      }),
    );
    await firstSystem.run(
      engine.dispatch({
        type: "thread.turnDiff.complete",
        commandId: "cmd-turn-diff-complete",
        threadId: "thread-turn-diff",
        turnId: "turn-1",
        completedAt,
        status: "completed",
        files: [],
        checkpointTurnCount: 1,
        createdAt: completedAt,
      }),
    );

    const firstThread = (await firstSystem.run(engine.getSnapshot())).threads.find(
      (thread) => thread.id === "thread-turn-diff",
    );
    expect(firstThread?.turnDiffSummaries).toEqual([
      {
        turnId: "turn-1",
        completedAt,
        status: "completed",
        files: [],
        checkpointTurnCount: 1,
      },
    ]);
    await firstSystem.dispose();

    const secondSystem = await createOrchestrationSystem(stateDir);
    const restartedEngine = secondSystem.engine;
    const restartedThread = (await secondSystem.run(restartedEngine.getSnapshot())).threads.find(
      (thread) => thread.id === "thread-turn-diff",
    );
    expect(restartedThread?.turnDiffSummaries).toEqual([
      {
        turnId: "turn-1",
        completedAt,
        status: "completed",
        files: [],
        checkpointTurnCount: 1,
      },
    ]);
    await secondSystem.dispose();
  });

  it("reverts thread messages and turn summaries to a checkpoint", async () => {
    const stateDir = makeTempDir("t3code-orchestration-revert-");
    const firstSystem = await createOrchestrationSystem(stateDir);
    const engine = firstSystem.engine;
    const createdAt = new Date().toISOString();
    await firstSystem.run(
      engine.dispatch({
        type: "thread.create",
        commandId: "cmd-thread-revert",
        threadId: "thread-revert",
        projectId: "project-revert",
        title: "Revert thread",
        model: "gpt-5-codex",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await firstSystem.run(
      engine.dispatch({
        type: "message.send",
        commandId: "cmd-msg-1-user",
        threadId: "thread-revert",
        messageId: "user-1",
        role: "user",
        text: "first",
        streaming: false,
        createdAt,
      }),
    );
    await firstSystem.run(
      engine.dispatch({
        type: "message.send",
        commandId: "cmd-msg-1-assistant",
        threadId: "thread-revert",
        messageId: "assistant:turn-1",
        role: "assistant",
        text: "first-response",
        streaming: false,
        createdAt,
      }),
    );
    await firstSystem.run(
      engine.dispatch({
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
      }),
    );

    const createdAtSecond = new Date(Date.now() + 1_000).toISOString();
    await firstSystem.run(
      engine.dispatch({
        type: "message.send",
        commandId: "cmd-msg-2-user",
        threadId: "thread-revert",
        messageId: "user-2",
        role: "user",
        text: "second",
        streaming: false,
        createdAt: createdAtSecond,
      }),
    );
    await firstSystem.run(
      engine.dispatch({
        type: "message.send",
        commandId: "cmd-msg-2-assistant",
        threadId: "thread-revert",
        messageId: "assistant:turn-2",
        role: "assistant",
        text: "second-response",
        streaming: false,
        createdAt: createdAtSecond,
      }),
    );
    await firstSystem.run(
      engine.dispatch({
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
      }),
    );

    await firstSystem.run(
      engine.dispatch({
        type: "thread.revert",
        commandId: "cmd-thread-revert-apply",
        threadId: "thread-revert",
        turnCount: 1,
        messageCount: 2,
        createdAt: createdAtSecond,
      }),
    );

    const thread = (await firstSystem.run(engine.getSnapshot())).threads.find(
      (entry) => entry.id === "thread-revert",
    );
    expect(thread?.messages.map((message) => message.id)).toEqual(["user-1", "assistant:turn-1"]);
    expect(thread?.turnDiffSummaries.map((summary) => summary.turnId)).toEqual(["turn-1"]);
    expect(thread?.latestTurnId).toBe("turn-1");
    await firstSystem.dispose();

    const secondSystem = await createOrchestrationSystem(stateDir);
    const restarted = secondSystem.engine;
    const restartedThread = (await secondSystem.run(restarted.getSnapshot())).threads.find(
      (entry) => entry.id === "thread-revert",
    );
    expect(restartedThread?.messages.map((message) => message.id)).toEqual([
      "user-1",
      "assistant:turn-1",
    ]);
    expect(restartedThread?.turnDiffSummaries.map((summary) => summary.turnId)).toEqual(["turn-1"]);
    await secondSystem.dispose();
  });

  it("allows stop to be called multiple times", async () => {
    const inMemoryStore: OrchestrationEventRepositoryShape = {
      append(event) {
        return Effect.succeed({ ...event, sequence: 1 });
      },
      readFromSequence() {
        return Effect.succeed([]);
      },
      readAll() {
        return Effect.succeed([]);
      },
    };
    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(Layer.succeed(OrchestrationEventRepository, inMemoryStore)),
      ),
    );
    await runtime.runPromise(OrchestrationEngineService);
    await runtime.dispose();
    await expect(runtime.dispose()).resolves.toBeUndefined();
  });

  it("keeps processing queued commands after a storage failure", async () => {
    const events: OrchestrationEvent[] = [];
    let nextSequence = 1;
    let shouldFailFirstAppend = true;

    const flakyStore: OrchestrationEventRepositoryShape = {
      append(event) {
        if (shouldFailFirstAppend) {
          shouldFailFirstAppend = false;
          return Effect.die(new Error("append failed"));
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
    };

    const runtime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provide(Layer.succeed(OrchestrationEventRepository, flakyStore)),
      ),
    );
    const engine = await runtime.runPromise(OrchestrationEngineService);
    const createdAt = new Date().toISOString();

    await expect(
      runtime.runPromise(
        engine.dispatch({
          type: "thread.create",
          commandId: "cmd-flaky-1",
          threadId: "thread-flaky-fail",
          projectId: "project-flaky",
          title: "flaky-fail",
          model: "gpt-5-codex",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      ),
    ).rejects.toThrow("append failed");

    const result = await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: "cmd-flaky-2",
        threadId: "thread-flaky-ok",
        projectId: "project-flaky",
        title: "flaky-ok",
        model: "gpt-5-codex",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    expect(result.sequence).toBe(1);
    expect((await runtime.runPromise(engine.getSnapshot())).sequence).toBe(1);

    await runtime.dispose();
  });
});
