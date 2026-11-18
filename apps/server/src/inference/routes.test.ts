import { describe, expect, it } from "@effect/vitest";
import {
  inferencePath,
  inferenceTarget,
  modelsForDriver,
  needsAccountModelLookup,
  routeProvider,
  validateRouteUrl,
} from "./routes.ts";

describe("inference routes", () => {
  it("forwards only the protocol endpoints at the mounted path", () => {
    expect(inferencePath("POST", "/api/inference/v1/messages?beta=true")).toBe(
      "/v1/messages?beta=true",
    );
    expect(inferencePath("GET", "/api/inference/v1/models")).toBe("/v1/models");
    expect(inferenceTarget("GET", "/api/inference/linked/codex/host/health")).toEqual({
      path: "/health",
      environmentId: "host",
      driver: "codex",
    });
    expect(inferencePath("POST", "/api/inference/health")).toBeNull();
    expect(inferencePath("POST", "/api/inference/v1/chat/completions")).toBe(
      "/v1/chat/completions",
    );
    for (const path of [
      "/v0/management/auth-files",
      "/v1/messages/../models",
      "//somewhere.example",
      "/v1/responses?key=secret",
    ]) {
      expect(inferencePath("POST", "/api/inference" + path)).toBeNull();
    }
    expect(inferencePath("GET", "/api/inference/v1/messages")).toBeNull();
    expect(inferenceTarget("POST", "/api/inference/linked/codex/host/v1/responses")).toEqual({
      path: "/v1/responses",
      environmentId: "host",
      driver: "codex",
    });
    expect(inferenceTarget("POST", "/api/inference/linked/claudeAgent/host/v1/messages")).toEqual({
      path: "/v1/messages",
      environmentId: "host",
      driver: "claudeAgent",
    });
    expect(
      inferenceTarget("GET", "/api/inference/linked/host/v0/management/auth-files"),
    ).toBeNull();
    expect(inferenceTarget("POST", "/api/inference/linked/%ZZ/v1/messages")).toBeNull();
    expect(inferenceTarget("POST", "/api/inference/linked/host/v1/messages")).toBeNull();
  });

  it("accepts private LAN addresses and HTTPS tailnet routes and confines local keys to loopback", () => {
    expect(validateRouteUrl("https://pool.example.ts.net:9443/api/inference", false)).toBe(true);
    expect(validateRouteUrl("http://127.0.0.1:18001", true)).toBe(true);
    expect(validateRouteUrl("http://192.168.20.4:3773/api/inference", false)).toBe(true);
    for (const url of [
      "http://127.0.0.1:3000/api/inference",
      "http://169.254.169.254/api/inference",
      "http://8.8.8.8/api/inference",
      "http://127.0.0.1:18001",
      "http://office.ts.net/api/inference",
      "https://office.ts.net.attacker.com/api/inference",
      "https://x@office.ts.net/api/inference",
      "https://office.ts.net/api/inference?x=1",
    ]) {
      expect(validateRouteUrl(url, false)).toBe(false);
    }
  });

  it("keeps the proxy key out of launch arguments and config text for every harness", () => {
    const baseUrl = "https://office.example.ts.net/api/inference";
    const route = (models: string[], current: Record<string, string> = {}) => ({
      baseUrl,
      key: "private",
      models,
      homePath: "/state/home",
      current: (name: string) => current[name],
    });
    const codex = routeProvider(
      "codex",
      "Office",
      route(["gpt-fixture", "gpt-image-2.6", "gpt-fixture"]),
    );
    const claude = routeProvider("claudeAgent", "Office", route(["claude-fixture"]));
    const pi = routeProvider("pi", "Office", route(["grok-fixture"]));
    const openCode = routeProvider(
      "opencode",
      "Office",
      route(["grok-fixture"], {
        OPENCODE_CONFIG_CONTENT: `{
          // OpenCode accepts comments and trailing commas in this variable.
          "theme": "mine",
          "provider": { "own": {}, },
        }`,
      }),
    );
    expect(codex.config.launchArgs).toContain(baseUrl + "/v1");
    expect(codex.config.launchArgs).toContain("request_max_retries=0");
    expect(codex.config.customModels).toEqual(["gpt-fixture"]);
    expect(codex.config.launchArgs).not.toContain("private");
    expect(codex.environment).toContainEqual({
      name: "T3_INFERENCE_KEY",
      value: "private",
      sensitive: true,
    });
    expect(claude.environment).toContainEqual({
      name: "ANTHROPIC_AUTH_TOKEN",
      value: "private",
      sensitive: true,
    });
    expect(openCode.environment).toContainEqual({
      name: "T3_INFERENCE_KEY",
      value: "private",
      sensitive: true,
    });
    expect(pi.config).toEqual({});
    expect(pi.environment).toContainEqual({
      name: "T3_INFERENCE_KEY",
      value: "private",
      sensitive: true,
    });
    const piConfig = pi.environment.find((entry) => entry.name === "T3_PI_INFERENCE_CONFIG");
    expect(piConfig?.value).not.toContain("private");
    expect(JSON.parse(String(piConfig?.value))).toEqual({
      baseUrl: baseUrl + "/v1",
      models: ["grok-fixture"],
    });
    const content = openCode.environment.find((entry) => entry.name === "OPENCODE_CONFIG_CONTENT");
    expect(content?.value).not.toContain("private");
    expect(JSON.parse(String(content?.value))).toEqual({
      theme: "mine",
      provider: {
        own: {},
        t3proxy: {
          npm: "@ai-sdk/openai-compatible",
          name: "T3 inference",
          options: { baseURL: baseUrl + "/v1", apiKey: "{env:T3_INFERENCE_KEY}" },
          models: { "grok-fixture": { name: "grok-fixture" } },
        },
      },
    });
    expect(claude.displayName).toBe("Claude via Office");
    for (const raw of ['{"theme":', "[]", '{"provider":[]}']) {
      const invalid = routeProvider(
        "opencode",
        "Office",
        route(["grok-fixture"], { OPENCODE_CONFIG_CONTENT: raw }),
      );
      expect(invalid.environment).toContainEqual({
        name: "OPENCODE_CONFIG_CONTENT",
        value: raw,
        sensitive: false,
      });
      expect(invalid.environment.some((entry) => entry.name === "T3_INFERENCE_KEY")).toBe(false);
    }
  });

  it("gives each harness its supported advertised chat models only once", () => {
    const chatModels = [
      { id: "gpt-fixture", owned_by: "openai" },
      { id: "claude-fixture", owned_by: "anthropic" },
      { id: "grok-fixture", owned_by: "xai" },
      { id: "codex-pool-1", owned_by: "openai" },
      { id: "claude-pool-1", owned_by: "anthropic" },
    ];
    const models = [
      ...chatModels,
      { id: "gpt-fixture", owned_by: "openai" },
      { id: "gpt-image-2.6", owned_by: "openai" },
    ];
    expect(modelsForDriver(models, "codex")).toEqual(["gpt-fixture", "codex-pool-1"]);
    expect(modelsForDriver(models, "claudeAgent")).toEqual(["claude-fixture", "claude-pool-1"]);
    expect(modelsForDriver(models, "opencode")).toEqual([
      "gpt-fixture",
      "claude-fixture",
      "grok-fixture",
      "codex-pool-1",
      "claude-pool-1",
    ]);
    expect(modelsForDriver(models, "pi")).toEqual(chatModels.map((model) => model.id));
  });

  it("excludes an exhausted Claude account's models when only Codex remains available", () => {
    const now = Date.parse("2026-11-17T00:00:00.000Z");
    const models = [
      { id: "claude-sonnet", owned_by: "anthropic" },
      { id: "gpt-luna", owned_by: "openai" },
    ];
    const accounts = [
      { id: "claude", name: "claude.json", provider: "claude", status: "active" },
      { id: "codex", name: "codex.json", provider: "codex", status: "active" },
    ];
    expect(needsAccountModelLookup(accounts, new Set(), now)).toBe(false);
    expect(needsAccountModelLookup(accounts, new Set(["claude.json"]), now)).toBe(true);
    expect(
      modelsForDriver(models, "opencode", {
        accounts,
        excludedNames: new Set(["claude.json"]),
        registeredModels: new Map([["codex", ["gpt-luna"]]]),
        now,
      }),
    ).toEqual(["gpt-luna"]);
    expect(
      modelsForDriver(models, "opencode", {
        accounts,
        excludedNames: new Set(["claude.json"]),
        registeredModels: new Map(),
        now,
      }),
    ).toEqual(["gpt-luna"]);
    expect(
      modelsForDriver(models, "opencode", {
        accounts: [
          ...accounts,
          { id: "other-codex", name: "other-codex.json", provider: "codex", status: "error" },
        ],
        excludedNames: new Set(["claude.json"]),
        registeredModels: new Map(),
        now,
      }),
    ).toEqual([]);
    expect(
      modelsForDriver(models, "pi", {
        accounts,
        excludedNames: new Set(["claude.json"]),
        registeredModels: new Map([["codex", ["gpt-luna"]]]),
        now,
      }),
    ).toEqual(["gpt-luna"]);
  });

  it("keeps shared and aliased models when another account can serve them", () => {
    const now = Date.parse("2026-11-17T00:00:00.000Z");
    const catalog = [
      { id: "claude-sonnet", owned_by: "anthropic" },
      { id: "claude-alias", owned_by: "anthropic" },
    ];
    const accounts = [
      {
        id: "limited",
        name: "limited.json",
        status: "active",
        cooldowns: [
          { scope: "model", model_key: "claude-sonnet", retry_at: "2026-11-17T00:01:00Z" },
        ],
      },
      { id: "healthy", name: "healthy.json", status: "active", runtime_only: true },
    ];
    expect(needsAccountModelLookup(accounts, new Set(), now)).toBe(true);
    expect(
      modelsForDriver(catalog, "opencode", {
        accounts,
        excludedNames: new Set(),
        registeredModels: new Map([
          ["limited", ["claude-sonnet"]],
          ["healthy", ["claude-sonnet", "claude-alias"]],
        ]),
        now,
      }),
    ).toEqual(["claude-sonnet", "claude-alias"]);
    expect(
      modelsForDriver(catalog, "opencode", {
        accounts: [accounts[0]!],
        excludedNames: new Set(),
        registeredModels: new Map([["limited", ["claude-sonnet"]]]),
        now,
      }),
    ).toEqual([]);
  });
});
