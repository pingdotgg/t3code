import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import { checkOllamaProviderStatus, probeOllama, ollamaApiUrl } from "./OllamaProvider.ts";
import { OllamaSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const settings = Schema.decodeSync(OllamaSettings)({ enabled: true, host: "http://ollama.test" });

describe("Ollama HTTP provider", () => {
  it("builds the API URL without double-appending /api", () => {
    expect(ollamaApiUrl("http://localhost:11434", "/tags")).toBe("http://localhost:11434/api/tags");
    expect(ollamaApiUrl("https://ollama.com/api", "/chat")).toBe("https://ollama.com/api/chat");
  });

  it("discovers models from a mocked /api/tags response", async () => {
    const calls: Request[] = [];
    const result = await Effect.runPromise(
      probeOllama(settings, {}, async (input, init) => {
        calls.push(new Request(String(input), init));
        return new Response(
          JSON.stringify({ models: [{ name: "llama3.2", details: { family: "llama" } }] }),
          { status: 200 },
        );
      }),
    );
    expect(calls[0]?.url).toBe("http://ollama.test/api/tags");
    expect(result.models.map((model) => model.slug)).toEqual(["llama3.2"]);
  });

  it.effect("does not leave a provider status probe pending when Ollama hangs", () =>
    Effect.gen(function* () {
      const probe = yield* checkOllamaProviderStatus(
        settings,
        {},
        () => new Promise<Response>(() => undefined),
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");

      const snapshot = yield* Fiber.join(probe);
      expect(snapshot).toMatchObject({
        status: "error",
        installed: false,
        message: "Ollama did not respond within 10 seconds.",
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
