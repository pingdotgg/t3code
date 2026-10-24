import { assert, it } from "@effect/vitest";
import type { ServerProviderModel } from "@t3tools/contracts";
import {
  buildExplicitProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { chatGptModels } from "./CodexChatGptModels.ts";
import { mapCodexModelCapabilities } from "./CodexProvider.ts";

const accountModel = {
  slug: "gpt-6-astra",
  display_name: "GPT-6-Astra",
  visibility: "list",
  default_reasoning_level: "low",
  supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
};

const catalogClient = (models: ReadonlyArray<unknown>) =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ models }))),
  );

it.effect("restores account reasoning controls with catalog defaults and explicit selections", () =>
  Effect.gen(function* () {
    const models = yield* chatGptModels("account-a", []).pipe(
      Effect.provideService(HttpClient.HttpClient, catalogClient([accountModel])),
    );
    const caps = models[0]!.capabilities!;
    assert.deepStrictEqual(caps.optionDescriptors, [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium", isDefault: true },
          { id: "high", label: "High" },
        ],
        currentValue: "medium",
      },
    ]);
    assert.isUndefined(
      buildExplicitProviderOptionSelectionsFromDescriptors(
        getProviderOptionDescriptors({ caps }),
        undefined,
      ),
    );
    const selections = [{ id: "reasoningEffort", value: "high" }];
    assert.deepStrictEqual(
      buildExplicitProviderOptionSelectionsFromDescriptors(
        getProviderOptionDescriptors({ caps, selections }),
        selections,
      ),
      selections,
    );
  }),
);

it.effect(
  "fills only missing reasoning controls and preserves native Astra defaults and options",
  () =>
    Effect.gen(function* () {
      const capabilities = mapCodexModelCapabilities({
        model: accountModel.slug,
        id: accountModel.slug,
        displayName: accountModel.display_name,
        description: "Test model",
        hidden: false,
        isDefault: false,
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: accountModel.supported_reasoning_levels.map(({ effort }) => ({
          reasoningEffort: effort,
          description: effort,
        })),
        additionalSpeedTiers: ["fast"],
      });
      assert.strictEqual(capabilities.optionDescriptors![0]!.currentValue, "medium");
      const otherOptions = capabilities.optionDescriptors!.filter(
        ({ id }) => id !== "reasoningEffort",
      );
      assert.isNotEmpty(otherOptions);
      const native: ServerProviderModel[] = [
        { slug: accountModel.slug, name: "Native Astra", isCustom: false, capabilities },
        {
          slug: "missing-reasoning",
          name: "Native model",
          isCustom: false,
          capabilities: { optionDescriptors: otherOptions },
        },
      ];
      const models = yield* chatGptModels("account-a", native).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          catalogClient([accountModel, { ...accountModel, slug: "missing-reasoning" }]),
        ),
      );
      assert.deepStrictEqual(models[0]!.capabilities, capabilities);
      const descriptors = models[1]!.capabilities!.optionDescriptors!;
      assert.strictEqual(
        descriptors.find(({ id }) => id === "reasoningEffort")?.currentValue,
        "low",
      );
      assert.deepStrictEqual(
        descriptors.filter(({ id }) => id !== "reasoningEffort"),
        otherOptions,
      );
    }),
);

it.effect(
  "isolates malformed optional metadata without dropping visible models or inventing defaults",
  () =>
    Effect.gen(function* () {
      const models = yield* chatGptModels("account-a", []).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          catalogClient([
            accountModel,
            {
              ...accountModel,
              slug: "invalid-levels",
              supported_reasoning_levels: [{ effort: null }],
            },
            {
              ...accountModel,
              slug: "invalid-default",
              default_reasoning_level: {},
              supported_reasoning_levels: [{ effort: "future-effort" }],
            },
            {
              ...accountModel,
              slug: "hidden",
              visibility: "hidden",
              supported_reasoning_levels: null,
            },
          ]),
        ),
      );
      assert.deepStrictEqual(
        models.map(({ slug }) => slug),
        [accountModel.slug, "invalid-levels", "invalid-default"],
      );
      assert.strictEqual(models[0]!.capabilities!.optionDescriptors![0]!.currentValue, "medium");
      assert.isNull(models[1]!.capabilities);
      assert.deepStrictEqual(models[2]!.capabilities!.optionDescriptors, [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          options: [{ id: "future-effort", label: "future-effort" }],
        },
      ]);
    }),
);

it.effect(
  "uses each selected profile's token and the server's visible catalog order and names",
  () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          assert.strictEqual(request.url, "https://api.openai.com/v1/models");
          requests.push(request.headers.authorization!);
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                models:
                  request.headers.authorization === "Bearer account-a"
                    ? [
                        { slug: "second", display_name: "Second from OpenAI", visibility: "list" },
                        { slug: "hidden", display_name: "Hidden", visibility: "hidden" },
                        { slug: "first", display_name: "First from OpenAI", visibility: "list" },
                      ]
                    : [{ slug: "account-b-only", display_name: "B", visibility: "list" }],
              }),
            ),
          );
        }),
      );
      const native = [
        {
          slug: "first",
          name: "Cached first",
          isCustom: false,
          capabilities: { optionDescriptors: [] },
        },
        { slug: "not-entitled", name: "Cached other", isCustom: false, capabilities: null },
      ];
      const a = yield* chatGptModels("account-a", native).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      assert.deepEqual(
        a.map((model) => [model.slug, model.name]),
        [
          ["second", "Second from OpenAI"],
          ["first", "First from OpenAI"],
        ],
      );
      assert.deepEqual(a[1]!.capabilities, native[0]!.capabilities);
      assert.isNull(a[0]!.capabilities);
      const b = yield* chatGptModels("account-b", native).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      assert.deepEqual(
        b.map((model) => model.slug),
        ["account-b-only"],
      );
      assert.deepEqual(requests, ["Bearer account-a", "Bearer account-b"]);
    }),
);

it.effect("does not present a cached catalog as account entitlements when discovery fails", () =>
  Effect.gen(function* () {
    const http = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }))),
    );
    const error = yield* Effect.flip(
      chatGptModels("account-a", []).pipe(Effect.provideService(HttpClient.HttpClient, http)),
    );
    assert.strictEqual(error._tag, "ChatGptCatalogError");
  }),
);
