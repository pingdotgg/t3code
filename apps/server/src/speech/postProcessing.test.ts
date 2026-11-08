import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { DEFAULT_SPEECH_POST_PROCESSING_PROMPT } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, vi } from "vite-plus/test";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as SpeechCleanupApi from "./SpeechCleanupApi.ts";
import * as PostProcessing from "./postProcessing.ts";

it.effect.each(["agent", "openai", "compatible", "anthropic", "openrouter"] as const)(
  "routes %s cleanup once, preserving the shared prompt and alias correction",
  (provider) =>
    Effect.gen(function* () {
      const api = vi.fn((_prompt: string) => Effect.succeed("hello Acme corp"));
      const agent = vi.fn(() => Effect.succeed({ transcription: "hello Acme corp" }));
      const service = yield* PostProcessing.SpeechPostProcessing.pipe(
        Effect.provide(
          PostProcessing.layer.pipe(
            Layer.provide(NodeServices.layer),
            Layer.provide(ServerSettings.layerTest({ speechPostProcessingProvider: provider })),
            Layer.provide(Layer.mock(SpeechCleanupApi.SpeechCleanupApi)({ postProcess: api })),
            Layer.provide(
              Layer.mock(TextGeneration.TextGeneration)({
                generateTranscriptionPostProcessing: agent,
              }),
            ),
          ),
        ),
      );
      const input = {
        transcript: "hello Acme corp",
        draft: { text: "Deployment", selection: { start: 10, end: 10 } },
        options: {
          speechPostProcessingPrompt: { mode: "default" as const, customInstructions: "" },
          speechCustomWords: [{ term: "AcmeCorp", aliases: ["Acme corp"] }],
        },
      };
      expect(yield* service.process(input)).toEqual({ text: "hello AcmeCorp" });
      expect(api).toHaveBeenCalledTimes(provider !== "agent" ? 1 : 0);
      expect(agent).toHaveBeenCalledTimes(provider === "agent" ? 1 : 0);
      if (provider !== "agent") {
        expect(api.mock.calls[0]?.[0]).toContain(DEFAULT_SPEECH_POST_PROCESSING_PROMPT);
        expect(api.mock.calls[0]?.[0]).toContain("Deployment");
      }
      expect(yield* service.process({ ...input, transcript: " " })).toEqual({ text: " " });
      expect(api.mock.calls.length + agent.mock.calls.length).toBe(1);
    }),
);
