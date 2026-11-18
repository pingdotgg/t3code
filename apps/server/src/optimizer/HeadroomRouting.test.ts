// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  claudeSettingsRouteThroughHeadroom,
  inspectCodexHeadroomRouting,
  isHeadroomProxyUrl,
  resolveHeadroomSessionRouting,
} from "./HeadroomRouting.ts";

const decodeSettings = Schema.decodeSync(ServerSettings);
const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");

describe("HeadroomRouting", () => {
  it("accepts only the configured local proxy URL for each provider", () => {
    expect(isHeadroomProxyUrl("http://127.0.0.1:6767", "claudeAgent")).toBe(true);
    expect(isHeadroomProxyUrl("http://localhost:6767/v1/", "codex", "http://localhost:6767")).toBe(
      true,
    );
    expect(isHeadroomProxyUrl("http://127.0.0.1:6767/v1", "claudeAgent")).toBe(false);
    expect(isHeadroomProxyUrl("https://127.0.0.1:6767/v1", "codex")).toBe(false);
    expect(isHeadroomProxyUrl("http://127.0.0.1:8787/v1", "codex")).toBe(false);
    expect(isHeadroomProxyUrl("http://127.0.0.1:8787/v1", "codex", "http://127.0.0.1:8787/")).toBe(
      true,
    );
  });

  it("reads only Claude's settings env route", () => {
    expect(
      claudeSettingsRouteThroughHeadroom(
        '{"apiKey":"do-not-read","env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:6767"}}',
      ),
    ).toBe(true);
    expect(claudeSettingsRouteThroughHeadroom('{"env":{"ANTHROPIC_BASE_URL":"custom"}}')).toBe(
      false,
    );
    expect(claudeSettingsRouteThroughHeadroom("not json")).toBe(false);
  });

  it("reads Codex routing fields only from the root and headroom provider table", () => {
    const inspected = inspectCodexHeadroomRouting(`
model_provider = "headroom"
openai_base_url = "http://127.0.0.1:6767/v1"

[model_providers.headroom]
name = "Headroom"
base_url = "http://127.0.0.1:6767/v1"

[profiles.other]
model_provider = "other"
`);

    expect(inspected).toEqual({
      modelProvider: "headroom",
      openAiBaseUrl: "http://127.0.0.1:6767/v1",
      headroomBaseUrl: "http://127.0.0.1:6767/v1",
      cpaBaseUrl: undefined,
    });
  });

  it.effect("builds process-local launch settings for first-party Codex and Claude", () =>
    Effect.gen(function* () {
      const codexHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "headroom-codex-"));
      const claudeHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "headroom-claude-"));
      try {
        const settings = decodeSettings({
          headroomProxyUrl: "http://127.0.0.1:8787",
          providerInstances: {
            codex_work: { driver: "codex", config: { homePath: codexHome } },
            claude_work: { driver: "claudeAgent", config: { homePath: claudeHome } },
          },
        });

        expect(
          yield* resolveHeadroomSessionRouting({
            provider: codex,
            providerInstanceId: ProviderInstanceId.make("codex_work"),
            settings,
            environment: {},
          }),
        ).toEqual({
          environment: {
            HEADROOM_ACTIVE: "1",
            HEADROOM_PROXY_URL: "http://127.0.0.1:8787",
            OPENAI_BASE_URL: "http://127.0.0.1:8787/v1",
          },
          codexConfig: { openai_base_url: "http://127.0.0.1:8787/v1" },
        });
        expect(
          yield* resolveHeadroomSessionRouting({
            provider: claude,
            providerInstanceId: ProviderInstanceId.make("claude_work"),
            settings,
            environment: {},
          }),
        ).toEqual({
          environment: {
            HEADROOM_ACTIVE: "1",
            HEADROOM_PROXY_URL: "http://127.0.0.1:8787",
            ANTHROPIC_BASE_URL: "http://127.0.0.1:8787",
          },
        });
      } finally {
        NodeFS.rmSync(codexHome, { recursive: true, force: true });
        NodeFS.rmSync(claudeHome, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves explicit custom upstreams and cloud Claude sessions unchanged", () =>
    Effect.gen(function* () {
      const codexHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "headroom-codex-"));
      const claudeHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "headroom-claude-"));
      try {
        NodeFS.writeFileSync(
          NodePath.join(codexHome, "config.toml"),
          [
            'model_provider = "gateway"',
            "[model_providers.gateway]",
            'base_url = "https://gateway.example.test/v1"',
          ].join("\n"),
        );
        NodeFS.writeFileSync(
          NodePath.join(claudeHome, "settings.json"),
          '{"env":{"ANTHROPIC_BASE_URL":"https://gateway.example.test"}}',
        );
        const settings = decodeSettings({
          providerInstances: {
            codex_work: { driver: "codex", config: { homePath: codexHome } },
            claude_work: { driver: "claudeAgent", config: { homePath: claudeHome } },
          },
        });
        expect(
          yield* resolveHeadroomSessionRouting({
            provider: codex,
            providerInstanceId: ProviderInstanceId.make("codex_work"),
            settings,
            environment: {},
          }),
        ).toBeUndefined();
        expect(
          yield* resolveHeadroomSessionRouting({
            provider: claude,
            providerInstanceId: ProviderInstanceId.make("claude_work"),
            settings,
            environment: {},
          }),
        ).toBeUndefined();
        expect(
          yield* resolveHeadroomSessionRouting({
            provider: claude,
            providerInstanceId: ProviderInstanceId.make("claudeAgent"),
            settings,
            environment: { CLAUDE_CODE_USE_BEDROCK: "1" },
          }),
        ).toBeUndefined();
      } finally {
        NodeFS.rmSync(codexHome, { recursive: true, force: true });
        NodeFS.rmSync(claudeHome, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves an existing matching Codex Headroom provider route", () =>
    Effect.gen(function* () {
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "headroom-codex-"));
      try {
        NodeFS.writeFileSync(
          NodePath.join(home, "config.toml"),
          [
            'model_provider = "headroom"',
            "[model_providers.headroom]",
            'base_url = "http://127.0.0.1:6767/v1"',
          ].join("\n"),
        );
        const settings = decodeSettings({
          providerInstances: {
            codex_work: { driver: "codex", config: { homePath: home } },
          },
        });

        expect(
          yield* resolveHeadroomSessionRouting({
            provider: codex,
            providerInstanceId: ProviderInstanceId.make("codex_work"),
            settings,
            environment: {},
          }),
        ).toEqual({
          environment: {
            HEADROOM_ACTIVE: "1",
            HEADROOM_PROXY_URL: "http://127.0.0.1:6767",
          },
        });
      } finally {
        NodeFS.rmSync(home, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("chains through Headroom when the CLI configs route to CLIProxyAPI", () =>
    Effect.gen(function* () {
      const codexHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "headroom-codex-"));
      const claudeHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "headroom-claude-"));
      try {
        NodeFS.writeFileSync(
          NodePath.join(codexHome, "config.toml"),
          [
            'model_provider = "cpa"',
            "[model_providers.cpa]",
            'base_url = "http://127.0.0.1:8317/v1"',
          ].join("\n"),
        );
        NodeFS.writeFileSync(
          NodePath.join(claudeHome, "settings.json"),
          '{"apiKeyHelper":"cat ~/.config/cpa/key","env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:8317"}}',
        );
        const providerInstances = {
          codex_work: { driver: "codex", config: { homePath: codexHome } },
          claude_work: { driver: "claudeAgent", config: { homePath: claudeHome } },
        };
        const settings = decodeSettings({ providerInstances });
        expect(
          yield* resolveHeadroomSessionRouting({
            provider: codex,
            providerInstanceId: ProviderInstanceId.make("codex_work"),
            settings,
            environment: {},
          }),
        ).toEqual({
          environment: { HEADROOM_ACTIVE: "1", HEADROOM_PROXY_URL: "http://127.0.0.1:6767" },
          codexConfig: { "model_providers.cpa.base_url": "http://127.0.0.1:6767/v1" },
        });
        expect(
          yield* resolveHeadroomSessionRouting({
            provider: claude,
            providerInstanceId: ProviderInstanceId.make("claude_work"),
            settings,
            environment: {},
          }),
        ).toEqual({
          environment: {
            HEADROOM_ACTIVE: "1",
            HEADROOM_PROXY_URL: "http://127.0.0.1:6767",
            ANTHROPIC_BASE_URL: "http://127.0.0.1:6767",
          },
          claudeBaseUrl: "http://127.0.0.1:6767",
        });
        // A CLIProxyAPI on another port is just a custom upstream.
        const elsewhere = decodeSettings({
          providerInstances,
          cpa: { url: "http://127.0.0.1:9999" },
        });
        expect(
          yield* resolveHeadroomSessionRouting({
            provider: claude,
            providerInstanceId: ProviderInstanceId.make("claude_work"),
            settings: elsewhere,
            environment: {},
          }),
        ).toBeUndefined();
      } finally {
        NodeFS.rmSync(codexHome, { recursive: true, force: true });
        NodeFS.rmSync(claudeHome, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
