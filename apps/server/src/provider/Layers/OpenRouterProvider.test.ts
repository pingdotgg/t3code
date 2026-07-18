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

const EmptyModelsHttpClientLive = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  ),
);

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
  "checkOpenRouterProviderStatus",
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
