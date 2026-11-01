import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vite-plus/test";

import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";

describe("applyOpenCodeProxyEnvironment", () => {
  it("points the built-in Anthropic and OpenAI providers at the proxy and keeps user config", () => {
    const environment = OpenCodeRuntime.applyOpenCodeProxyEnvironment(
      {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          theme: "t3",
          provider: {
            anthropic: {
              options: {
                timeout: 60_000,
                apiKey: "sk-ant-direct",
                authToken: "direct-oauth-token",
                headers: { Authorization: "Bearer direct", "X-Trace": "1" },
              },
              models: { "claude-x": { headers: { "x-api-key": "sk-ant-direct", "X-Tier": "a" } } },
            },
            openrouter: { options: { apiKey: "or" } },
          },
        }),
      },
      { url: "http://proxy:8317", apiKey: "" },
    );

    const proxied = { baseURL: "http://proxy:8317/v1", apiKey: "t3-proxy" };
    // Plugins such as Codex's ChatGPT login replace fetch and would bypass the proxy.
    expect(environment.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBe("1");
    expect(environment.OPENCODE_PURE).toBe("1");
    // OpenCode treats empty content as unset.
    expect(OpenCodeRuntime.isPlainJsonOpenCodeConfig({ OPENCODE_CONFIG_CONTENT: "" })).toBe(true);
    expect(
      OpenCodeRuntime.isPlainJsonOpenCodeConfig({
        OPENCODE_CONFIG_CONTENT: '{ "theme": "t3", // comment\n }',
      }),
    ).toBe(false);
    expect(JSON.parse(environment.OPENCODE_CONFIG_CONTENT ?? "")).toEqual({
      theme: "t3",
      enabled_providers: ["anthropic", "openai"],
      provider: {
        anthropic: {
          options: { timeout: 60_000, headers: { "X-Trace": "1" }, ...proxied },
          models: { "claude-x": { headers: { "X-Tier": "a" } } },
        },
        openai: { options: proxied },
        openrouter: { options: { apiKey: "or" } },
      },
    });
  });
});

describe("verifyOpenCodeProxyRouting", () => {
  effectIt.effect("rejects a proxied server whose later config redirects a routed provider", () =>
    Effect.gen(function* () {
      const environment = OpenCodeRuntime.applyOpenCodeProxyEnvironment(
        {},
        { url: "http://proxy:8317", apiKey: "sk" },
      );
      const requested = JSON.parse(environment.OPENCODE_CONFIG_CONTENT ?? "{}");
      const clientWith = (config: unknown) =>
        ({ config: { get: () => Promise.resolve({ data: config }) } }) as unknown as OpencodeClient;

      yield* OpenCodeRuntime.verifyOpenCodeProxyRouting(clientWith(requested), environment);
      const error = yield* OpenCodeRuntime.verifyOpenCodeProxyRouting(
        clientWith({
          ...requested,
          provider: {
            ...requested.provider,
            openai: { options: { baseURL: "https://org-gateway.example.test/v1" } },
          },
        }),
        environment,
      ).pipe(Effect.flip);
      expect(error.detail).toContain("openai provider uses an endpoint or credential other");

      // A later config can keep the proxy URL but restore a direct credential.
      for (const override of [
        { apiKey: "sk-ant-direct" },
        { authToken: "direct" },
        { headers: { "X-Api-Key": "sk-ant-direct" } },
      ]) {
        const anthropic = requested.provider.anthropic;
        const restored = yield* OpenCodeRuntime.verifyOpenCodeProxyRouting(
          clientWith({
            ...requested,
            provider: {
              ...requested.provider,
              anthropic: { ...anthropic, options: { ...anthropic.options, ...override } },
            },
          }),
          environment,
        ).pipe(Effect.flip);
        expect(restored.detail).toContain("anthropic provider uses an endpoint or credential");
      }

      const widened = yield* OpenCodeRuntime.verifyOpenCodeProxyRouting(
        clientWith({ ...requested, enabled_providers: ["anthropic", "openai", "openrouter"] }),
        environment,
      ).pipe(Effect.flip);
      expect(widened.detail).toContain("enables providers the proxy does not route");

      const stalled = yield* OpenCodeRuntime.verifyOpenCodeProxyRouting(
        { config: { get: () => new Promise(() => {}) } } as unknown as OpencodeClient,
        environment,
      ).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("5 seconds");
      expect((yield* Fiber.join(stalled)).detail).toContain("Timed out");
    }),
  );
});

describe("resolveOpenCodeServerPassword", () => {
  it("uses the settings password when local settings and environment differ", () => {
    expect(
      OpenCodeRuntime.resolveOpenCodeServerPassword(
        {
          external: false,
          serverPassword: "settings-password",
          environment: { OPENCODE_SERVER_PASSWORD: "environment-password" },
        },
        {},
      ),
    ).toBe("settings-password");
  });

  it("does not send an inherited local password to an external server", () => {
    expect(
      OpenCodeRuntime.resolveOpenCodeServerPassword(
        { external: true, environment: { OPENCODE_SERVER_PASSWORD: "local-secret" } },
        { OPENCODE_SERVER_PASSWORD: "inherited-secret" },
      ),
    ).toBeUndefined();
  });
});

function makeHealthClient(
  result: (options?: { readonly signal?: AbortSignal }) => Promise<unknown>,
): OpencodeClient {
  return {
    global: {
      health: result,
    },
  } as unknown as OpencodeClient;
}

describe("verifyOpenCodeServerVersion", () => {
  effectIt.effect("rejects a server below the supported version", () =>
    Effect.gen(function* () {
      const error = yield* OpenCodeRuntime.verifyOpenCodeServerVersion(
        makeHealthClient(() => Promise.resolve({ data: { healthy: true, version: "1.14.18" } })),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(OpenCodeRuntime.OpenCodeRuntimeError);
      expect(error.detail).toContain("v1.14.18 is too old");
    }),
  );

  effectIt.effect("rejects a proxied server that cannot suppress its built-in plugins", () =>
    Effect.gen(function* () {
      const proxied = OpenCodeRuntime.applyOpenCodeProxyEnvironment(
        {},
        { url: "http://proxy:8317", apiKey: "sk" },
      );
      const error = yield* OpenCodeRuntime.verifyOpenCodeServerVersion(
        makeHealthClient(() => Promise.resolve({ data: { healthy: true, version: "1.14.48" } })),
        OpenCodeRuntime.minimumOpenCodeVersionFor(proxied),
      ).pipe(Effect.flip);
      expect(error.detail).toBe("OpenCode v1.14.48 is too old. Upgrade to v1.14.49 or newer.");
      expect(
        OpenCodeRuntime.minimumOpenCodeVersionFor({ OPENCODE_DISABLE_DEFAULT_PLUGINS: "1" }),
      ).toBe("1.14.19");
    }),
  );
});
