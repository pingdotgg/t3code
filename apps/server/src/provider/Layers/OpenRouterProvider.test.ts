import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { OpenRouterSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  checkOpenRouterProviderStatus,
  makePendingOpenRouterProvider,
} from "./OpenRouterProvider.ts";

const decodeOpenRouterSettings = Schema.decodeSync(OpenRouterSettings);

const makeModelsHttpClient = (status: number, body: unknown) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    ),
  );

const EmptyModelsHttpClientLive = makeModelsHttpClient(200, { data: [] });
const ValidModelsHttpClientLive = makeModelsHttpClient(200, {
  data: [{ id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4" }],
});
const UnauthorizedModelsHttpClientLive = makeModelsHttpClient(401, { error: "unauthorized" });

describe("makePendingOpenRouterProvider", () => {
  it.effect("builds a disabled snapshot with fallback models", () =>
    Effect.gen(function* () {
      const snapshot = yield* makePendingOpenRouterProvider(
        decodeOpenRouterSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.displayName).toBe("OpenRouter");
      expect(snapshot.models.some((model) => model.slug === "anthropic/claude-sonnet-4")).toBe(
        true,
      );
    }),
  );

  it.effect("builds a pending snapshot for enabled OpenRouter", () =>
    Effect.gen(function* () {
      const snapshot = yield* makePendingOpenRouterProvider(decodeOpenRouterSettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.message).toMatch(/not been checked/i);
    }),
  );
});

it.layer(NodeServices.layer.pipe(Layer.provideMerge(EmptyModelsHttpClientLive)))(
  "checkOpenRouterProviderStatus (missing binary)",
  (it) => {
    it.effect("reports a missing Claude runtime binary without throwing", () =>
      Effect.gen(function* () {
        const snapshot = yield* checkOpenRouterProviderStatus(
          decodeOpenRouterSettings({
            enabled: true,
            apiKey: "sk-or-test",
            binaryPath: "/definitely/not/installed/claude-binary",
          }),
        );

        expect(snapshot.installed).toBe(false);
        expect(snapshot.status).toBe("error");
        expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
      }),
    );
  },
);

it.layer(NodeServices.layer.pipe(Layer.provideMerge(ValidModelsHttpClientLive)))(
  "checkOpenRouterProviderStatus (auth independent of CLI)",
  (it) => {
    it.effect("reports authenticated when CLI is missing but API key is valid", () =>
      Effect.gen(function* () {
        const snapshot = yield* checkOpenRouterProviderStatus(
          decodeOpenRouterSettings({
            enabled: true,
            apiKey: "sk-or-test",
            binaryPath: "/definitely/not/installed/claude-binary",
          }),
        );

        expect(snapshot.installed).toBe(false);
        expect(snapshot.status).toBe("error");
        expect(snapshot.auth.status).toBe("authenticated");
        expect(snapshot.models.some((model) => model.slug === "anthropic/claude-sonnet-4")).toBe(
          true,
        );
      }),
    );

    it.effect("reports ready when CLI version probe and auth both succeed", () =>
      Effect.gen(function* () {
        const snapshot = yield* checkOpenRouterProviderStatus(
          decodeOpenRouterSettings({
            enabled: true,
            apiKey: "sk-or-test",
            // `node --version` is a reliable cross-platform success probe.
            binaryPath: process.execPath,
          }),
        );

        expect(snapshot.installed).toBe(true);
        expect(snapshot.status).toBe("ready");
        expect(snapshot.auth.status).toBe("authenticated");
        expect(snapshot.message).toMatch(/openrouter\.ai\/api/i);
      }),
    );
  },
);

it.layer(NodeServices.layer.pipe(Layer.provideMerge(UnauthorizedModelsHttpClientLive)))(
  "checkOpenRouterProviderStatus (401)",
  (it) => {
    it.effect("reports unauthenticated on 401 even when CLI is healthy", () =>
      Effect.gen(function* () {
        const snapshot = yield* checkOpenRouterProviderStatus(
          decodeOpenRouterSettings({
            enabled: true,
            apiKey: "sk-or-bad",
            binaryPath: process.execPath,
          }),
        );

        expect(snapshot.installed).toBe(true);
        expect(snapshot.status).toBe("error");
        expect(snapshot.auth.status).toBe("unauthenticated");
        expect(snapshot.message).toMatch(/API key/i);
      }),
    );
  },
);

it.layer(NodeServices.layer.pipe(Layer.provideMerge(ValidModelsHttpClientLive)))(
  "checkOpenRouterProviderStatus (empty key)",
  (it) => {
    it.effect("reports unauthenticated when settings apiKey is empty", () =>
      Effect.gen(function* () {
        const snapshot = yield* checkOpenRouterProviderStatus(
          decodeOpenRouterSettings({
            enabled: true,
            apiKey: "",
            binaryPath: process.execPath,
          }),
        );

        expect(snapshot.installed).toBe(true);
        expect(snapshot.status).toBe("error");
        expect(snapshot.auth.status).toBe("unauthenticated");
        expect(snapshot.message).toMatch(/Add an OpenRouter API key/i);
      }),
    );
  },
);
