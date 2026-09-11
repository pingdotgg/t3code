import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type ProviderReplayEntry,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";

import {
  CLAUDE_PROVIDER,
  ClaudeAgentSdkQueryRunnerError,
  makeClaudeUserMessage,
  type ClaudeAgentSdkQueryOptions,
} from "./ClaudeAdapterV2.ts";
import {
  CLAUDE_AGENT_SDK_REPLAY_PROTOCOL,
  ClaudeReplayIncompleteError,
  ClaudeReplayRuntimeExitError,
  ClaudeReplayUnexpectedOutboundError,
  makeReplayQueryRunner,
  recordInterruptedClaudeQuery,
  recordMessagesUntilTurnResultAndFinalize,
} from "./ClaudeAdapterV2.testkit.ts";
import { makeProviderReplayGate } from "../testkit/ProviderReplayGate.testkit.ts";

const isClaudeAgentSdkQueryRunnerError = Schema.is(ClaudeAgentSdkQueryRunnerError);
const isClaudeReplayIncompleteError = Schema.is(ClaudeReplayIncompleteError);
const isClaudeReplayRuntimeExitError = Schema.is(ClaudeReplayRuntimeExitError);
const isClaudeReplayUnexpectedOutboundError = Schema.is(ClaudeReplayUnexpectedOutboundError);

const claudeSdkMock = vi.hoisted(() => {
  const close = vi.fn();
  const interrupt = vi.fn(async () => {});
  let prompt: AsyncIterable<unknown> | undefined;
  const query = vi.fn((input: { readonly prompt: AsyncIterable<unknown> }) => {
    prompt = input.prompt;
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: true as const, value: undefined }),
      }),
      close,
      interrupt,
    };
  });

  return {
    close,
    interrupt,
    getPrompt: () => prompt,
    query,
    reset: () => {
      close.mockClear();
      interrupt.mockClear();
      query.mockClear();
      prompt = undefined;
    },
  };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: vi.fn(),
  query: claudeSdkMock.query,
}));

function makeGatedReplaySession() {
  const options = {
    model: "claude-sonnet-4-6",
    tools: [],
    permissionMode: "default",
    sessionId: "session-replay-gate",
  } satisfies ClaudeAgentSdkQueryOptions;
  const label = "background_tasks_changed:empty";
  const replayGate = makeProviderReplayGate([label]);
  const runner = makeReplayQueryRunner(
    {
      provider: CLAUDE_PROVIDER,
      protocol: CLAUDE_AGENT_SDK_REPLAY_PROTOCOL,
      version: "test",
      scenario: "labeled-inbound-replay-gate",
      entries: [
        {
          type: "expect_outbound",
          frame: {
            type: "query.open",
            options,
          },
        },
        {
          type: "emit_inbound",
          label,
          frame: {
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [],
            uuid: "replay-gate-message",
            session_id: options.sessionId,
          },
        },
        {
          type: "runtime_exit",
          status: "success",
        },
      ],
    },
    { replayGate },
  );
  const session = runner.open({
    options,
    threadId: ThreadId.make("thread-replay-gate"),
    providerSessionId: ProviderSessionId.make("provider-session-replay-gate"),
  });
  return { label, replayGate, runner, session };
}

const yieldToReplayStream = Effect.promise(
  () =>
    new Promise<void>((resolve) => {
      setImmediate(resolve);
    }),
);

describe("ClaudeAdapterV2 replay testkit", () => {
  it.effect("holds a labeled inbound frame until its replay gate is released", () =>
    Effect.gen(function* () {
      const { label, replayGate, runner, session } = makeGatedReplaySession();
      const streamFiber = yield* Stream.runDrain(session.messages).pipe(Effect.forkChild);

      yield* yieldToReplayStream;
      assert.isTrue(replayGate.hasReached(label));
      assert.isUndefined(streamFiber.pollUnsafe());

      assert.isTrue(replayGate.release(label));
      yield* Fiber.join(streamFiber);
      runner.assertComplete();
    }),
  );

  it.effect("releases a replay gate when its stream consumer is interrupted", () =>
    Effect.gen(function* () {
      const { label, replayGate, session } = makeGatedReplaySession();
      const streamFiber = yield* Stream.runDrain(session.messages).pipe(Effect.forkChild);

      yield* yieldToReplayStream;
      assert.isTrue(replayGate.hasReached(label));

      yield* Fiber.interrupt(streamFiber);
      assert.isFalse(replayGate.release(label));
    }),
  );

  it.effect("interrupts a delayed inbound frame without emitting or advancing it", () =>
    Effect.gen(function* () {
      const options = {
        model: "claude-sonnet-4-6",
        tools: [],
        permissionMode: "default",
        sessionId: "session-replay-delayed-interrupt",
      } satisfies ClaudeAgentSdkQueryOptions;
      const label = "delayed-inbound";
      const replayGate = makeProviderReplayGate([label]);
      const runner = makeReplayQueryRunner(
        {
          provider: CLAUDE_PROVIDER,
          protocol: CLAUDE_AGENT_SDK_REPLAY_PROTOCOL,
          version: "test",
          scenario: "delayed-inbound-interruption",
          entries: [
            {
              type: "expect_outbound",
              frame: {
                type: "query.open",
                options,
              },
            },
            {
              type: "emit_inbound",
              label,
              afterMs: 30_000,
              frame: {
                type: "assistant",
                message: { content: [] },
                parent_tool_use_id: null,
                session_id: options.sessionId,
                uuid: "delayed-inbound-message",
              },
            },
            {
              type: "runtime_exit",
              status: "success",
            },
          ],
        },
        { replayGate },
      );
      const session = runner.open({
        options,
        threadId: ThreadId.make("thread-replay-delayed-interrupt"),
        providerSessionId: ProviderSessionId.make("provider-session-replay-delayed-interrupt"),
      });
      const emittedMessages: Array<unknown> = [];
      const streamFiber = yield* session.messages.pipe(
        Stream.tap((message) => Effect.sync(() => emittedMessages.push(message))),
        Stream.runDrain,
        Effect.forkChild,
      );

      yield* yieldToReplayStream;
      assert.isTrue(replayGate.hasReached(label));
      assert.isTrue(replayGate.release(label));
      yield* yieldToReplayStream;

      yield* Fiber.interrupt(streamFiber);

      assert.deepEqual(emittedMessages, []);
      const incomplete = assert.throws(() => runner.assertComplete());
      assert.isTrue(isClaudeReplayIncompleteError(incomplete));
      if (isClaudeReplayIncompleteError(incomplete)) {
        assert.equal(incomplete.cursor, 1);
        assert.equal(incomplete.remaining, 2);
      }
    }),
  );

  it.effect("wakes a gated replay stream when an outbound frame mismatches", () =>
    Effect.gen(function* () {
      const { label, replayGate, session } = makeGatedReplaySession();
      const emittedMessages: Array<unknown> = [];
      const streamFiber = yield* session.messages.pipe(
        Stream.tap((message) => Effect.sync(() => emittedMessages.push(message))),
        Stream.runDrain,
        Effect.exit,
        Effect.forkChild,
      );

      yield* yieldToReplayStream;
      assert.isTrue(replayGate.hasReached(label));

      const offerExit = yield* Effect.exit(
        session.offer(makeClaudeUserMessage({ text: "unexpected gated prompt" })),
      );
      assert.isTrue(Exit.isFailure(offerExit));

      const streamExit = yield* Fiber.join(streamFiber);
      assert.isTrue(Exit.isFailure(streamExit));
      if (Exit.isFailure(streamExit)) {
        const error = Cause.squash(streamExit.cause);
        assert.isTrue(isClaudeAgentSdkQueryRunnerError(error));
        if (isClaudeAgentSdkQueryRunnerError(error)) {
          assert.isTrue(isClaudeReplayUnexpectedOutboundError(error.cause));
        }
      }
      assert.deepEqual(emittedMessages, []);
    }),
  );

  it.effect("surfaces an outbound mismatch during a delay without inbound callbacks", () =>
    Effect.gen(function* () {
      const stableOptions = {
        model: "claude-sonnet-4-6",
        tools: [],
        permissionMode: "default",
        sessionId: "session-replay-gated-permission",
      } satisfies ClaudeAgentSdkQueryOptions;
      const canUseTool = vi.fn<NonNullable<ClaudeAgentSdkQueryOptions["canUseTool"]>>(
        async (_toolName, input, options) => ({
          behavior: "allow",
          updatedInput: input,
          toolUseID: options.toolUseID,
        }),
      );
      const label = "permission_request";
      const replayGate = makeProviderReplayGate([label]);
      const runner = makeReplayQueryRunner(
        {
          provider: CLAUDE_PROVIDER,
          protocol: CLAUDE_AGENT_SDK_REPLAY_PROTOCOL,
          version: "test",
          scenario: "gated-permission-stops-after-failure",
          entries: [
            {
              type: "expect_outbound",
              frame: {
                type: "query.open",
                options: stableOptions,
              },
            },
            {
              type: "emit_inbound",
              label,
              afterMs: 30_000,
              frame: {
                type: "permission.request",
                toolName: "Read",
                input: { file_path: "/workspace/gated.ts" },
                options: { toolUseID: "tool-use-gated" },
              },
            },
            {
              type: "runtime_exit",
              status: "success",
            },
          ],
        },
        { replayGate },
      );
      const session = runner.open({
        options: { ...stableOptions, canUseTool },
        threadId: ThreadId.make("thread-replay-gated-permission"),
        providerSessionId: ProviderSessionId.make("provider-session-replay-gated-permission"),
      });
      const emittedMessages: Array<unknown> = [];
      const streamFiber = yield* session.messages.pipe(
        Stream.tap((message) => Effect.sync(() => emittedMessages.push(message))),
        Stream.runDrain,
        Effect.exit,
        Effect.forkChild,
      );

      yield* yieldToReplayStream;
      assert.isTrue(replayGate.hasReached(label));
      assert.isTrue(replayGate.release(label));
      yield* yieldToReplayStream;

      const offerExit = yield* Effect.exit(
        session.offer(makeClaudeUserMessage({ text: "unexpected gated prompt" })),
      );
      assert.isTrue(Exit.isFailure(offerExit));

      const streamExit = yield* Fiber.join(streamFiber);
      assert.isTrue(Exit.isFailure(streamExit));
      if (Exit.isFailure(streamExit)) {
        const error = Cause.squash(streamExit.cause);
        assert.isTrue(isClaudeAgentSdkQueryRunnerError(error));
        if (isClaudeAgentSdkQueryRunnerError(error)) {
          assert.isTrue(isClaudeReplayUnexpectedOutboundError(error.cause));
        }
      }
      assert.deepEqual(emittedMessages, []);
      assert.equal(canUseTool.mock.calls.length, 0);
    }),
  );

  it.effect("wakes a replay stream waiting on an outbound frame when that frame mismatches", () =>
    Effect.gen(function* () {
      const options = {
        model: "claude-sonnet-4-6",
        tools: [],
        permissionMode: "default",
        sessionId: "session-replay-mismatch",
      } satisfies ClaudeAgentSdkQueryOptions;
      const expectedMessage = makeClaudeUserMessage({ text: "expected prompt" });
      const actualMessage = makeClaudeUserMessage({ text: "unexpected prompt" });
      const runner = makeReplayQueryRunner({
        provider: CLAUDE_PROVIDER,
        protocol: CLAUDE_AGENT_SDK_REPLAY_PROTOCOL,
        version: "test",
        scenario: "outbound-mismatch-wakes-stream",
        entries: [
          {
            type: "expect_outbound",
            frame: {
              type: "query.open",
              options,
            },
          },
          {
            type: "expect_outbound",
            frame: {
              type: "prompt.offer",
              message: expectedMessage,
            },
          },
        ],
      });
      const session = runner.open({
        options,
        threadId: ThreadId.make("thread-replay-mismatch"),
        providerSessionId: ProviderSessionId.make("provider-session-replay-mismatch"),
      });
      const streamFiber = yield* Stream.runDrain(session.messages).pipe(
        Effect.exit,
        Effect.forkChild,
      );

      yield* Effect.yieldNow;
      const offerExit = yield* Effect.exit(session.offer(actualMessage));
      assert.isTrue(Exit.isFailure(offerExit));

      yield* Effect.yieldNow;
      assert.isDefined(
        streamFiber.pollUnsafe(),
        "expected the replay stream to finish after the mismatch",
      );
    }),
  );

  it.effect("interrupts a replay stream waiting on its next outbound frame", () =>
    Effect.gen(function* () {
      const options = {
        model: "claude-sonnet-4-6",
        tools: [],
        permissionMode: "default",
        sessionId: "session-replay-outbound-interrupt",
      } satisfies ClaudeAgentSdkQueryOptions;
      const runner = makeReplayQueryRunner({
        provider: CLAUDE_PROVIDER,
        protocol: CLAUDE_AGENT_SDK_REPLAY_PROTOCOL,
        version: "test",
        scenario: "outbound-wait-interruption",
        entries: [
          {
            type: "expect_outbound",
            frame: {
              type: "query.open",
              options,
            },
          },
          {
            type: "expect_outbound",
            frame: {
              type: "prompt.offer",
              message: makeClaudeUserMessage({ text: "next prompt" }),
            },
          },
        ],
      });
      const session = runner.open({
        options,
        threadId: ThreadId.make("thread-replay-outbound-interrupt"),
        providerSessionId: ProviderSessionId.make("provider-session-replay-outbound-interrupt"),
      });
      const streamFiber = yield* Stream.runDrain(session.messages).pipe(Effect.forkChild);

      yield* yieldToReplayStream;
      assert.isUndefined(streamFiber.pollUnsafe());

      yield* Fiber.interrupt(streamFiber);

      const incomplete = assert.throws(() => runner.assertComplete());
      assert.isTrue(isClaudeReplayIncompleteError(incomplete));
      if (isClaudeReplayIncompleteError(incomplete)) {
        assert.equal(incomplete.cursor, 1);
        assert.equal(incomplete.remaining, 1);
      }
    }),
  );

  it.effect("aborts a pending permission callback when replay fails", () =>
    Effect.gen(function* () {
      const stableOptions = {
        model: "claude-sonnet-4-6",
        tools: [],
        permissionMode: "default",
        sessionId: "session-replay-permission-abort",
      } satisfies ClaudeAgentSdkQueryOptions;
      let callbackSignal: AbortSignal | undefined;
      let notifyCallbackStarted = () => {};
      const callbackStarted = new Promise<void>((resolve) => {
        notifyCallbackStarted = resolve;
      });
      const canUseTool = vi.fn<NonNullable<ClaudeAgentSdkQueryOptions["canUseTool"]>>(
        async (_toolName, _input, options) => {
          callbackSignal = options.signal;
          notifyCallbackStarted();
          await new Promise<never>((_resolve, reject) => {
            const rejectOnAbort = () => reject(new Error("permission callback aborted"));
            options.signal.addEventListener("abort", rejectOnAbort, { once: true });
            if (options.signal.aborted) {
              rejectOnAbort();
            }
          });
          return {
            behavior: "allow",
            updatedInput: _input,
            toolUseID: options.toolUseID,
          };
        },
      );
      const runner = makeReplayQueryRunner({
        provider: CLAUDE_PROVIDER,
        protocol: CLAUDE_AGENT_SDK_REPLAY_PROTOCOL,
        version: "test",
        scenario: "pending-permission-aborts-on-replay-failure",
        entries: [
          {
            type: "expect_outbound",
            frame: {
              type: "query.open",
              options: stableOptions,
            },
          },
          {
            type: "emit_inbound",
            frame: {
              type: "permission.request",
              toolName: "Read",
              input: { file_path: "/workspace/pending.ts" },
              options: { toolUseID: "tool-use-pending" },
            },
          },
          {
            type: "runtime_exit",
            status: "success",
          },
        ],
      });
      const session = runner.open({
        options: { ...stableOptions, canUseTool },
        threadId: ThreadId.make("thread-replay-permission-abort"),
        providerSessionId: ProviderSessionId.make("provider-session-replay-permission-abort"),
      });
      const streamFiber = yield* Stream.runDrain(session.messages).pipe(
        Effect.exit,
        Effect.forkChild,
      );

      yield* Effect.promise(() => callbackStarted);
      const offerExit = yield* Effect.exit(
        session.offer(makeClaudeUserMessage({ text: "unexpected prompt" })),
      );

      assert.isTrue(Exit.isFailure(offerExit));
      const streamExit = yield* Fiber.join(streamFiber);
      assert.isTrue(Exit.isFailure(streamExit));
      if (Exit.isFailure(streamExit)) {
        const error = Cause.squash(streamExit.cause);
        assert.isTrue(isClaudeAgentSdkQueryRunnerError(error));
        if (isClaudeAgentSdkQueryRunnerError(error)) {
          assert.isTrue(isClaudeReplayUnexpectedOutboundError(error.cause));
        }
      }
      assert.equal(canUseTool.mock.calls.length, 1);
      assert.isTrue(callbackSignal?.aborted);
    }),
  );

  it.effect("keeps permission callbacks scoped to the query that opened the stream", () =>
    Effect.gen(function* () {
      const firstCanUseTool = vi.fn<NonNullable<ClaudeAgentSdkQueryOptions["canUseTool"]>>(
        async (_toolName, _input, options) => ({
          behavior: "allow",
          updatedInput: { query: "first" },
          toolUseID: options.toolUseID,
          decisionClassification: "user_temporary",
        }),
      );
      const secondCanUseTool = vi.fn<NonNullable<ClaudeAgentSdkQueryOptions["canUseTool"]>>(
        async (_toolName, _input, options) => ({
          behavior: "allow",
          updatedInput: { query: "second" },
          toolUseID: options.toolUseID,
          decisionClassification: "user_temporary",
        }),
      );
      const firstStableOptions = {
        model: "claude-sonnet-4-6",
        tools: [],
        permissionMode: "default",
        sessionId: "session-replay-permission-first",
      } satisfies ClaudeAgentSdkQueryOptions;
      const secondStableOptions = {
        model: "claude-sonnet-4-6",
        tools: [],
        permissionMode: "default",
        sessionId: "session-replay-permission-second",
      } satisfies ClaudeAgentSdkQueryOptions;
      const runner = makeReplayQueryRunner({
        provider: CLAUDE_PROVIDER,
        protocol: CLAUDE_AGENT_SDK_REPLAY_PROTOCOL,
        version: "test",
        scenario: "permission-callbacks-are-query-scoped",
        entries: [
          {
            type: "expect_outbound",
            frame: {
              type: "query.open",
              options: firstStableOptions,
            },
          },
          {
            type: "expect_outbound",
            frame: {
              type: "query.open",
              options: secondStableOptions,
            },
          },
          {
            type: "emit_inbound",
            frame: {
              type: "permission.request",
              toolName: "Read",
              input: { file_path: "/workspace/first.ts" },
              options: {
                toolUseID: "tool-use-first",
              },
            },
          },
          {
            type: "expect_outbound",
            frame: {
              type: "permission.response",
              result: {
                behavior: "allow",
                updatedInput: { query: "first" },
                toolUseID: "tool-use-first",
                decisionClassification: "user_temporary",
              },
            },
          },
          {
            type: "runtime_exit",
            status: "success",
          },
          {
            type: "runtime_exit",
            status: "success",
          },
        ],
      });
      const firstSession = runner.open({
        options: {
          ...firstStableOptions,
          canUseTool: firstCanUseTool,
        },
        threadId: ThreadId.make("thread-replay-permission-first"),
        providerSessionId: ProviderSessionId.make("provider-session-replay-permission-first"),
      });
      const secondSession = runner.open({
        options: {
          ...secondStableOptions,
          canUseTool: secondCanUseTool,
        },
        threadId: ThreadId.make("thread-replay-permission-second"),
        providerSessionId: ProviderSessionId.make("provider-session-replay-permission-second"),
      });

      yield* Stream.runDrain(firstSession.messages);
      yield* Stream.runDrain(secondSession.messages);
      runner.assertComplete();

      assert.equal(firstCanUseTool.mock.calls.length, 1);
      assert.equal(secondCanUseTool.mock.calls.length, 0);
    }),
  );

  it.effect("fails a replay stream when the recorded runtime was cancelled", () =>
    Effect.gen(function* () {
      const options = {
        model: "claude-sonnet-4-6",
        tools: [],
        permissionMode: "default",
        sessionId: "session-replay-cancelled",
      } satisfies ClaudeAgentSdkQueryOptions;
      const runner = makeReplayQueryRunner({
        provider: CLAUDE_PROVIDER,
        protocol: CLAUDE_AGENT_SDK_REPLAY_PROTOCOL,
        version: "test",
        scenario: "cancelled-runtime-is-not-success",
        entries: [
          {
            type: "expect_outbound",
            frame: {
              type: "query.open",
              options,
            },
          },
          {
            type: "runtime_exit",
            status: "cancelled",
          },
        ],
      });
      const session = runner.open({
        options,
        threadId: ThreadId.make("thread-replay-cancelled"),
        providerSessionId: ProviderSessionId.make("provider-session-replay-cancelled"),
      });

      const exit = yield* Effect.exit(Stream.runDrain(session.messages));

      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause);
        assert.isTrue(isClaudeAgentSdkQueryRunnerError(error));
        if (isClaudeAgentSdkQueryRunnerError(error)) {
          assert.isTrue(isClaudeReplayRuntimeExitError(error.cause));
          if (isClaudeReplayRuntimeExitError(error.cause)) {
            assert.equal(error.cause.status, "cancelled");
          }
        }
      }
    }),
  );

  it.effect("closes an interrupted recording and emits runtime_exit when no tool use arrives", () =>
    Effect.gen(function* () {
      claudeSdkMock.reset();
      const entries: Array<ProviderReplayEntry> = [];

      const recordingExit = yield* Effect.exit(
        Effect.tryPromise(() =>
          recordInterruptedClaudeQuery({
            scenario: "interrupt-without-tool-use",
            prompt: "use a tool",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-sonnet-4-6",
            },
            cwd: "/workspace",
            sessionId: "session-interrupt-without-tool-use",
            resume: false,
            entries,
            queryOpenLabel: "query.open",
            promptOfferLabel: "prompt.offer",
            interruptLabel: "query.interrupt",
            interruptAfter: "tool_use",
          }),
        ),
      );
      assert.isTrue(Exit.isFailure(recordingExit));

      assert.equal(claudeSdkMock.close.mock.calls.length, 1);
      assert.deepInclude(entries.at(-1), {
        type: "runtime_exit",
        status: "error",
      });

      const prompt = claudeSdkMock.getPrompt();
      assert.isDefined(prompt);
      const promptIterator = prompt[Symbol.asyncIterator]();
      assert.isFalse((yield* Effect.promise(() => promptIterator.next())).done);
      assert.isTrue((yield* Effect.promise(() => promptIterator.next())).done);
    }),
  );

  it("finalizes a resumed recording as soon as its terminal result arrives", async () => {
    const next = vi.fn().mockResolvedValue({
      done: false,
      value: {
        type: "result",
        subtype: "success",
      },
    });
    const finalize = vi.fn();
    const entries: Array<ProviderReplayEntry> = [];

    const completed = await recordMessagesUntilTurnResultAndFinalize({
      iterator: { next },
      entries,
      scenario: "resume-at-cursor-terminal",
      finalize,
    });

    assert.isTrue(completed);
    assert.equal(next.mock.calls.length, 1);
    assert.equal(finalize.mock.calls.length, 1);
    const terminalEntry = entries.at(-1);
    assert.equal(terminalEntry?.type, "emit_inbound");
    if (terminalEntry?.type === "emit_inbound") {
      assert.equal(terminalEntry.label, "result");
    }
  });
});
