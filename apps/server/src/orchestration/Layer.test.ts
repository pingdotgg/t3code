import type { OrchestrationEvent } from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime, Queue, Stream } from "effect";
import { describe, expect, it } from "vitest";

import {
  OrchestrationEventRepository,
  type OrchestrationEventRepositoryShape,
} from "../persistence/Services/OrchestrationEvents.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEngineLive } from "./Layer.ts";
import { OrchestrationEngineService } from "./Service.ts";
import { OrchestrationEventRepositoryLive } from "../persistence/Layers/OrchestrationEvents.ts";

export async function createOrchestrationSystem() {
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationEventRepositoryLive),
    Layer.provide(SqlitePersistenceMemory),
  );
  const runtime = ManagedRuntime.make(orchestrationLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  return {
    engine,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

describe("OrchestrationEngine", () => {
  it("returns deterministic snapshots for repeated reads", async () => {
    const createdAt = new Date().toISOString();
    const projectId = "project-1";
    const threadId = "thread-1";

    const system = await createOrchestrationSystem();
    const engine = system.engine;
    await system.run(
      engine.dispatch({
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
    await system.run(
      engine.dispatch({
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
    const snapshotA = await system.run(engine.getSnapshot());
    const snapshotB = await system.run(engine.getSnapshot());
    expect(snapshotB).toEqual(snapshotA);
    await system.dispose();
  });

  it("replays append-only events from sequence", async () => {
    const system = await createOrchestrationSystem();
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

  it("streams persisted domain events in order", async () => {
    const system = await createOrchestrationSystem();
    const engine = system.engine;
    const eventTypes: string[] = [];
    await system.run(
      Effect.gen(function* () {
        const eventQueue = yield* Queue.unbounded<OrchestrationEvent>();
        yield* Effect.forkScoped(
          Stream.take(engine.streamDomainEvents, 2).pipe(
            Stream.runForEach((event) => Queue.offer(eventQueue, event).pipe(Effect.asVoid)),
          ),
        );
        yield* Effect.sleep("10 millis");
        const createdAt = new Date().toISOString();
        yield* engine.dispatch({
          type: "thread.create",
          commandId: "cmd-stream-domain-a",
          threadId: "thread-stream-domain",
          projectId: "project-stream-domain",
          title: "domain-stream",
          model: "gpt-5-codex",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: "cmd-stream-domain-b",
          threadId: "thread-stream-domain",
          title: "domain-stream-updated",
          createdAt,
        });
        eventTypes.push((yield* Queue.take(eventQueue)).type);
        eventTypes.push((yield* Queue.take(eventQueue)).type);
      }).pipe(Effect.scoped),
    );
    expect(eventTypes).toEqual(["thread.created", "thread.meta-updated"]);
    await system.dispose();
  });

  it("stores completed turn summaries even when no files changed", async () => {
    const system = await createOrchestrationSystem();
    const engine = system.engine;
    const completedAt = new Date().toISOString();
    await system.run(
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
    await system.run(
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

    const firstThread = (await system.run(engine.getSnapshot())).threads.find(
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
    await system.dispose();
  });

  it("reverts thread messages and turn summaries to a checkpoint", async () => {
    const system = await createOrchestrationSystem();
    const engine = system.engine;
    const createdAt = new Date().toISOString();
    await system.run(
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
    await system.run(
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
    await system.run(
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
    await system.run(
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
    await system.run(
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
    await system.run(
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
    await system.run(
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

    await system.run(
      engine.dispatch({
        type: "thread.revert",
        commandId: "cmd-thread-revert-apply",
        threadId: "thread-revert",
        turnCount: 1,
        messageCount: 2,
        createdAt: createdAtSecond,
      }),
    );

    const thread = (await system.run(engine.getSnapshot())).threads.find(
      (entry) => entry.id === "thread-revert",
    );
    expect(thread?.messages.map((message) => message.id)).toEqual(["user-1", "assistant:turn-1"]);
    expect(thread?.turnDiffSummaries.map((summary) => summary.turnId)).toEqual(["turn-1"]);
    expect(thread?.latestTurnId).toBe("turn-1");
    await system.dispose();
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
    await runtime.runPromise(Effect.service(OrchestrationEngineService));
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
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.append",
              detail: "append failed",
            }),
          );
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
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
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
