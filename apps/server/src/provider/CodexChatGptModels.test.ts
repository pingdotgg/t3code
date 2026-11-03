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
                        {
                          slug: "second",
                          display_name: "Second from OpenAI",
                          visibility: "list",
                          default_reasoning_level: "low",
                          supported_reasoning_levels: [
                            { effort: "low", description: "Fast" },
                            { effort: "high", description: "Deep" },
                          ],
                        },
                        {
                          slug: "hidden",
                          display_name: "Hidden",
                          visibility: "hidden",
                          default_reasoning_level: null,
                          supported_reasoning_levels: null,
                        },
                        {
                          slug: "first",
                          display_name: "First from OpenAI",
                          visibility: "list",
                          default_reasoning_level: "high",
                          supported_reasoning_levels: [{ effort: "high", description: "Deep" }],
                        },
                      ]
                    : [
                        {
                          slug: "account-b-only",
                          display_name: "B",
                          visibility: "list",
                          default_reasoning_level: null,
                          supported_reasoning_levels: null,
                        },
                      ],
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
      assert.deepEqual(a[0]!.capabilities?.optionDescriptors, [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "low", label: "Low", isDefault: true },
            { id: "high", label: "High" },
          ],
          currentValue: "low",
        },
      ]);
      const b = yield* chatGptModels("account-b", native).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      assert.deepEqual(
        b.map((model) => model.slug),
        ["account-b-only"],
      );
      assert.isNull(b[0]!.capabilities);
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
