import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { ProviderInstanceId } from "@lathe/contracts";
import { createModelSelection } from "@lathe/shared/model";

import type { ProviderInstance } from "@lathe/provider-core/server/driver";
import * as ProviderInstallationGate from "../provider/ProviderInstallationGate.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";
import * as TextGenerators from "./TextGenerators.ts";

const makeStubTextGeneration = (
  overrides: Partial<TextGeneration.TextGeneration["Service"]>,
): TextGeneration.TextGeneration["Service"] =>
  TextGeneration.TextGeneration.of({
    generateCommitMessage: () =>
      Effect.die("generateCommitMessage stub not configured for this test"),
    generatePrContent: () => Effect.die("generatePrContent stub not configured for this test"),
    generateBranchName: () => Effect.die("generateBranchName stub not configured for this test"),
    generateThreadTitle: () => Effect.die("generateThreadTitle stub not configured for this test"),
    generateReviewGuide: () => Effect.die("generateReviewGuide stub not configured for this test"),
    generateStructured: () => Effect.die("generateStructured stub not configured for this test"),
    generateTranscriptionPostProcessing: () =>
      Effect.die("generateTranscriptionPostProcessing stub not configured for this test"),
    ...overrides,
  });

const makeStubInstance = (
  instanceId: ProviderInstanceId,
  textGeneration: TextGeneration.TextGeneration["Service"],
): ProviderInstance =>
  ({
    instanceId,
    driverKind: instanceId as unknown as ProviderInstance["driverKind"],
    continuationIdentity: {
      driverKind: instanceId as unknown as ProviderInstance["driverKind"],
      continuationKey: `${instanceId}:test`,
    },
    displayName: undefined,
    enabled: true,
    snapshot: {
      getSnapshot: Effect.succeed({ instanceId }),
    } as unknown as ProviderInstance["snapshot"],
    orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
    textGeneration,
  }) satisfies ProviderInstance;

const makeStubRegistry = (
  instances: ReadonlyArray<ProviderInstance>,
): ProviderInstanceRegistry.ProviderInstanceRegistry["Service"] => {
  const byId = new Map(instances.map((instance) => [instance.instanceId, instance] as const));
  return {
    getInstance: (id) => Effect.succeed(byId.get(id)),
    listInstances: Effect.succeed(instances),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
      PubSub.subscribe(pubsub),
    ),
  };
};

describe("TextGeneration.make structured generation", () => {
  it.effect("routes structured generation to the selected instance", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("claude_cheap");
      const prompts: Array<string> = [];
      const Answer = Schema.Struct({ answer: Schema.String });
      const instance = makeStubInstance(
        instanceId,
        makeStubTextGeneration({
          generateStructured: (input) => {
            prompts.push(input.prompt);
            return Effect.succeed({ answer: "yes" } as typeof input.outputSchema.Type);
          },
        }),
      );
      const tg = yield* TextGeneration.make.pipe(
        Effect.provideService(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          makeStubRegistry([instance]),
        ),
        Effect.provide(
          Layer.mergeAll(
            ServerSettings.layerTest(),
            Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
              resolveLink: () => Effect.die("No link lookup expected"),
            }),
            ProviderInstallationGate.layer,
            Layer.mock(TextGenerators.TextGenerators)({ runner: () => Effect.undefined }),
          ),
        ),
      );

      const result = yield* tg.generateStructured({
        purpose: "roadmapSteward",
        cwd: process.cwd(),
        prompt: "Is it done?",
        outputSchema: Answer,
        modelSelection: createModelSelection(instanceId, "haiku"),
      });
      expect(result).toEqual({ answer: "yes" });
      expect(prompts).toEqual(["Is it done?"]);

      const missing = yield* tg
        .generateStructured({
          purpose: "roadmapSteward",
          cwd: process.cwd(),
          prompt: "Is it done?",
          outputSchema: Answer,
          modelSelection: createModelSelection(ProviderInstanceId.make("gone"), "haiku"),
        })
        .pipe(Effect.flip);
      expect(missing.operation).toBe("generateStructured");
    }),
  );
});
