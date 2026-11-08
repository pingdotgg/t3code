import { it } from "@effect/vitest";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { expect, vi } from "vite-plus/test";
import * as ServerSettings from "../serverSettings.ts";
import * as SpeechCleanupApi from "./SpeechCleanupApi.ts";

const layer = (patch: Parameters<typeof ServerSettings.layerTest>[0] = {}) =>
  SpeechCleanupApi.layer.pipe(
    Layer.provideMerge(ServerSettings.layerTest(patch)),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
  );

it.effect.each(["openai", "anthropic", "compatible", "openrouter"] as const)(
  "lists %s models using its saved credential, including Anthropic pagination and effort capabilities",
  (provider) =>
    Effect.gen(function* () {
      const upstream = vi.fn<typeof fetch>(async (url, init) => {
        const parsed = new URL(String(url));
        expect(parsed.pathname.endsWith("/models")).toBe(true);
        expect(init?.redirect).toBe("error");
        const headers = new Headers(init?.headers);
        expect(headers.get(provider === "anthropic" ? "x-api-key" : "authorization")).toBe(
          provider === "anthropic" ? "anthropic-key" : `Bearer ${provider}-key`,
        );
        if (provider === "anthropic") {
          expect(parsed.searchParams.get("limit")).toBe("1000");
          if (!parsed.searchParams.has("after_id"))
            return Response.json({
              data: [
                {
                  id: "claude-first",
                  display_name: "First",
                  capabilities: {
                    effort: {
                      supported: true,
                      low: { supported: true },
                      high: { supported: false },
                    },
                  },
                },
              ],
              has_more: true,
              last_id: "claude-first",
            });
          expect(parsed.searchParams.get("after_id")).toBe("claude-first");
        }
        return Response.json({
          data: [{ id: "model-b" }, { id: "model-a", name: "A" }, { id: "model-b" }],
          has_more: false,
        });
      });
      const api = yield* SpeechCleanupApi.SpeechCleanupApi.pipe(
        Effect.provide(
          layer({
            speechPostProcessingProvider: provider === "openrouter" ? "compatible" : provider,
            speechPostProcessingCompatiblePreset:
              provider === "openrouter" ? "openrouter" : "custom",
            speechPostProcessingApiEndpoints: {
              compatible: { endpoint: "http://localhost:1234/v1" },
            },
            voiceApiCredentials: {
              openaiPostProcessing: "openai-key",
              compatiblePostProcessing: "compatible-key",
              anthropicPostProcessing: "anthropic-key",
              openrouterPostProcessing: "openrouter-key",
            },
          }),
        ),
      );
      const result = yield* api.models.pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
      expect(result.models.map((model) => model.id)).toEqual(
        provider === "anthropic" ? ["claude-first", "model-a", "model-b"] : ["model-a", "model-b"],
      );
      if (provider === "anthropic") expect(result.models[0]?.reasoningLevels).toEqual(["low"]);
      expect(upstream).toHaveBeenCalledTimes(provider === "anthropic" ? 2 : 1);
      upstream.mockResolvedValueOnce(Response.json({ data: "invalid" }));
      expect(
        yield* Effect.flip(api.models.pipe(Effect.provideService(FetchHttpClient.Fetch, upstream))),
      ).toMatchObject({ operation: "models", reason: "response" });
    }),
);

it.effect(
  "keeps the OpenRouter preset's key and model separate from a custom compatible endpoint",
  () =>
    Effect.gen(function* () {
      const upstream = vi.fn<typeof fetch>(async (url, init) => {
        expect(String(url)).toBe("https://openrouter.ai/api/v1/chat/completions");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer router-key");
        expect(JSON.parse(String(init?.body)).model).toBe("router/model");
        return Response.json({
          choices: [{ finish_reason: "stop", message: { content: "Cleaned." } }],
        });
      });
      const api = yield* SpeechCleanupApi.SpeechCleanupApi.pipe(
        Effect.provide(
          layer({
            speechPostProcessingProvider: "compatible",
            speechPostProcessingCompatiblePreset: "openrouter",
            speechPostProcessingApiEndpoints: {
              openrouter: { model: "router/model" },
              compatible: { model: "custom/model", endpoint: "http://localhost:1234/v1" },
            },
            voiceApiCredentials: {
              openrouterPostProcessing: "router-key",
              compatiblePostProcessing: "custom-key",
            },
          }),
        ),
      );
      expect(
        yield* api
          .postProcess("Clean")
          .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream)),
      ).toBe("Cleaned.");
    }),
);

it.effect("cleans text in one OpenAI request without sending an STT credential", () =>
  Effect.gen(function* () {
    const upstream = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe("https://api.openai.com/v1/responses");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer openai-key");
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "gpt-4.1-mini",
        input: "Clean this transcript",
        store: false,
        reasoning: { effort: "low" },
      });
      return Response.json({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "Cleaned." }] }],
      });
    });
    const api = yield* SpeechCleanupApi.SpeechCleanupApi.pipe(
      Effect.provide(
        layer({
          voiceApiCredentials: { openaiPostProcessing: "openai-key" },
          speechPostProcessingOpenAIReasoning: "low",
        }),
      ),
    );
    expect(
      yield* api
        .postProcess("Clean this transcript")
        .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream)),
    ).toBe("Cleaned.");
    expect(upstream).toHaveBeenCalledTimes(1);
  }),
);

it.effect.each(["compatible", "openrouter", "anthropic"] as const)(
  "uses the %s cleanup protocol and only that provider's credential",
  (provider) =>
    Effect.gen(function* () {
      const endpoint =
        provider === "compatible"
          ? "http://127.0.0.1:1234/v1/"
          : provider === "anthropic"
            ? "https://api.anthropic.com/v1"
            : "https://openrouter.ai/api/v1";
      const path = provider === "anthropic" ? "/messages" : "/chat/completions";
      const upstream = vi.fn<typeof fetch>(async (url, init) => {
        expect(String(url)).toBe(endpoint.replace(/\/+$/, "") + path);
        const headers = new Headers(init?.headers);
        expect(headers.get(provider === "anthropic" ? "x-api-key" : "authorization")).toBe(
          provider === "anthropic" ? "anthropic-key" : `Bearer ${provider}-key`,
        );
        expect(headers.get(provider === "anthropic" ? "authorization" : "x-api-key")).toBeNull();
        if (provider === "anthropic") expect(headers.get("anthropic-version")).toBe("2023-06-01");
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          model: "cleanup-model",
          messages: [{ role: "user", content: "Clean this transcript" }],
        });
        expect(body).not.toHaveProperty("tools");
        if (provider === "anthropic") expect(body.output_config).toEqual({ effort: "medium" });
        else expect(body).not.toHaveProperty("reasoning_effort");
        expect(init?.redirect).toBe("error");
        return Response.json(
          provider === "anthropic"
            ? { stop_reason: "end_turn", content: [{ type: "text", text: "Cleaned." }] }
            : { choices: [{ finish_reason: "stop", message: { content: "Cleaned." } }] },
        );
      });
      const api = yield* SpeechCleanupApi.SpeechCleanupApi.pipe(
        Effect.provide(
          layer({
            speechPostProcessingProvider: provider,
            speechPostProcessingAnthropicReasoning: "medium",
            speechPostProcessingApiEndpoints: { [provider]: { endpoint, model: "cleanup-model" } },
            voiceApiCredentials: {
              openaiPostProcessing: "openai-key",
              compatiblePostProcessing: "compatible-key",
              anthropicPostProcessing: "anthropic-key",
              openrouterPostProcessing: "openrouter-key",
            },
          }),
        ),
      );
      expect(
        yield* api
          .postProcess("Clean this transcript")
          .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream)),
      ).toBe("Cleaned.");
      expect(upstream).toHaveBeenCalledTimes(1);
      upstream.mockResolvedValueOnce(
        Response.json(
          provider === "anthropic"
            ? { stop_reason: "max_tokens", content: [{ type: "text", text: "Partial" }] }
            : { choices: [{ finish_reason: "length", message: { content: "Partial" } }] },
        ),
      );
      expect(
        yield* Effect.flip(
          api
            .postProcess("Clean this transcript")
            .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream)),
        ),
      ).toMatchObject({ reason: "response" });
    }),
);

it.effect.each(["compatible", "anthropic", "openrouter"] as const)(
  "%s never borrows the saved OpenAI key when its own key is empty",
  (provider) =>
    Effect.gen(function* () {
      const upstream = vi.fn<typeof fetch>(async (_url, init) => {
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        return Response.json({
          choices: [{ finish_reason: "stop", message: { content: "Cleaned." } }],
        });
      });
      const api = yield* SpeechCleanupApi.SpeechCleanupApi.pipe(
        Effect.provide(
          layer({
            speechPostProcessingProvider: provider,
            speechPostProcessingApiEndpoints: {
              [provider]: { endpoint: "http://127.0.0.1:1234/v1", model: "cleanup-model" },
            },
            voiceApiCredentials: { openaiPostProcessing: "private-openai-key" },
          }),
        ),
      );
      const request = api
        .postProcess("Clean.")
        .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
      if (provider === "compatible") {
        expect(yield* request).toBe("Cleaned.");
        expect(upstream).toHaveBeenCalledTimes(1);
      } else {
        expect(yield* Effect.flip(request)).toMatchObject({ reason: "credential" });
        expect(upstream).not.toHaveBeenCalled();
      }
    }),
);

it.effect(
  "rejects incomplete OpenAI output and a missing key without starting a fallback request",
  () =>
    Effect.gen(function* () {
      const upstream = vi.fn<typeof fetch>(async () =>
        Response.json({
          status: "incomplete",
          output: [{ type: "message", content: [{ type: "output_text", text: "Partial" }] }],
        }),
      );
      const api = yield* SpeechCleanupApi.SpeechCleanupApi;
      expect(
        yield* Effect.flip(
          api.postProcess("Clean.").pipe(Effect.provideService(FetchHttpClient.Fetch, upstream)),
        ),
      ).toMatchObject({ operation: "post-processing", reason: "response" });
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ voiceApiCredentials: { openaiPostProcessing: "" } });
      expect(
        yield* Effect.flip(
          api.postProcess("Clean.").pipe(Effect.provideService(FetchHttpClient.Fetch, upstream)),
        ),
      ).toMatchObject({ operation: "post-processing", reason: "credential" });
      expect(upstream).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(layer({ voiceApiCredentials: { openaiPostProcessing: "key" } }))),
);
