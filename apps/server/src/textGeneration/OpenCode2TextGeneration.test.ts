import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@t3tools/shared/model";

import { OpenCode2Settings, ProviderInstanceId } from "@t3tools/contracts";
import { OpenCode2Runtime, type OpenCode2RuntimeShape } from "../provider/opencode2Runtime.ts";
import { makeOpenCode2TextGeneration } from "./OpenCode2TextGeneration.ts";

const decodeSettings = Schema.decodeSync(OpenCode2Settings);
const INSTANCE = ProviderInstanceId.make("opencode2");

/**
 * The generation endpoint is stubbed at the runtime boundary so these tests
 * pin the decode path rather than the server: `generate.text` returns the
 * model's raw text, and `extractJsonObject` hands it on as a JSON *string*.
 * `requestedModels` records the ref actually sent so variant forwarding is
 * observable.
 */
const runtimeReturning = (
  text: () => string,
  requestedModels?: Array<Record<string, unknown>>,
): OpenCode2RuntimeShape => ({
  connect: () =>
    Effect.succeed({
      client: {
        generate: {
          text: (input: { readonly model?: Record<string, unknown> }) =>
            Effect.sync(() => {
              requestedModels?.push(input.model ?? {});
              return { text: text() };
            }),
        },
      },
      url: "http://stub",
      external: false,
      version: "2.0.3",
    } as never),
  loadInventory: () => Effect.die("not used"),
});

const makeTextGeneration = (text: () => string, requestedModels?: Array<Record<string, unknown>>) =>
  makeOpenCode2TextGeneration(decodeSettings({ enabled: true })).pipe(
    Effect.provideService(
      OpenCode2Runtime,
      OpenCode2Runtime.of(runtimeReturning(text, requestedModels)),
    ),
  );

const generateTitle = (
  text: () => string,
  message = "investigate the flaky CI job",
  requestedModels?: Array<Record<string, unknown>>,
) =>
  Effect.gen(function* () {
    const textGeneration = yield* makeTextGeneration(text, requestedModels);
    return yield* textGeneration.generateThreadTitle({
      message,
      cwd: process.cwd(),
      modelSelection: createModelSelection(INSTANCE, "openai/gpt-6-astra"),
    });
  }).pipe(Effect.provide(NodeServices.layer));

it.effect("forwards the selected reasoning variant into the model ref", () =>
  Effect.gen(function* () {
    // Regression: only the base slug was parsed, so Low/High/Extra High were
    // silently ignored and text generation used the provider default.
    const requestedModels: Array<Record<string, unknown>> = [];
    const textGeneration = yield* makeTextGeneration(
      () => JSON.stringify({ title: "Fix flaky CI job" }),
      requestedModels,
    );
    yield* textGeneration.generateThreadTitle({
      message: "investigate the flaky CI job",
      cwd: process.cwd(),
      modelSelection: createModelSelection(INSTANCE, "openai/gpt-6-astra", [
        { id: "variant", value: "high" },
      ]),
    });

    NodeAssert.equal(requestedModels.length, 1);
    NodeAssert.equal(requestedModels[0]?.providerID, "openai");
    NodeAssert.equal(requestedModels[0]?.id, "gpt-6-astra");
    NodeAssert.equal(requestedModels[0]?.variant, "high");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("decodes a plain JSON object returned by the model", () =>
  Effect.gen(function* () {
    const result = yield* generateTitle(() => JSON.stringify({ title: "Fix flaky CI job" }));
    NodeAssert.equal(result.title, "Fix flaky CI job");
  }),
);

it.effect("decodes JSON the model wrapped in a code fence", () =>
  Effect.gen(function* () {
    // Regression: the schema was applied to the extracted JSON *string*
    // instead of the parsed object, so every call failed with
    // "SchemaError: Expected object".
    const result = yield* generateTitle(
      () => "```json\n" + JSON.stringify({ title: "Fix flaky CI job" }) + "\n```",
    );
    NodeAssert.equal(result.title, "Fix flaky CI job");
  }),
);

it.effect("decodes JSON the model embedded in prose", () =>
  Effect.gen(function* () {
    const result = yield* generateTitle(
      () => `Sure! Here's a title:\n\n${JSON.stringify({ title: "Fix flaky CI job" })}`,
    );
    NodeAssert.equal(result.title, "Fix flaky CI job");
  }),
);

it.effect("fails with a TextGenerationError when the output is not JSON", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(generateTitle(() => "no json here at all"));
    NodeAssert.equal(exit._tag, "Failure");
    if (exit._tag !== "Failure") return;
    const error = exit.cause.reasons
      .map((reason) => (reason as { readonly error?: unknown }).error)
      .find((candidate) => candidate !== undefined) as { readonly _tag?: string } | undefined;
    NodeAssert.equal(error?._tag, "TextGenerationError");
  }),
);
