import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { ProviderInstanceId } from "@t3tools/contracts";
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
    generateWorkItemTask: () =>
      Effect.die("generateWorkItemTask stub not configured for this test"),
    findWorkItemMatches: () => Effect.die("findWorkItemMatches stub not configured for this test"),
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

  it.effect("routes work item matching through the selected instance", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex_work");
      const textGeneration = makeStubTextGeneration({
        findWorkItemMatches: () =>
          Effect.succeed({
            matches: [{ candidate: 1, confidence: "high", reason: "Same work." }],
          }),
      });
      const tg = TextGeneration.makeTextGenerationFromRegistry(
        makeStubRegistry([makeStubInstance(instanceId, textGeneration)]),
      );
      const source = {
        kind: "issue" as const,
        provider: "github",
        repository: "acme/app",
        number: 12,
        title: "Fix sessions",
        url: "https://github.com/acme/app/issues/12",
        body: "Sessions expire early.",
      };

      const matches = yield* tg.findWorkItemMatches({
        cwd: process.cwd(),
        relationship: "duplicate",
        source,
        candidates: [source],
        modelSelection: createModelSelection(instanceId, "gpt-5"),
      });

      expect(matches.matches[0]?.candidate).toBe(1);
    }),
  );

  it.effect("preserves the complete selected model for work item task generation", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex_work");
      const selection = createModelSelection(instanceId, "gpt-5.4", [
        { id: "reasoningEffort", value: "xhigh" },
        { id: "serviceTier", value: "priority" },
      ]);
      let received: typeof selection | undefined;
      const textGeneration = makeStubTextGeneration({
        generateWorkItemTask: (input) => {
          received = input.modelSelection;
          return Effect.succeed({ prompt: "Draft" });
        },
      });
      const tg = TextGeneration.makeTextGenerationFromRegistry(
        makeStubRegistry([makeStubInstance(instanceId, textGeneration)]),
      );

      yield* tg.generateWorkItemTask({
        cwd: process.cwd(),
        mode: "compound",
        items: [
          {
            kind: "issue",
            provider: "github",
            repository: "acme/app",
            number: 12,
            title: "Fix sessions",
            url: "https://github.com/acme/app/issues/12",
            body: "Sessions expire early.",
          },
        ],
        modelSelection: selection,
      });

      expect(received).toEqual(selection);
    }),
  );
});
