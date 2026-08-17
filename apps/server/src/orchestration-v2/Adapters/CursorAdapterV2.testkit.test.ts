import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  CURSOR_AGENT_SDK_PROTOCOL,
  CURSOR_PROVIDER,
  CursorAgentSdkRunnerError,
} from "./CursorAgentSdk.ts";
import {
  CursorReplayFrameMismatchError,
  makeCursorAgentSdkReplayRunner,
} from "./CursorAdapterV2.testkit.ts";

const isCursorAgentSdkRunnerError = Schema.is(CursorAgentSdkRunnerError);
const isCursorReplayFrameMismatchError = Schema.is(CursorReplayFrameMismatchError);

describe("CursorAdapterV2 replay testkit", () => {
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
