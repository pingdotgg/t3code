import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as EffectAcpSchema from "effect-acp/compat";
import type { OrchestrationV2ProviderFailure } from "@t3tools/contracts";

import { watchAntigravityPromptOutcome } from "./AntigravityTurnOutcome.ts";

const USER_INPUT = 14;
const PLANNER_RESPONSE = 15;
const TOOL = 8;
const ERROR_MESSAGE = 17;

// Error-step payloads trimmed from Antigravity 1.4.5 against a local Gemini endpoint.
const errorPayload = (error: string) =>
  Buffer.concat([
    Buffer.from([0x0a, 0x24]),
    Buffer.from(
      `Agent execution terminated due to error.\u0012agent executor error: ${error}: ${error}\n(1) attached stack trace\n  -- stack trace:`,
    ),
  ]);
const QUOTA_ERROR = errorPayload(
  "Error 429, Message: Quota exhausted for test model., Status: RESOURCE_EXHAUSTED, Details: [map[@type:type.googleapis.com/google.rpc.ErrorInfo domain:googleapis.com metadata:map[quotaResetDelay:3600s] reason:QUOTA_EXHAUSTED]]",
);
const INVALID_ARGUMENT_ERROR = errorPayload(
  "Error 400, Message: Request contains an invalid argument., Status: INVALID_ARGUMENT, Details: []",
);
// Vertex Claude rejects a resumed history whose saved thinking block lost its signature.
const MISSING_SIGNATURE_ERROR = errorPayload(
  'Error 400, Message: {"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0.thinking.signature: Field required"},"request_id":"req_vrtx_test"}, Status: INVALID_ARGUMENT, Details: []',
);
const INVALID_SIGNATURE_ERROR = errorPayload(
  'Error 400, Message: {"type":"error","error":{"type":"invalid_request_error","message":"messages.3.content.0: Invalid `signature` in `thinking` block"}}, Status: INVALID_ARGUMENT, Details: []',
);
// The model's reply quoting the agent's quota notice is an ordinary planner response.
const QUOTED_NOTICE = Buffer.from(
  "Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset in 1 hour.",
);
const QUOTED_SIGNATURE_ERROR = Buffer.from(
  "The API said: messages.1.content.0.thinking.signature: Field required",
);
const reusable = (failure: OrchestrationV2ProviderFailure) =>
  ({ failure, threadDisposition: "reusable" }) as const;
const POISONED_HISTORY = {
  failure: {
    class: "provider_error",
    message:
      "Antigravity's saved conversation can no longer be sent to the model. The next message starts a fresh Antigravity session with this thread's context.",
    code: "INVALID_THINKING_SIGNATURE",
    retryable: true,
  },
  threadDisposition: "broken",
} as const;

describe("watchAntigravityPromptOutcome", () => {
  it.effect("fails only turns whose own steps end in an upstream error", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profileDirectory = yield* fs.makeTempDirectoryScoped();
      const sessionId = "e6aba774-5472-4277-b6ee-27b2e05570a7";
      const conversations = path.join(profileDirectory, "antigravity-acp", "conversations");
      yield* fs.makeDirectory(conversations, { recursive: true });
      let nextIndex = 0;
      const appendSteps = (steps: ReadonlyArray<readonly [number, Uint8Array]>) => {
        const database = new NodeSqlite.DatabaseSync(path.join(conversations, `${sessionId}.db`));
        try {
          database.exec(
            "CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)",
          );
          const insert = database.prepare("INSERT INTO steps VALUES (?, ?, ?)");
          for (const [type, payload] of steps) insert.run(nextIndex++, type, payload);
        } finally {
          database.close();
        }
      };
      const turn = (
        steps: ReadonlyArray<readonly [number, Uint8Array]>,
        result: EffectAcpSchema.PromptResponse = { stopReason: "end_turn" },
      ) =>
        Effect.gen(function* () {
          const check = yield* watchAntigravityPromptOutcome(profileDirectory, sessionId);
          appendSteps(steps);
          return yield* check(result);
        });
      const input = Buffer.from("Run the fixture.");
      const reply = Buffer.from("FIXTURE_OK");

      // The first prompt creates the session log.
      assert.isUndefined(
        yield* turn([
          [USER_INPUT, input],
          [PLANNER_RESPONSE, reply],
        ]),
      );
      assert.deepEqual(
        yield* turn([
          [USER_INPUT, input],
          [ERROR_MESSAGE, QUOTA_ERROR],
        ]),
        reusable({
          class: "usage_limit",
          message: "You have reached your Antigravity quota for this period.",
          code: "RESOURCE_EXHAUSTED",
          retryable: true,
          resetAt: "1970-01-01T01:00:00.000Z",
        }),
      );
      // The earlier error step is outside this turn.
      assert.isUndefined(
        yield* turn(
          [
            [USER_INPUT, input],
            [PLANNER_RESPONSE, QUOTED_NOTICE],
          ],
          {
            stopReason: "end_turn",
            usage: { inputTokens: 42, outputTokens: 3, totalTokens: 54 },
          },
        ),
      );
      assert.deepEqual(
        yield* turn([
          [USER_INPUT, input],
          [ERROR_MESSAGE, INVALID_ARGUMENT_ERROR],
        ]),
        reusable({
          class: "provider_error",
          message: "Request contains an invalid argument.",
          code: "INVALID_ARGUMENT",
          retryable: false,
        }),
      );
      // A saved thinking block without a valid signature fails every later prompt.
      assert.deepEqual(
        yield* turn([
          [USER_INPUT, input],
          [ERROR_MESSAGE, MISSING_SIGNATURE_ERROR],
        ]),
        POISONED_HISTORY,
      );
      assert.deepEqual(
        yield* turn([
          [USER_INPUT, input],
          [ERROR_MESSAGE, INVALID_SIGNATURE_ERROR],
        ]),
        POISONED_HISTORY,
      );
      // Reply text is never evidence, even when it quotes the error.
      assert.isUndefined(
        yield* turn([
          [USER_INPUT, input],
          [PLANNER_RESPONSE, QUOTED_SIGNATURE_ERROR],
        ]),
      );
      // A completed tool keeps its usage, and the turn still fails.
      assert.equal(
        (yield* turn(
          [
            [USER_INPUT, input],
            [PLANNER_RESPONSE, reply],
            [TOOL, reply],
            [ERROR_MESSAGE, QUOTA_ERROR],
          ],
          {
            stopReason: "end_turn",
            usage: { inputTokens: 40, outputTokens: 5, totalTokens: 45 },
          },
        ))?.failure.class,
        "usage_limit",
      );
      assert.isUndefined(
        yield* turn([
          [USER_INPUT, input],
          [PLANNER_RESPONSE, reply],
        ]),
      );
      // The agent maps the SDK's QUOTA_EXHAUSTED stop reason to `refusal`.
      assert.deepEqual(
        yield* turn([], { stopReason: "refusal" }),
        reusable({
          class: "usage_limit",
          message: "You have reached your Antigravity quota for this period.",
          code: "QUOTA_EXHAUSTED",
          retryable: true,
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reads only this session's own unlinked log, and keeps a typed refusal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profileDirectory = yield* fs.makeTempDirectoryScoped();
      const conversations = path.join(profileDirectory, "antigravity-acp", "conversations");
      yield* fs.makeDirectory(conversations, { recursive: true });
      const own = "e6aba774-5472-4277-b6ee-27b2e05570a7";
      const peer = "0d9c2b4e-1111-4222-8333-944455556666";
      const append = (sessionId: string, type: number, payload: Uint8Array) => {
        const database = new NodeSqlite.DatabaseSync(path.join(conversations, `${sessionId}.db`));
        try {
          database.exec(
            "CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)",
          );
          database
            .prepare("INSERT INTO steps (step_type, step_payload) VALUES (?, ?)")
            .run(type, payload);
        } finally {
          database.close();
        }
      };

      // own.db links to a peer session; the peer's new error step is not this turn's.
      append(peer, USER_INPUT, Buffer.from("peer"));
      yield* fs.symlink(
        path.join(conversations, `${peer}.db`),
        path.join(conversations, `${own}.db`),
      );
      const linked = yield* watchAntigravityPromptOutcome(profileDirectory, own);
      append(peer, ERROR_MESSAGE, QUOTA_ERROR);
      assert.isUndefined(yield* linked({ stopReason: "end_turn" }));
      assert.equal((yield* linked({ stopReason: "refusal" }))?.failure.class, "usage_limit");

      // An unreadable log gives no evidence, but the agent's typed refusal still fails the turn.
      yield* fs.remove(path.join(conversations, `${own}.db`));
      yield* fs.writeFileString(path.join(conversations, `${own}.db`), "not a database");
      const corrupt = yield* watchAntigravityPromptOutcome(profileDirectory, own);
      assert.isUndefined(yield* corrupt({ stopReason: "end_turn" }));
      assert.deepEqual(
        yield* corrupt({ stopReason: "refusal" }),
        reusable({
          class: "usage_limit",
          message: "You have reached your Antigravity quota for this period.",
          code: "QUOTA_EXHAUSTED",
          retryable: true,
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
