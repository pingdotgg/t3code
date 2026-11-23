import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as SpeechPostProcessing from "./postProcessing.ts";

const textGenerationSelection = {
  instanceId: ProviderInstanceId.make("fakeapi"),
  model: "fake-model",
};
const acpSelection = { instanceId: ProviderInstanceId.make("acp_local"), model: "default" };

it.effect("cleanup pinned to a provider that cannot generate text uses the text model", () =>
  Effect.gen(function* () {
    const used = yield* Ref.make<ModelSelection | null>(null);
    const layer = SpeechPostProcessing.layer.pipe(
      Layer.provide(
        Layer.succeed(TextGeneration.TextGeneration, {
          generateTranscriptionPostProcessing: (input: { modelSelection: ModelSelection }) =>
            Ref.set(used, input.modelSelection).pipe(Effect.as({ transcription: "Hello, world." })),
        } as unknown as TextGeneration.TextGeneration["Service"]),
      ),
      Layer.provide(
        Layer.succeed(ProviderRegistry.ProviderRegistry, {
          getProviders: Effect.succeed([
            {
              instanceId: acpSelection.instanceId,
              driver: "acpRegistry",
              enabled: true,
              installed: true,
              supportsTextGeneration: false,
            },
          ]),
        } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
      ),
      Layer.provide(
        ServerSettings.layerTest({
          providerInstances: {
            [acpSelection.instanceId]: {
              driver: "acpRegistry",
              enabled: true,
              config: { source: "local", commandPath: "acp-agent" },
            },
          },
          textGenerators: {
            [textGenerationSelection.instanceId]: {
              kind: "openaiCompatible",
              baseUrl: "http://127.0.0.1:18999/v1",
              enabled: true,
            },
          },
          textGenerationModelSelection: textGenerationSelection,
          speechPostProcessingModelSelection: acpSelection,
        }),
      ),
      Layer.provide(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const postProcessing = yield* SpeechPostProcessing.SpeechPostProcessing;
      yield* postProcessing.process({
        options: {
          speechCustomWords: [],
          speechPostProcessingPrompt: { mode: "default", customInstructions: "" },
        },
        transcript: "um hello world",
        draft: { text: "", selection: { start: 0, end: 0 } },
      } as never);
    }).pipe(Effect.provide(layer));
    const selection = yield* Ref.get(used);
    assert.deepStrictEqual(
      { instanceId: selection?.instanceId, model: selection?.model },
      textGenerationSelection,
    );
  }),
);

it.effect("synthesizes full cleaned markdown and summarizes long replies in summary mode", () =>
  Effect.gen(function* () {
    const synthesized = yield* Ref.make<string[]>([]);
    const fakeWav = new Uint8Array([82, 73, 70, 70]);
    const layer = Layer.effect(
      SpeechPostProcessing.SpeechPostProcessing,
      SpeechPostProcessing.make((text) =>
        Ref.update(synthesized, (previous) => [...previous, text]).pipe(Effect.as(fakeWav)),
      ),
    ).pipe(
      Layer.provide(
        Layer.succeed(TextGeneration.TextGeneration, {
          generateTranscriptionPostProcessing: () =>
            Effect.succeed({ transcription: "Short spoken summary." }),
        } as unknown as TextGeneration.TextGeneration["Service"]),
      ),
      Layer.provide(
        Layer.succeed(ProviderRegistry.ProviderRegistry, {
          getProviders: Effect.succeed([]),
        } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
      ),
      Layer.provide(
        ServerSettings.layerTest({
          textGenerationModelSelection: textGenerationSelection,
        }),
      ),
      Layer.provide(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const postProcessing = yield* SpeechPostProcessing.SpeechPostProcessing;
      const fullResult = yield* postProcessing.synthesize({
        text: "### Heading\nHere is [a link](https://example.com) and:\n```ts\nconst x = 1;\n```",
        mode: "full",
      });
      assert.deepStrictEqual(fullResult, fakeWav);
      const longReply = `${"This is a detailed explanation of the architectural change. ".repeat(8)}\n\`\`\`ts\nexport const value = 42;\n\`\`\``;
      const summaryResult = yield* postProcessing.synthesize({
        text: longReply,
        mode: "summary",
      });
      assert.deepStrictEqual(summaryResult, fakeWav);
    }).pipe(Effect.provide(layer));
    const calls = yield* Ref.get(synthesized);
    assert.deepStrictEqual(calls, [
      "Heading Here is a link and: Code block omitted.",
      "Short spoken summary.",
    ]);
  }),
);
