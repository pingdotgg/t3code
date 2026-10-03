import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { Effect, Option, Schema, Sink, Stream } from "effect";

import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionThreadMessageRepository } from "../../../persistence/Services/ProjectionThreadMessages.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { T3ThreadReadResult } from "./tools.ts";
import { ThreadContextToolkitHandlersLive } from "./handlers.ts";
import { ThreadContextToolkit } from "./tools.ts";

const callerThreadId = ThreadId.make("thread-caller");
const targetThreadId = ThreadId.make("thread-target");

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: callerThreadId,
  providerSessionId: "provider-session",
  providerInstanceId: ProviderInstanceId.make("copilot"),
  capabilities: new Set(),
  issuedAt: 1,
};

const shell = {
  id: targetThreadId,
  projectId: ProjectId.make("project-1"),
  title: "Target thread",
  archivedAt: null,
} as unknown as OrchestrationThreadShell;

const messageRow = (
  index: number,
  text = `message ${index}`,
  createdAt = `2026-04-01T00:00:0${index}.000Z`,
) => ({
  messageId: MessageId.make(`message-${index}`),
  threadId: targetThreadId,
  turnId: null,
  role: "user" as const,
  text,
  isStreaming: false,
  createdAt,
  updatedAt: createdAt,
});

const runRead = (
  input: {
    readonly threadId: ThreadId;
    readonly afterCreatedAt?: string;
    readonly afterMessageId?: MessageId;
    readonly limit?: number;
  },
  overrides?: {
    readonly shellOption?: Option.Option<OrchestrationThreadShell>;
    readonly rows?: ReadonlyArray<ReturnType<typeof messageRow>>;
  },
) =>
  Effect.gen(function* () {
    const toolkit = yield* ThreadContextToolkit;
    return yield* toolkit
      .handle("t3_thread_read", input)
      .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption));
  }).pipe(
    Effect.provide(ThreadContextToolkitHandlersLive),
    Effect.provideService(ProjectionSnapshotQuery, {
      getThreadShellById: () => Effect.succeed(overrides?.shellOption ?? Option.some(shell)),
    } as unknown as ProjectionSnapshotQuery["Service"]),
    Effect.provideService(ProjectionThreadMessageRepository, {
      listMessagesPage: () => Effect.succeed(overrides?.rows ?? []),
    } as unknown as ProjectionThreadMessageRepository["Service"]),
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
  );

const decodeResult = Schema.decodeUnknownSync(T3ThreadReadResult);

it.effect("rejects reads of missing or deleted threads", () =>
  Effect.gen(function* () {
    const outcome = yield* runRead(
      { threadId: targetThreadId },
      { shellOption: Option.none() },
    ).pipe(Effect.result);
    assert.strictEqual(outcome._tag, "Failure");
    if (outcome._tag === "Failure") {
      assert.include(String(outcome.failure), "not found");
    }
  }),
);

it.effect("rejects a message cursor without its timestamp", () =>
  Effect.gen(function* () {
    const outcome = yield* runRead({
      threadId: targetThreadId,
      afterMessageId: MessageId.make("message-1"),
    }).pipe(Effect.result);
    assert.strictEqual(outcome._tag, "Failure");
    if (outcome._tag === "Failure") {
      assert.include(String(outcome.failure), "cursor");
    }
  }),
);

it.effect("pages bounded results from the same server without expanding references", () =>
  Effect.gen(function* () {
    const nested = "see [Other](t3-context://v1/thread/ctx_9) for details";
    const outcome = yield* runRead(
      { threadId: targetThreadId, limit: 2 },
      { rows: [messageRow(0), messageRow(1, nested), messageRow(2)] },
    );
    assert.isFalse(outcome.isFailure);
    const result = decodeResult(outcome.result);
    // The handler over-reads by one to detect the next page; only the limit is returned.
    assert.equal(result.messages.length, 2);
    assert.isTrue(result.hasMore);
    assert.isNotNull(result.nextCursor);
    assert.equal(result.threadId, targetThreadId);
    assert.equal(result.title, "Target thread");
    // Reference-only: nested inline references travel verbatim, never expanded.
    assert.equal(result.messages[1]?.text, nested);
    assert.isFalse(result.messages[1]?.truncated ?? true);
  }),
);

it.effect("truncates oversized message text with an explicit marker", () =>
  Effect.gen(function* () {
    const outcome = yield* runRead(
      { threadId: targetThreadId },
      { rows: [messageRow(0, "x".repeat(9_000))] },
    );
    assert.isFalse(outcome.isFailure);
    const result = decodeResult(outcome.result);
    assert.isTrue(result.messages[0]?.truncated);
    assert.isBelow((result.messages[0]?.text.length ?? 0) + 1, 9_000);
    assert.isFalse(result.hasMore);
    assert.isNull(result.nextCursor);
  }),
);

it.effect("reads a different thread on the same server for reference", () =>
  Effect.gen(function* () {
    // Server-scoped authority: any thread in this server's projection is readable
    // as reference material. The tool is read-only, so no send/message authority exists.
    assert.notEqual(callerThreadId, targetThreadId);
    const outcome = yield* runRead({ threadId: targetThreadId }, { rows: [messageRow(0)] });
    assert.isFalse(outcome.isFailure);
  }),
);
