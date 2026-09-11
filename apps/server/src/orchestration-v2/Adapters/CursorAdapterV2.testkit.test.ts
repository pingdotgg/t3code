import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";

import { buildRuntimeInstructions } from "../../provider/RuntimeInstructions.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "../testkit/ReplayTranscriptNdjson.ts";
import {
  CURSOR_AGENT_SDK_PROTOCOL,
  CURSOR_PROVIDER,
  CursorAgentSdkRunnerError,
} from "./CursorAgentSdk.ts";
import {
  CursorReplayFrameMismatchError,
  CursorOrchestratorReplayHarness,
  makeCursorAgentSdkReplayRunner,
} from "./CursorAdapterV2.testkit.ts";

const isCursorAgentSdkRunnerError = Schema.is(CursorAgentSdkRunnerError);
const isCursorReplayFrameMismatchError = Schema.is(CursorReplayFrameMismatchError);

describe("CursorAdapterV2 replay testkit", () => {
  it.effect("wakes a paused run waiter when another operation mismatches", () =>
    Effect.gen(function* () {
      const agentId = "agent-paused-mismatch";
      const runId = "run-paused-mismatch";
      const runner = makeCursorAgentSdkReplayRunner({
        provider: CURSOR_PROVIDER,
        protocol: CURSOR_AGENT_SDK_PROTOCOL,
        version: "test",
        scenario: "paused-run-mismatch",
        entries: [
          {
            type: "expect_outbound",
            frame: { type: "agent.open", operation: "create", options: {} },
          },
          { type: "emit_inbound", frame: { type: "agent.opened", agentId } },
          { type: "expect_outbound", frame: { type: "run.start", message: "hello", options: {} } },
          { type: "emit_inbound", frame: { type: "run.started", runId, agentId } },
          { type: "expect_outbound", frame: { type: "run.cancel", runId } },
        ],
      });
      const session = yield* runner.open({
        operation: "create",
        options: {},
        threadId: ThreadId.make("thread-paused-mismatch"),
        providerSessionId: ProviderSessionId.make("provider-session-paused-mismatch"),
      });
      const run = yield* session.send({ message: "hello" });
      const waiter = yield* run.wait.pipe(Effect.forkChild({ startImmediately: true }));
      const closeError = yield* session.close.pipe(Effect.flip);
      const waitError = yield* Fiber.join(waiter).pipe(Effect.flip);
      assert.isTrue(isCursorAgentSdkRunnerError(closeError));
      assert.isTrue(isCursorAgentSdkRunnerError(waitError));
      if (!isCursorAgentSdkRunnerError(closeError) || !isCursorAgentSdkRunnerError(waitError)) {
        return;
      }
      assert.isTrue(isCursorReplayFrameMismatchError(closeError.cause));
      assert.isTrue(isCursorReplayFrameMismatchError(waitError.cause));
      if (
        !isCursorReplayFrameMismatchError(closeError.cause) ||
        !isCursorReplayFrameMismatchError(waitError.cause)
      ) {
        return;
      }
      assert.strictEqual(closeError.cause.cursor, 4);
      assert.deepEqual(closeError.cause.expected, { type: "run.cancel", runId });
      assert.deepEqual(closeError.cause.actual, { type: "agent.close", agentId });
      assert.strictEqual(closeError.cause, waitError.cause);
    }),
  );
  const runtimeInstructions = buildRuntimeInstructions({
    harness: "Cursor",
    model: "composer-2.5",
  });
  for (const [name, message] of [
    ["changed user text", `different prompt\n\n${runtimeInstructions}`],
    [
      "changed runtime context",
      `hello\n\n${buildRuntimeInstructions({ harness: "Cursor", model: "different-model" })}`,
    ],
  ] as const) {
    it.effect(`rejects ${name} after materializing runtime instructions`, () =>
      Effect.gen(function* () {
        const transcript = yield* CursorOrchestratorReplayHarness.decodeTranscript(
          materializeReplayTranscriptRuntimeInstructions(
            {
              provider: CURSOR_PROVIDER,
              protocol: CURSOR_AGENT_SDK_PROTOCOL,
              version: "test",
              scenario: "runtime-instructions-prompt-match",
              entries: [
                {
                  type: "expect_outbound",
                  frame: { type: "agent.open", operation: "create", options: {} },
                },
                {
                  type: "emit_inbound",
                  frame: { type: "agent.opened", agentId: "agent-runtime-instructions" },
                },
                {
                  type: "expect_outbound",
                  frame: { type: "run.start", message: "hello", options: {} },
                },
              ],
            },
            { driver: CURSOR_PROVIDER, model: "composer-2.5" },
          ),
        );
        const runner = makeCursorAgentSdkReplayRunner(transcript);
        const session = yield* runner.open({
          operation: "create",
          options: {},
          threadId: ThreadId.make("thread-runtime-instructions"),
          providerSessionId: ProviderSessionId.make("provider-session-runtime-instructions"),
        });
        const error = yield* session.send({ message }).pipe(Effect.flip);

        assert.isTrue(isCursorAgentSdkRunnerError(error));
        if (isCursorAgentSdkRunnerError(error)) {
          assert.isTrue(isCursorReplayFrameMismatchError(error.cause));
          if (isCursorReplayFrameMismatchError(error.cause)) {
            assert.equal(error.cause.cursor, 2);
            assert.deepEqual(error.cause.expected, {
              type: "run.start",
              message: `hello\n\n${runtimeInstructions}`,
              options: {},
            });
            assert.deepEqual(error.cause.actual, { type: "run.start", message, options: {} });
          }
        }
      }),
    );
  }

  it.effect("fails promptly when a run is followed by an unrelated outbound frame", () =>
    Effect.gen(function* () {
      const agentId = "agent-replay-outbound-mismatch";
      const runId = "run-replay-outbound-mismatch";
      const runner = makeCursorAgentSdkReplayRunner({
        provider: CURSOR_PROVIDER,
        protocol: CURSOR_AGENT_SDK_PROTOCOL,
        version: "test",
        scenario: "unrelated-outbound-after-run-started",
        entries: [
          {
            type: "expect_outbound",
            frame: {
              type: "agent.open",
              operation: "create",
              options: {},
            },
          },
          {
            type: "emit_inbound",
            frame: {
              type: "agent.opened",
              agentId,
            },
          },
          {
            type: "expect_outbound",
            frame: {
              type: "run.start",
              message: "hello",
              options: {},
            },
          },
          {
            type: "emit_inbound",
            frame: {
              type: "run.started",
              runId,
              agentId,
            },
          },
          {
            type: "expect_outbound",
            frame: {
              type: "agent.close",
              agentId,
            },
          },
        ],
      });
      const session = yield* runner.open({
        operation: "create",
        options: {},
        threadId: ThreadId.make("thread-replay-outbound-mismatch"),
        providerSessionId: ProviderSessionId.make("provider-session-replay-outbound-mismatch"),
      });
      const run = yield* session.send({ message: "hello" });

      const exit = yield* Effect.exit(run.wait.pipe(Effect.timeout("100 millis")));

      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause);
        assert.isTrue(isCursorAgentSdkRunnerError(error));
        if (isCursorAgentSdkRunnerError(error)) {
          assert.isTrue(isCursorReplayFrameMismatchError(error.cause));
          if (isCursorReplayFrameMismatchError(error.cause)) {
            assert.deepEqual(error.cause.expected, {
              type: "run.cancel",
              runId,
            });
            assert.deepEqual(error.cause.actual, {
              type: "agent.close",
              agentId,
            });
          }
        }
      }
    }),
  );
});
