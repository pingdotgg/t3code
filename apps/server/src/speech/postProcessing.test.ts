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
