import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { chatGptModels } from "./CodexChatGptModels.ts";

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
      assert.deepEqual(a[0]!.capabilities, native[0]!.capabilities);
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

it.effect("borrows catalog-only reasoning capabilities by variant, then by native order", () =>
  Effect.gen(function* () {
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              models: [
                { slug: "gpt-6.1-sol", display_name: "Sol", visibility: "list" },
                { slug: "gpt-6.1-terra", display_name: "Terra", visibility: "list" },
                { slug: "gpt-6-astra", display_name: "Astra", visibility: "list" },
              ],
            }),
          ),
        ),
      ),
    );
    const reasoning = (currentValue: string) => ({
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select" as const,
          options: ["low", "medium", "high", "xhigh", "max", "ultra"].map((id) => ({
            id,
            label: id,
            isDefault: id === currentValue,
          })),
          currentValue,
        },
      ],
    });
    const native = [
      { slug: "gpt-6-astra", name: "Astra", isCustom: false, capabilities: null },
      { slug: "gpt-6-luna", name: "Luna", isCustom: false, capabilities: reasoning("low") },
      { slug: "gpt-6-sol", name: "Sol", isCustom: false, capabilities: reasoning("medium") },
    ];
    const models = yield* chatGptModels("account-a", native).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );
    assert.deepEqual(models[0]!.capabilities, native[2]!.capabilities);
    assert.deepEqual(models[1]!.capabilities, native[1]!.capabilities);
    assert.isNull(models[2]!.capabilities);
    const withoutCapabilities = yield* chatGptModels("account-a", [native[0]!]).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );
    assert.isTrue(withoutCapabilities.every((model) => model.capabilities === null));
  }),
);
