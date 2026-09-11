import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";

const makeStubTextGeneration = (
  overrides: Partial<TextGeneration.TextGeneration["Service"]>,
): TextGeneration.TextGeneration["Service"] =>
  TextGeneration.TextGeneration.of({
    generateCommitMessage: () =>
      Effect.die("generateCommitMessage stub not configured for this test"),
    generatePrContent: () => Effect.die("generatePrContent stub not configured for this test"),
    generateBranchName: () => Effect.die("generateBranchName stub not configured for this test"),
    generateThreadTitle: () => Effect.die("generateThreadTitle stub not configured for this test"),
    generateHandover: () => Effect.die("generateHandover stub not configured for this test"),
    ...overrides,
  });

const makeStubInstance = (
  instanceId: ProviderInstanceId,
  textGeneration: TextGeneration.TextGeneration["Service"],
  driverKind: ProviderInstance["driverKind"] = instanceId as unknown as ProviderInstance["driverKind"],
): ProviderInstance =>
  ({
    instanceId,
    driverKind,
    continuationIdentity: {
      driverKind,
      continuationKey: `${instanceId}:test`,
    },
    displayName: undefined,
    enabled: true,
    snapshot: {} as ProviderInstance["snapshot"],
    adapter: {} as ProviderInstance["adapter"],
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
    // Tests never drive changes through this stub; acquire a throwaway
    // subscription on an unused PubSub so the shape is satisfied.
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
      PubSub.subscribe(pubsub),
    ),
  };
};

describe("makeTextGenerationFromRegistry", () => {
  it.effect("delegates to the matching instance's textGeneration closure", () =>
    Effect.gen(function* () {
      const personalId = ProviderInstanceId.make("codex_personal");
      const personalCalls: string[] = [];
      const personal = makeStubInstance(
        personalId,
        makeStubTextGeneration({
          generateBranchName: (input) => {
            personalCalls.push(input.message);
            return Effect.succeed({ branch: "personal-branch" });
          },
        }),
      );

      const workId = ProviderInstanceId.make("codex_work");
      const work = makeStubInstance(
        workId,
        makeStubTextGeneration({
          generateBranchName: () => Effect.succeed({ branch: "work-branch" }),
        }),
      );

      const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([personal, work]));

      const result = yield* tg.generateBranchName({
        cwd: process.cwd(),
        message: "Refactor the routing layer",
        modelSelection: createModelSelection(ProviderInstanceId.make("codex_personal"), "gpt-5"),
      });

      expect(result.branch).toBe("personal-branch");
      expect(personalCalls).toEqual(["Refactor the routing layer"]);
    }),
  );

  it.effect("delegates handover generation with its exact model selection", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex");
      const selections: Array<{ readonly model: string; readonly effort: unknown }> = [];
      const instance = makeStubInstance(
        instanceId,
        makeStubTextGeneration({
          generateHandover: (input) => {
            selections.push({
              model: input.modelSelection.model,
              effort: input.modelSelection.options?.find(
                (option) => option.id === "reasoningEffort",
              )?.value,
            });
            return Effect.succeed({ handover: "# Goal\n\nContinue the migration." });
          },
        }),
      );

      const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([instance]));
      const result = yield* tg.generateHandover({
        cwd: process.cwd(),
        threadContents: "User: Continue the migration",
        modelSelection: createModelSelection(instanceId, "gpt-5.6-luna", [
          { id: "reasoningEffort", value: "high" },
        ]),
      });

      expect(result.handover).toContain("Continue the migration");
      expect(selections).toEqual([{ model: "gpt-5.6-luna", effort: "high" }]);
    }),
  );

  it("finds an enabled Codex driver without assuming its instance id", () => {
    const renamedCodex = makeStubInstance(
      ProviderInstanceId.make("codex_work"),
      makeStubTextGeneration({}),
      ProviderDriverKind.make("codex"),
    );
    const disabledCodex = {
      ...renamedCodex,
      instanceId: ProviderInstanceId.make("codex_disabled"),
      enabled: false,
    };

    expect(
      TextGeneration.findAvailableCodexInstance([disabledCodex, renamedCodex])?.instanceId,
    ).toBe("codex_work");
  });

  it.effect("fails with TextGenerationError when the instance is unknown", () =>
    Effect.gen(function* () {
      const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([]));

      const result = yield* tg
        .generateBranchName({
          cwd: process.cwd(),
          message: "anything",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("missing_instance"),
            "gpt-5",
          ),
        })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("TextGenerationError");
        expect(result.failure.operation).toBe("generateBranchName");
        expect(result.failure.detail).toContain("missing_instance");
      }
    }),
  );
});
