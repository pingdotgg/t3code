import { ThreadUrl } from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  decodeNestedThreadBatchCreationOutcome,
  decodeNestedThreadCreationOutcome,
  runNestedThreadCreationPhases,
} from "./nestedThreadCreation.ts";
import { OrchestrationDispatchCommandError } from "@t3tools/contracts";
import { isDefinitiveCommandRejectionError } from "./cli/client.ts";

class PhaseError extends Error {
  readonly definitive: boolean;

  constructor(message: string, definitive: boolean) {
    super(message);
    this.definitive = definitive;
  }
}

const fail = (message: string, definitive: boolean) =>
  Effect.fail(new PhaseError(message, definitive));

const run = (
  phases: Partial<{
    readonly createThread: Effect.Effect<ThreadUrl | null, PhaseError>;
    readonly startTurn: Effect.Effect<void, PhaseError>;
    readonly cleanupThread: Effect.Effect<void, PhaseError>;
  }> = {},
) =>
  Effect.runPromise(
    runNestedThreadCreationPhases("child-1", true, {
      createThread:
        phases.createThread ?? Effect.succeed(ThreadUrl.make("https://app.example/env/child-1")),
      startTurn: phases.startTurn ?? Effect.void,
      cleanupThread: phases.cleanupThread ?? Effect.void,
      classifyFailure: (error) =>
        error instanceof PhaseError
          ? { definitive: error.definitive, message: error.message }
          : { definitive: false, message: String(error) },
    }),
  );

const createdOutcome = {
  status: "created",
  threadId: "child-1",
  threadUrl: "https://app.example/env/child-1",
  retryable: false,
  workspaceCreated: true,
  cleanupPerformed: false,
  errorCode: null,
  message: "Nested thread created and its first turn was accepted.",
} as const;

describe("runNestedThreadCreationPhases", () => {
  it("preserves indexed per-item outcomes in the batch contract", () => {
    expect(
      decodeNestedThreadBatchCreationOutcome({
        results: [
          { index: 0, outcome: createdOutcome },
          {
            index: 1,
            outcome: {
              status: "failed",
              threadId: null,
              threadUrl: null,
              retryable: true,
              workspaceCreated: false,
              cleanupPerformed: false,
              errorCode: "VALIDATION_FAILED",
              message: "Duplicate workspace.",
            },
          },
        ],
      }),
    ).toEqual({
      results: [
        { index: 0, outcome: createdOutcome },
        {
          index: 1,
          outcome: {
            status: "failed",
            threadId: null,
            threadUrl: null,
            retryable: true,
            workspaceCreated: false,
            cleanupPerformed: false,
            errorCode: "VALIDATION_FAILED",
            message: "Duplicate workspace.",
          },
        },
      ],
    });
  });

  it("rejects semantically invalid structured outcomes", () => {
    for (const outcome of [
      { ...createdOutcome, threadId: null },
      { ...createdOutcome, errorCode: "CLI_RESPONSE_INVALID" },
      {
        ...createdOutcome,
        status: "dry-run",
        threadId: null,
        workspaceCreated: true,
      },
    ]) {
      expect(() => decodeNestedThreadCreationOutcome(outcome)).toThrow();
    }
  });

  it("reports the complete stable success contract", async () => {
    await expect(run()).resolves.toEqual({
      status: "created",
      threadId: "child-1",
      threadUrl: "https://app.example/env/child-1",
      retryable: false,
      workspaceCreated: true,
      cleanupPerformed: false,
      errorCode: null,
      message: "Nested thread created and its first turn was accepted.",
    });
  });

  it("makes a definitive thread-create rejection safely retryable", async () => {
    await expect(run({ createThread: fail("create rejected", true) })).resolves.toMatchObject({
      status: "failed",
      threadId: null,
      retryable: true,
      cleanupPerformed: false,
      errorCode: "THREAD_CREATE_REJECTED",
    });
  });

  it("preserves the generated id after an ambiguous thread-create failure", async () => {
    await expect(run({ createThread: fail("response lost", false) })).resolves.toMatchObject({
      status: "ambiguous",
      threadId: "child-1",
      retryable: false,
      cleanupPerformed: false,
      errorCode: "THREAD_CREATE_AMBIGUOUS",
    });
  });

  it("does not clean up when first-turn acceptance is ambiguous", async () => {
    let cleanupCalls = 0;
    const outcome = await run({
      startTurn: fail("turn response lost", false),
      cleanupThread: Effect.sync(() => {
        cleanupCalls += 1;
      }),
    });

    expect(outcome).toMatchObject({
      status: "ambiguous",
      threadId: "child-1",
      retryable: false,
      cleanupPerformed: false,
      errorCode: "TURN_START_AMBIGUOUS",
    });
    expect(cleanupCalls).toBe(0);
  });

  it("cleans up a definitively rejected first turn and permits a safe retry", async () => {
    await expect(run({ startTurn: fail("turn rejected", true) })).resolves.toMatchObject({
      status: "failed",
      threadId: "child-1",
      retryable: true,
      cleanupPerformed: true,
      errorCode: "TURN_START_REJECTED",
    });
  });

  it("cleans up typed RPC command rejections but preserves transport ambiguity", async () => {
    let cleanupCalls = 0;
    const runRpcFailure = (error: OrchestrationDispatchCommandError) =>
      Effect.runPromise(
        runNestedThreadCreationPhases("child-1", true, {
          createThread: Effect.succeed(ThreadUrl.make("https://app.example/env/child-1")),
          startTurn: Effect.fail(error),
          cleanupThread: Effect.sync(() => {
            cleanupCalls += 1;
          }),
          classifyFailure: (failure) => ({
            definitive: isDefinitiveCommandRejectionError(failure),
            message: failure instanceof Error ? failure.message : String(failure),
          }),
        }),
      );
    const rejected = await runRpcFailure(
      new OrchestrationDispatchCommandError({
        message: "First turn rejected.",
        cause: { _tag: "OrchestrationCommandInvariantError" },
      }),
    );

    expect(rejected).toMatchObject({
      status: "failed",
      errorCode: "TURN_START_REJECTED",
      cleanupPerformed: true,
    });
    expect(cleanupCalls).toBe(1);

    const ambiguous = await runRpcFailure(
      new OrchestrationDispatchCommandError({
        message: "RPC connection was lost.",
        cause: { _tag: "CliLiveTargetError" },
      }),
    );
    expect(ambiguous).toMatchObject({
      status: "ambiguous",
      errorCode: "TURN_START_AMBIGUOUS",
      cleanupPerformed: false,
    });
    expect(cleanupCalls).toBe(1);

    const unrecordedRejection = await runRpcFailure(
      new OrchestrationDispatchCommandError({
        message: "Delegation rejection could not be audited.",
        cause: {
          _tag: "OrchestrationCommandInvariantError",
          detail: "Delegation audit persistence is unavailable.",
        },
      }),
    );
    expect(unrecordedRejection).toMatchObject({
      status: "ambiguous",
      errorCode: "TURN_START_AMBIGUOUS",
      cleanupPerformed: false,
    });
    expect(cleanupCalls).toBe(1);
  });

  it("reports a definitive cleanup rejection with the committed thread id", async () => {
    await expect(
      run({
        startTurn: fail("turn rejected", true),
        cleanupThread: fail("delete rejected", true),
      }),
    ).resolves.toMatchObject({
      status: "failed",
      threadId: "child-1",
      retryable: false,
      cleanupPerformed: false,
      errorCode: "THREAD_CLEANUP_REJECTED",
    });
  });

  it("reports ambiguous cleanup without claiming a safe retry", async () => {
    await expect(
      run({
        startTurn: fail("turn rejected", true),
        cleanupThread: fail("delete response lost", false),
      }),
    ).resolves.toMatchObject({
      status: "ambiguous",
      threadId: "child-1",
      retryable: false,
      cleanupPerformed: false,
      errorCode: "THREAD_CLEANUP_AMBIGUOUS",
    });
  });
});
