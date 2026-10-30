import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as OpenCode2AdapterV2Testkit from "../orchestration-v2/Adapters/OpenCode2AdapterV2.testkit.ts";
import * as OpenCode2Server from "@t3tools/provider-opencode/server/v2/OpenCode2Server";
import * as OpenCode2TextGeneration from "@t3tools/provider-opencode/server/v2/textGeneration";
import { OPENCODE2_TITLE_GENERATION } from "./OpenCode2TextGeneration.fixture.ts";

const layer = TestProviderHost.layer().pipe(Layer.provideMerge(NodeServices.layer));

it.layer(layer)("OpenCode2TextGeneration", (it) => {
  it.effect("generates a title in a temporary session on the free tier and removes it", () =>
    Effect.gen(function* () {
      const server = yield* OpenCode2AdapterV2Testkit.replayServer({
        provider: "opencode",
        protocol: OpenCode2AdapterV2Testkit.OPENCODE2_HTTP_PROTOCOL,
        version: "2.0.18",
        scenario: "opencode2_title_generation",
        entries: [...OPENCODE2_TITLE_GENERATION, { type: "runtime_exit", status: "success" }],
      });
      const textGeneration = yield* OpenCode2TextGeneration.make().pipe(
        Effect.provideService(OpenCode2Server.OpenCode2Server, server),
      );
      const title = yield* textGeneration.generateThreadTitle({
        cwd: process.cwd(),
        message: "fix the login redirect loop after oauth",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "opencode/big-pickle",
        },
      });
      assert.equal(title.title, "Fix OAuth Login Redirect Loop");
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a provider's own error message out of the caller-visible detail", () =>
    Effect.gen(function* () {
      const [subscribe, connected, create, created] = OPENCODE2_TITLE_GENERATION;
      const sessionId = "ses_f0ec85cf6ffebfalpvV2E9nocu";
      const refusal = {
        type: "provider.auth",
        message:
          "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode",
        status: 403,
      };
      const server = yield* OpenCode2AdapterV2Testkit.replayServer({
        provider: "opencode",
        protocol: OpenCode2AdapterV2Testkit.OPENCODE2_HTTP_PROTOCOL,
        version: "2.0.18",
        scenario: "opencode2_title_generation_refused",
        entries: [
          subscribe!,
          connected!,
          create!,
          created!,
          {
            type: "expect_outbound",
            frame: { type: "session.prompt", input: { sessionID: sessionId, text: "<any>" } },
          },
          {
            type: "emit_inbound",
            frame: {
              type: "sdk.response",
              operation: "session.prompt",
              data: {
                data: {
                  id: "msg_1",
                  sessionID: sessionId,
                  time: { created: 1 },
                  type: "user",
                  payload: { text: "t" },
                  delivery: "steer",
                },
              },
            },
          },
          {
            type: "emit_inbound",
            frame: {
              type: "sdk.event",
              event: {
                id: "evt_0eb7f9ae0001VCNDHVLnqTfoPG",
                created: 1790657403616,
                type: "session.execution.failed",
                data: { sessionID: sessionId, error: refusal },
                durable: { aggregateID: sessionId, seq: 7, version: 1 },
              },
            },
          },
          {
            type: "expect_outbound",
            frame: { type: "session.remove", input: { sessionID: sessionId } },
          },
          {
            type: "emit_inbound",
            frame: { type: "sdk.response", operation: "session.remove", data: null },
          },
          { type: "runtime_exit", status: "success" },
        ],
      });
      const textGeneration = yield* OpenCode2TextGeneration.make().pipe(
        Effect.provideService(OpenCode2Server.OpenCode2Server, server),
      );
      const failure = yield* textGeneration
        .generateThreadTitle({
          cwd: process.cwd(),
          message: "fix the login redirect loop after oauth",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "opencode/big-pickle",
          },
        })
        .pipe(Effect.flip);
      assert.equal(failure.detail, "OpenCode could not generate the text.");
      assert.deepEqual(failure.cause, refusal);
    }).pipe(Effect.scoped),
  );

  it.effect("times out when the prompt request and its interrupt never answer", () =>
    Effect.gen(function* () {
      const [subscribe, connected, create, created] = OPENCODE2_TITLE_GENERATION;
      const sessionId = "ses_f0ec85cf6ffebfalpvV2E9nocu";
      const prompted = yield* Deferred.make<void>();
      const server = yield* OpenCode2AdapterV2Testkit.replayServer(
        {
          provider: "opencode",
          protocol: OpenCode2AdapterV2Testkit.OPENCODE2_HTTP_PROTOCOL,
          version: "2.0.18",
          scenario: "opencode2_title_generation_stalled",
          entries: [
            subscribe!,
            connected!,
            create!,
            created!,
            {
              type: "expect_outbound",
              frame: { type: "session.prompt", input: { sessionID: sessionId, text: "<any>" } },
            },
            {
              type: "emit_inbound",
              frame: { type: "sdk.response", operation: "session.prompt", data: "<hang>" },
            },
            {
              type: "expect_outbound",
              frame: { type: "session.interrupt", input: { sessionID: sessionId } },
            },
            {
              type: "emit_inbound",
              frame: { type: "sdk.response", operation: "session.interrupt", data: "<hang>" },
            },
            {
              type: "expect_outbound",
              frame: { type: "session.remove", input: { sessionID: sessionId } },
            },
            {
              type: "emit_inbound",
              frame: { type: "sdk.response", operation: "session.remove", data: null },
            },
            { type: "runtime_exit", status: "success" },
          ],
        },
        { onPrompt: () => Deferred.doneUnsafe(prompted, Effect.void) },
      );
      const textGeneration = yield* OpenCode2TextGeneration.make().pipe(
        Effect.provideService(OpenCode2Server.OpenCode2Server, server),
      );
      const generation = yield* textGeneration
        .generateThreadTitle({
          cwd: process.cwd(),
          message: "fix the login redirect loop after oauth",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "opencode/big-pickle",
          },
        })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Deferred.await(prompted);
      yield* TestClock.adjust("3 minutes");
      yield* TestClock.adjust("5 seconds");
      const failure = yield* Fiber.join(generation);
      assert.equal(failure.detail, "OpenCode did not finish generating in time.");
    }).pipe(Effect.scoped),
  );
});
