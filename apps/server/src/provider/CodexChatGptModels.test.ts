import { assert, it } from "@effect/vitest";
import type { ServerProviderModel } from "@t3tools/contracts";
import {
  buildExplicitProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { chatGptModels } from "./CodexChatGptModels.ts";

const accountModel = {
  slug: "gpt-6.1-sol",
  display_name: "GPT-6.1-Sol",
  visibility: "list",
  default_reasoning_level: "low",
  supported_reasoning_levels: [
    { effort: "low", description: "Fast responses with lighter reasoning" },
    { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
    { effort: "high", description: "Greater reasoning depth for complex problems" },
    { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
    { effort: "max", description: "Maximum reasoning depth for the hardest problems" },
    { effort: "ultra", description: "Maximum reasoning with automatic task delegation" },
  ],
};

const catalogClient = (models: ReadonlyArray<unknown>) =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ models }))),
  );

it.effect("exposes account reasoning controls when the model is absent from native discovery", () =>
  Effect.gen(function* () {
    const models = yield* chatGptModels("account-a", []).pipe(
      Effect.provideService(HttpClient.HttpClient, catalogClient([accountModel])),
    );
    const capabilities = models[0]!.capabilities;
    assert.isNotNull(capabilities);
    assert.deepStrictEqual(capabilities!.optionDescriptors, [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "low", label: "Low", isDefault: true },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
          { id: "xhigh", label: "Extra High" },
          { id: "max", label: "Max" },
          { id: "ultra", label: "Ultra" },
        ],
        currentValue: "low",
      },
    ]);
    const selections = [{ id: "reasoningEffort", value: "high" }];
    assert.deepStrictEqual(
      buildExplicitProviderOptionSelectionsFromDescriptors(
        getProviderOptionDescriptors({ caps: capabilities!, selections }),
        selections,
      ),
      selections,
    );
  }),
);

it.effect("preserves existing native reasoning controls and other capabilities", () =>
  Effect.gen(function* () {
    const native: ReadonlyArray<ServerProviderModel> = [
      {
        slug: accountModel.slug,
        name: "Cached model",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select",
              options: [{ id: "medium", label: "Medium", isDefault: true }],
              currentValue: "medium",
            },
            { id: "nativeOption", label: "Native option", type: "boolean", currentValue: true },
          ],
        },
      },
    ];
    for (const levels of [accountModel.supported_reasoning_levels, [], null]) {
      const models = yield* chatGptModels("account-a", native).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          catalogClient([{ ...accountModel, supported_reasoning_levels: levels }]),
        ),
      );
      assert.deepStrictEqual(models[0]!.capabilities, native[0]!.capabilities);
    }
  }),
);

it.effect("fills missing native reasoning controls while preserving other capabilities", () =>
  Effect.gen(function* () {
    const native: ReadonlyArray<ServerProviderModel> = [
      {
        slug: accountModel.slug,
        name: "Cached model",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            { id: "nativeOption", label: "Native option", type: "boolean", currentValue: true },
          ],
        },
      },
    ];
    const models = yield* chatGptModels("account-a", native).pipe(
      Effect.provideService(HttpClient.HttpClient, catalogClient([accountModel])),
    );
    const descriptors = models[0]!.capabilities!.optionDescriptors!;
    assert.strictEqual(descriptors[0]!.id, "reasoningEffort");
    assert.strictEqual(descriptors[0]!.currentValue, "low");
    assert.deepStrictEqual(descriptors[1], native[0]!.capabilities!.optionDescriptors![0]);
  }),
);

it.effect("accepts null and empty defaults without inventing a default", () =>
  Effect.gen(function* () {
    for (const defaultReasoning of [null, ""]) {
      const models = yield* chatGptModels("account-a", []).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          catalogClient([{ ...accountModel, default_reasoning_level: defaultReasoning }]),
        ),
      );
      const descriptor = models[0]!.capabilities!.optionDescriptors![0]!;
      assert.strictEqual(descriptor.type, "select");
      assert.isUndefined(descriptor.currentValue);
      if (descriptor.type === "select") {
        assert.isFalse(descriptor.options.some((option) => option.isDefault));
      }
    }
  }),
);

it.effect("isolates malformed reasoning metadata without discarding the catalog", () =>
  Effect.gen(function* () {
    for (const levels of [null, [], "invalid", [{ effort: null }]]) {
      const models = yield* chatGptModels("account-a", []).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          catalogClient([
            accountModel,
            { ...accountModel, slug: "invalid-model", supported_reasoning_levels: levels },
            {
              ...accountModel,
              slug: "hidden-model",
              visibility: "hidden",
              default_reasoning_level: {},
              supported_reasoning_levels: [{ effort: null, description: null }],
            },
          ]),
        ),
      );
      assert.deepStrictEqual(
        models.map((model) => model.slug),
        [accountModel.slug, "invalid-model"],
      );
      assert.strictEqual(models[0]!.capabilities!.optionDescriptors![0]!.currentValue, "low");
      assert.isNull(models[1]!.capabilities);
    }
  }),
);

it.effect("accepts new account effort values without inventing a default", () =>
  Effect.gen(function* () {
    const models = yield* chatGptModels("account-a", []).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        catalogClient([
          {
            slug: "account-model",
            display_name: "Account model",
            visibility: "list",
            supported_reasoning_levels: [{ effort: "future-effort" }],
          },
        ]),
      ),
    );
    assert.deepStrictEqual(models[0]!.capabilities!.optionDescriptors, [
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
