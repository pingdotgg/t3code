import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
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
    generateAutoReviewFindings: () =>
      Effect.die("generateAutoReviewFindings stub not configured for this test"),
    ...overrides,
  });

const makeStubInstance = (
  instanceId: ProviderInstanceId,
  textGeneration: TextGeneration.TextGeneration["Service"],
  enabled = true,
): ProviderInstance =>
  ({
    instanceId,
    driverKind: instanceId as unknown as ProviderInstance["driverKind"],
    continuationIdentity: {
      driverKind: instanceId as unknown as ProviderInstance["driverKind"],
      continuationKey: `${instanceId}:test`,
    },
    displayName: undefined,
    enabled,
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

  it.effect(
    "falls back to another enabled instance with its driver's default model when the selected instance fails",
    () =>
      Effect.gen(function* () {
        const codex = makeStubInstance(
          ProviderInstanceId.make("codex"),
          makeStubTextGeneration({
            generateThreadTitle: () =>
              Effect.fail(
                new TextGenerationError({
                  operation: "generateThreadTitle",
                  detail: "Codex CLI command failed: usage limit",
                }),
              ),
          }),
        );

        const fallbackSelections: string[] = [];
        const claude = makeStubInstance(
          ProviderInstanceId.make("claudex"),
          makeStubTextGeneration({
            generateThreadTitle: (input) => {
              fallbackSelections.push(
                `${input.modelSelection.instanceId}:${input.modelSelection.model}`,
              );
              return Effect.succeed({ title: "Fallback title" });
            },
          }),
        );

        const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([codex, claude]));

        const result = yield* tg.generateThreadTitle({
          cwd: process.cwd(),
          message: "Redesign the merge PR button",
          modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4-mini"),
        });

        expect(result.title).toBe("Fallback title");
        expect(fallbackSelections).toEqual(["claudex:claudex-luna"]);
      }),
  );

  it.effect("re-raises the original error when every fallback instance also fails", () =>
    Effect.gen(function* () {
      const codex = makeStubInstance(
        ProviderInstanceId.make("codex"),
        makeStubTextGeneration({
          generateBranchName: () =>
            Effect.fail(
              new TextGenerationError({
                operation: "generateBranchName",
                detail: "codex is out of credits",
              }),
            ),
        }),
      );
      const claude = makeStubInstance(
        ProviderInstanceId.make("claudex"),
        makeStubTextGeneration({
          generateBranchName: () =>
            Effect.fail(
              new TextGenerationError({
                operation: "generateBranchName",
                detail: "claude is down too",
              }),
            ),
        }),
      );

      const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([codex, claude]));

      const result = yield* tg
        .generateBranchName({
          cwd: process.cwd(),
          message: "anything",
          modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4-mini"),
        })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("TextGenerationError");
        expect(result.failure.detail).toContain("codex is out of credits");
      }
    }),
  );

  it.effect("skips disabled instances when falling back", () =>
    Effect.gen(function* () {
      const codex = makeStubInstance(
        ProviderInstanceId.make("codex"),
        makeStubTextGeneration({
          generateBranchName: () =>
            Effect.fail(
              new TextGenerationError({
                operation: "generateBranchName",
                detail: "codex is out of credits",
              }),
            ),
        }),
      );
      const disabledClaude = makeStubInstance(
        ProviderInstanceId.make("claudex"),
        makeStubTextGeneration({
          generateBranchName: () => Effect.succeed({ branch: "should-not-happen" }),
        }),
        false,
      );
      const grok = makeStubInstance(
        ProviderInstanceId.make("grok"),
        makeStubTextGeneration({
          generateBranchName: () => Effect.succeed({ branch: "grok-branch" }),
        }),
      );

      const tg = TextGeneration.makeTextGenerationFromRegistry(
        makeStubRegistry([codex, disabledClaude, grok]),
      );

      const result = yield* tg.generateBranchName({
        cwd: process.cwd(),
        message: "anything",
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4-mini"),
      });

      expect(result.branch).toBe("grok-branch");
    }),
  );
});
