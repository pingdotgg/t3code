import { assert, it } from "@effect/vitest";
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  ProjectionThreadActivityRepository,
  type ProjectionThreadActivity,
} from "../../persistence/Services/ProjectionThreadActivities.ts";
import { StepUsageReader } from "../Services/StepUsageReader.ts";
import { StepUsageReaderLive } from "./StepUsageReader.ts";

const threadId = "thread-usage" as ThreadId;

const activity = (overrides: Partial<ProjectionThreadActivity>): ProjectionThreadActivity =>
  ({
    activityId: "act-1" as never,
    threadId,
    turnId: null,
    tone: "info",
    kind: "context-window.updated",
    summary: "Context window updated",
    payload: {},
    createdAt: "2026-06-09T00:00:00.000Z",
    ...overrides,
  }) as ProjectionThreadActivity;

const layerWith = (rows: ReadonlyArray<ProjectionThreadActivity>) =>
  StepUsageReaderLive.pipe(
    Layer.provideMerge(
      Layer.succeed(ProjectionThreadActivityRepository, {
        upsert: () => Effect.void,
        listByThreadId: () => Effect.succeed(rows),
        deleteByThreadId: () => Effect.void,
      }),
    ),
  );

const readUsage = (rows: ReadonlyArray<ProjectionThreadActivity>) =>
  Effect.gen(function* () {
    const reader = yield* StepUsageReader;
    return yield* reader.read(threadId);
  }).pipe(Effect.provide(layerWith(rows)));

it.effect("maps the latest context-window snapshot to workflow usage", () =>
  Effect.gen(function* () {
    const usage = yield* readUsage([
      activity({
        activityId: "act-1" as never,
        payload: { usedTokens: 100, inputTokens: 80, outputTokens: 20 },
      }),
      activity({
        activityId: "act-2" as never,
        payload: {
          usedTokens: 500,
          totalProcessedTokens: 1200,
          inputTokens: 900,
          cachedInputTokens: 300,
          outputTokens: 250,
        },
      }),
    ]);

    assert.deepEqual(usage, {
      inputTokens: 900,
      cachedInputTokens: 300,
      outputTokens: 250,
      totalTokens: 1200,
    });
  }),
);

it.effect("ignores other activity kinds and malformed payloads", () =>
  Effect.gen(function* () {
    const usage = yield* readUsage([
      activity({ activityId: "act-1" as never, payload: { usedTokens: 42, inputTokens: 30 } }),
      activity({
        activityId: "act-2" as never,
        kind: "tool.completed",
        payload: { usedTokens: 999999 },
      }),
      activity({ activityId: "act-3" as never, payload: { usedTokens: "not-a-number" } }),
    ]);

    assert.deepEqual(usage, { inputTokens: 30, totalTokens: 42 });
  }),
);

it.effect("returns undefined when no usage was emitted", () =>
  Effect.gen(function* () {
    const usage = yield* readUsage([]);
    assert.equal(usage, undefined);
  }),
);
