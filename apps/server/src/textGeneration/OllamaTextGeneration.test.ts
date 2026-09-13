import { describe, expect, it } from "@effect/vitest";
import { OllamaSettings, ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";

import { makeOllamaTextGeneration } from "./OllamaTextGeneration.ts";

const settings = Schema.decodeSync(OllamaSettings)({
  enabled: true,
  host: "http://ollama.test",
  defaultModel: "llama3.2",
});
const modelSelection = {
  instanceId: ProviderInstanceId.make("ollama-test"),
  model: "llama3.2",
};
const ollamaResponse = (content: string) =>
  new Response(JSON.stringify({ message: { content } }), { status: 200 });

describe("Ollama text generation", () => {
  it.effect("rejects output that does not match the operation schema", () =>
    Effect.gen(function* () {
      const textGeneration = makeOllamaTextGeneration(settings, {}, async () =>
        ollamaResponse('{"unexpected":"value"}'),
      );

      const error = yield* textGeneration
        .generateBranchName({
          cwd: "/tmp",
          message: "add Ollama support",
          modelSelection,
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(TextGenerationError);
      expect(error.detail).toBe("Ollama returned invalid structured output.");
    }),
  );

  it.effect("forwards branch naming policy to the prompt", () =>
    Effect.gen(function* () {
      let prompt = "";
      const textGeneration = makeOllamaTextGeneration(settings, {}, async (input, init) => {
        const body = (await new Request(String(input), init).json()) as {
          messages?: Array<{ content?: string }>;
        };
        prompt = body.messages?.[0]?.content ?? "";
        return ollamaResponse('{"branch":"provider-ollama"}');
      });

      const result = yield* textGeneration.generateBranchName({
        cwd: "/tmp",
        message: "add Ollama support",
        policy: {
          kind: "custom",
          branchInstructions: "Use the provider prefix.",
          inferRepositoryConventions: false,
        },
        modelSelection,
      });

      expect(result).toEqual({ branch: "provider-ollama" });
      expect(prompt).toContain("Use the provider prefix.");
    }),
  );

  it.effect("times out and aborts an unresponsive request", () =>
    Effect.gen(function* () {
      let requestSignal: AbortSignal | undefined;
      const textGeneration = makeOllamaTextGeneration(settings, {}, async (_input, init) => {
        requestSignal = init?.signal as AbortSignal;
        return new Promise<Response>(() => undefined);
      });
      const request = yield* textGeneration
        .generateThreadTitle({
          cwd: "/tmp",
          message: "add Ollama support",
          modelSelection,
        })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(180_000);

      const error = yield* Fiber.join(request);
      expect(error).toBeInstanceOf(TextGenerationError);
      expect(error.detail).toContain("timed out");
      expect(requestSignal?.aborted).toBe(true);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
