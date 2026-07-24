import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type ProviderReplayEntry,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";

import {
  CLAUDE_PROVIDER,
  makeClaudeUserMessage,
  type ClaudeAgentSdkQueryOptions,
} from "./ClaudeAdapterV2.ts";
import {
  CLAUDE_AGENT_SDK_REPLAY_PROTOCOL,
  makeReplayQueryRunner,
  recordInterruptedClaudeQuery,
} from "./ClaudeAdapterV2.testkit.ts";

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

describe("ClaudeAdapterV2 replay testkit", () => {
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
});
