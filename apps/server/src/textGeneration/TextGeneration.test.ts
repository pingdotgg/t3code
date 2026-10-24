import { assert, it } from "@effect/vitest";
import { type ModelSelection, ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";

const primary: ModelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const fallback: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-haiku-5-5",
};

const unused = () => Effect.die("Unexpected text generation operation");

/** Instances title with their mapped title, or fail when it is `null`. */
const makeTextGeneration = (titles: ReadonlyMap<ProviderInstanceId, string | null>) =>
  Effect.gen(function* () {
    const calls: Array<ModelSelection> = [];
    const instanceFor = (instanceId: ProviderInstanceId) => {
      const title = titles.get(instanceId);
      if (title === undefined) return undefined;
      const textGeneration: ProviderInstance["textGeneration"] = {
        generateCommitMessage: unused,
        generatePrContent: unused,
        generateBranchName: unused,
        generateReviewGuide: unused,
        generateThreadTitle: (input) => {
          calls.push(input.modelSelection);
          return title === null
            ? Effect.fail(
                new TextGenerationError({
                  operation: "generateThreadTitle",
                  detail: `${instanceId} is down`,
                }),
              )
            : Effect.succeed({ title });
        },
      };
      return { instanceId, textGeneration } as unknown as ProviderInstance;
    };
    const service = yield* TextGeneration.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            getInstance: (instanceId) => Effect.succeed(instanceFor(instanceId)),
          }),
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            resolveLink: () => Effect.die("Unexpected source control link lookup"),
          }),
        ),
      ),
    );
    return { service, calls };
  });

const titleInput = {
  cwd: "/workspace",
  message: "Fix the login redirect",
  linkedContext: "",
  modelSelection: primary,
};

it.effect("titles a thread with the fallback model when the primary fails", () =>
  Effect.gen(function* () {
    const { service, calls } = yield* makeTextGeneration(
      new Map([
        [primary.instanceId, null],
        [fallback.instanceId, "Fix login redirect"],
      ]),
    );

    const result = yield* service.generateThreadTitle({
      ...titleInput,
      fallbackModelSelection: fallback,
    });

    assert.equal(result.title, "Fix login redirect");
    assert.deepEqual(calls, [primary, fallback]);
  }),
);

it.effect("does not run the fallback when the primary succeeds", () =>
  Effect.gen(function* () {
    const { service, calls } = yield* makeTextGeneration(
      new Map([
        [primary.instanceId, "Primary title"],
        [fallback.instanceId, "Fallback title"],
      ]),
    );

    const result = yield* service.generateThreadTitle({
      ...titleInput,
      fallbackModelSelection: fallback,
    });

    assert.equal(result.title, "Primary title");
    assert.deepEqual(calls, [primary]);
  }),
);

it.effect("reports the primary model's error when the fallback also fails", () =>
  Effect.gen(function* () {
    const { service, calls } = yield* makeTextGeneration(
      new Map([
        [primary.instanceId, null],
        [fallback.instanceId, null],
      ]),
    );

    const error = yield* service
      .generateThreadTitle({ ...titleInput, fallbackModelSelection: fallback })
      .pipe(Effect.flip);

    assert.equal(error.detail, "codex is down");
    assert.deepEqual(calls, [primary, fallback]);
  }),
);

it.effect("does not retry a fallback that names the primary model", () =>
  Effect.gen(function* () {
    const { service, calls } = yield* makeTextGeneration(new Map([[primary.instanceId, null]]));

    const error = yield* service
      .generateThreadTitle({
        ...titleInput,
        fallbackModelSelection: {
          ...primary,
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      })
      .pipe(Effect.flip);

    assert.equal(error.detail, "codex is down");
    assert.deepEqual(calls, [primary]);
  }),
);
