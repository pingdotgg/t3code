import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { MigrationsLive } from "../../persistence/Migrations.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { CapturedStepOutputReader } from "../Services/CapturedStepOutputReader.ts";
import { ProviderDispatchOutbox } from "../Services/ProviderDispatchOutbox.ts";
import { CapturedStepOutputReaderLive } from "./CapturedStepOutputReader.ts";

const layer = it.layer(
  CapturedStepOutputReaderLive.pipe(
    Layer.provideMerge(
      Layer.succeed(ProviderDispatchOutbox, {
        confirmStep: () => Effect.void,
        ensureStarted: () => Effect.succeed({ turnId: "turn-captured-output" as never }),
        getDispatchForStep: () =>
          Effect.succeed({
            threadId: "thread-captured-output" as never,
            turnId: "turn-captured-output" as never,
          }),
        awaitTerminal: () => Effect.succeed({ ok: true }),
        awaitStepTerminal: () => Effect.succeed({ ok: true }),
        recoverPending: () => Effect.void,
      }),
    ),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const seedAssistantMessage = (text: string) =>
  seedAssistantMessageFor({
    threadId: "thread-captured-output",
    turnId: "turn-captured-output",
    messageId: "message-captured-output",
    text,
  });

const seedAssistantMessageFor = (input: {
  readonly threadId: string;
  readonly turnId: string;
  readonly messageId: string;
  readonly text: string;
}) =>
  Effect.gen(function* () {
    const turns = yield* ProjectionTurnRepository;
    const messages = yield* ProjectionThreadMessageRepository;
    yield* turns.upsertByTurnId({
      threadId: input.threadId as never,
      turnId: input.turnId as never,
      pendingMessageId: null,
      sourceProposedPlanThreadId: null,
      sourceProposedPlanId: null,
      assistantMessageId: input.messageId as never,
      state: "completed",
      requestedAt: "2026-06-07T00:00:00.000Z" as never,
      startedAt: "2026-06-07T00:00:00.000Z" as never,
      completedAt: "2026-06-07T00:00:01.000Z" as never,
      checkpointTurnCount: null,
      checkpointRef: null,
      checkpointStatus: null,
      checkpointFiles: [],
    });
    yield* messages.upsert({
      messageId: input.messageId as never,
      threadId: input.threadId as never,
      turnId: input.turnId as never,
      role: "assistant",
      text: input.text,
      isStreaming: false,
      createdAt: "2026-06-07T00:00:01.000Z" as never,
      updatedAt: "2026-06-07T00:00:01.000Z" as never,
    });
  });

layer("CapturedStepOutputReader", (it) => {
  it.effect("returns the last object from a fenced JSON block", () =>
    Effect.gen(function* () {
      const reader = yield* CapturedStepOutputReader;
      yield* seedAssistantMessage(
        [
          "Earlier:",
          "```json",
          '{"verdict":"ignore"}',
          "```",
          "Final:",
          "```json",
          '{"verdict":"pass","score":0.98}',
          "```",
        ].join("\n"),
      );

      const output = yield* reader.read({
        stepRunId: "step-captured-output" as never,
        threadId: "thread-captured-output" as never,
        turnId: "turn-captured-output" as never,
      });

      assert.deepEqual(output, { verdict: "pass", score: 0.98 });
    }),
  );

  it.effect("reads the assistant message for the exact awaited turn, not the latest dispatch", () =>
    Effect.gen(function* () {
      const reader = yield* CapturedStepOutputReader;
      yield* seedAssistantMessage('Latest dispatch.\n```json\n{"verdict":"latest"}\n```');
      yield* seedAssistantMessageFor({
        threadId: "thread-captured-output",
        turnId: "turn-awaited",
        messageId: "message-awaited",
        text: 'Awaited turn.\n```json\n{"verdict":"awaited"}\n```',
      });

      const output = yield* reader.read({
        stepRunId: "step-captured-output" as never,
        threadId: "thread-captured-output" as never,
        turnId: "turn-awaited" as never,
      } as never);

      assert.deepEqual(output, { verdict: "awaited" });
    }),
  );

  it.effect("returns undefined when no valid object block exists", () =>
    Effect.gen(function* () {
      const reader = yield* CapturedStepOutputReader;
      yield* seedAssistantMessage("Done without structured output.");

      const output = yield* reader.read({
        stepRunId: "step-captured-output" as never,
        threadId: "thread-captured-output" as never,
        turnId: "turn-captured-output" as never,
      });

      assert.equal(output, undefined);
    }),
  );

  it.effect("falls back to earlier messages in the turn when the final one has no block", () =>
    Effect.gen(function* () {
      const reader = yield* CapturedStepOutputReader;
      const messages = yield* ProjectionThreadMessageRepository;
      // The turn's recorded final message is a closing remark; the verdict
      // was emitted in an earlier message of the same multi-message turn.
      yield* seedAssistantMessage("All set — see the verdict above.");
      yield* messages.upsert({
        messageId: "message-earlier-verdict" as never,
        threadId: "thread-captured-output" as never,
        turnId: "turn-captured-output" as never,
        role: "assistant",
        text: 'Findings reviewed.\n```json\n{"verdict":"approve"}\n```',
        isStreaming: false,
        createdAt: "2026-06-07T00:00:00.500Z" as never,
        updatedAt: "2026-06-07T00:00:00.500Z" as never,
      });
      // A different turn's verdict must never bleed in.
      yield* messages.upsert({
        messageId: "message-other-turn" as never,
        threadId: "thread-captured-output" as never,
        turnId: "turn-unrelated" as never,
        role: "assistant",
        text: '```json\n{"verdict":"unrelated"}\n```',
        isStreaming: false,
        createdAt: "2026-06-07T00:00:00.900Z" as never,
        updatedAt: "2026-06-07T00:00:00.900Z" as never,
      });

      const output = yield* reader.read({
        stepRunId: "step-captured-output" as never,
        threadId: "thread-captured-output" as never,
        turnId: "turn-captured-output" as never,
      });

      assert.deepEqual(output, { verdict: "approve" });
    }),
  );
});

it.effect(
  "CapturedStepOutputReader propagates repository lookup errors instead of returning undefined",
  () =>
    Effect.gen(function* () {
      const readerErrorLayer = CapturedStepOutputReaderLive.pipe(
        Layer.provideMerge(
          Layer.succeed(ProjectionTurnRepository, {
            upsertByTurnId: () => Effect.void,
            replacePendingTurnStart: () => Effect.void,
            getPendingTurnStartByThreadId: () => Effect.succeed(Option.none()),
            deletePendingTurnStartByThreadId: () => Effect.void,
            listByThreadId: () => Effect.succeed([]),
            getByTurnId: () =>
              Effect.fail(
                new PersistenceSqlError({
                  operation: "ProjectionTurnRepository.getByTurnId:test",
                  detail: "simulated lookup failure",
                }),
              ),
            clearCheckpointTurnConflict: () => Effect.void,
            deleteByThreadId: () => Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ProjectionThreadMessageRepository, {
            upsert: () => Effect.void,
            getByMessageId: () => Effect.succeed(Option.none()),
            listByThreadId: () => Effect.succeed([]),
            deleteByThreadId: () => Effect.void,
          }),
        ),
      );

      const exit = yield* Effect.gen(function* () {
        const reader = yield* CapturedStepOutputReader;
        return yield* reader.read({
          stepRunId: "step-error" as never,
          threadId: "thread-error" as never,
          turnId: "turn-error" as never,
        });
      }).pipe(Effect.provide(readerErrorLayer), Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause);
        assert.equal((error as { readonly _tag?: string })._tag, "WorkflowEventStoreError");
        assert.equal(
          (error as { readonly message?: string }).message,
          "structured output turn lookup failed",
        );
      }
    }),
);
