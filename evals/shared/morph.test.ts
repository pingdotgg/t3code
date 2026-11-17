import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import { morphRunner } from "./morph.ts";

it.effect("times out when Morph response headers arrive but the body stalls", () =>
  Effect.gen(function* () {
    vi.stubEnv("MORPH_API_KEY", "eval-test-key");
    const reading = Promise.withResolvers<void>();
    const body = Promise.withResolvers<ArrayBuffer>();
    const response = new Response(null, { status: 200 });
    using _body = vi.spyOn(response, "arrayBuffer").mockImplementation(() => {
      reading.resolve();
      return body.promise;
    });
    using _fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const completed = new TextEncoder().encode(
      JSON.stringify({
        output: [{ type: "message", content: [{ text: '{"statements":[]}' }] }],
      }),
    ).buffer;
    try {
      const result = yield* morphRunner()({
        operation: "generateConversationSummary",
        cwd: "/project",
        modelSelection: { instanceId: ProviderInstanceId.make("morph"), model: "morph-test" },
        prompt: "Summarize the conversation.",
        outputSchema: Schema.Struct({ statements: Schema.Array(Schema.Unknown) }),
      }).pipe(Effect.exit, Effect.forkChild);
      yield* Effect.promise(() => reading.promise);
      yield* TestClock.adjust("121 seconds");
      body.resolve(completed);
      const exit = yield* Fiber.join(result);
      expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : exit).toMatchObject({
        _tag: "TimeoutError",
      });
    } finally {
      body.resolve(completed);
      vi.unstubAllEnvs();
    }
  }),
);
