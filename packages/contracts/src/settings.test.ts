import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ProviderInstanceId } from "./providerInstance.ts";
import {
  ClientSettingsPatch,
  ClientSettingsSchema,
  DEFAULT_CHAT_EXPORT_DETAIL_SETTINGS,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_CODE_FONT,
  DEFAULT_SIDEBAR_FONT_SIZE,
  DEFAULT_SERVER_SETTINGS,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

describe("ClientSettings.codeFont", () => {
  it("defaults to the existing monospace stack selection", () => {
    expect(DEFAULT_CLIENT_SETTINGS.codeFont).toBe(DEFAULT_CODE_FONT);
    expect(decodeClientSettings({}).codeFont).toBe(DEFAULT_CODE_FONT);
  });

  it("accepts known code font options in patches", () => {
    expect(decodeClientSettingsPatch({ codeFont: "jetbrains-mono" }).codeFont).toBe(
      "jetbrains-mono",
    );
  });

  it("rejects unknown code font options in patches", () => {
    expect(() => decodeClientSettingsPatch({ codeFont: "not-a-font" })).toThrow();
  });
});

describe("ClientSettings.sidebarFontSize", () => {
  it("defaults to the sidebar title font size", () => {
    expect(DEFAULT_CLIENT_SETTINGS.sidebarFontSize).toBe(DEFAULT_SIDEBAR_FONT_SIZE);
    expect(decodeClientSettings({}).sidebarFontSize).toBe(DEFAULT_SIDEBAR_FONT_SIZE);
  });

  it("accepts valid sidebar font size patches", () => {
    expect(decodeClientSettingsPatch({ sidebarFontSize: 13 }).sidebarFontSize).toBe(13);
  });

  it("rejects invalid sidebar font size patches", () => {
    expect(() => decodeClientSettingsPatch({ sidebarFontSize: 25 })).toThrow();
  });
});

describe("ServerSettings.providerInstances (slice-2 invariant)", () => {
  it("defaults chat exports to no configured directory", () => {
    expect(DEFAULT_SERVER_SETTINGS.chatExportDirectory).toBe("");
    expect(decodeServerSettings({}).chatExportDirectory).toBe("");
  });

  it("defaults chat exports to full detail", () => {
    expect(DEFAULT_SERVER_SETTINGS.chatExportDetail).toEqual(DEFAULT_CHAT_EXPORT_DETAIL_SETTINGS);
    expect(decodeServerSettings({}).chatExportDetail).toEqual({
      includeMetadata: true,
      includeToolCalls: true,
      includeDiffs: true,
      includePlans: true,
      includeQueuedTurns: true,
    });
  });

  it("defaults to an empty record so legacy configs without the key still decode", () => {
    expect(DEFAULT_SERVER_SETTINGS.providerInstances).toEqual({});
  });

  it("decodes a fully empty config (legacy on-disk shape) without complaint", () => {
    const decoded = decodeServerSettings({});
    expect(decoded.providerInstances).toEqual({});
    // Legacy `providers` struct is still hydrated with its per-driver defaults
    // so existing call sites keep working through the migration.
    expect(decoded.providers.codex.enabled).toBe(true);
  });

  it("decodes a multi-instance map mixing first-party and fork drivers", () => {
    const decoded = decodeServerSettings({
      providerInstances: {
        codex_personal: {
          driver: "codex",
          displayName: "Codex (personal)",
          config: { homePath: "~/.codex_personal" },
        },
        codex_work: {
          driver: "codex",
          config: { homePath: "~/.codex_work" },
        },
        ollama_local: {
          driver: "ollama",
          displayName: "Ollama (local)",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const personalId = ProviderInstanceId.make("codex_personal");
    const workId = ProviderInstanceId.make("codex_work");
    const ollamaId = ProviderInstanceId.make("ollama_local");

    expect(decoded.providerInstances[personalId]?.driver).toBe("codex");
    expect(decoded.providerInstances[workId]?.config).toEqual({ homePath: "~/.codex_work" });
    // Critical: a config naming a driver this build does not know about
    // (`ollama` is not in `ProviderDriverKind`) must round-trip without loss.
    // The runtime handles "driver not installed" — the schema must not.
    expect(decoded.providerInstances[ollamaId]?.driver).toBe("ollama");
    expect(decoded.providerInstances[ollamaId]?.config).toEqual({
      endpoint: "http://localhost:11434",
    });
  });

  it("rejects instance keys that violate the slug pattern", () => {
    expect(() =>
      decodeServerSettings({
        providerInstances: { "1bad": { driver: "codex" } },
      }),
    ).toThrow();
  });
});

describe("ServerSettingsPatch.providerInstances", () => {
  it("accepts chat export directory updates", () => {
    const patch = decodeServerSettingsPatch({ chatExportDirectory: "~/t3-exports" });
    expect(patch.chatExportDirectory).toBe("~/t3-exports");
  });

  it("accepts partial chat export detail updates", () => {
    const patch = decodeServerSettingsPatch({
      chatExportDetail: { includeToolCalls: false, includeDiffs: false },
    });
    expect(patch.chatExportDetail).toEqual({
      includeToolCalls: false,
      includeDiffs: false,
    });
  });

  it("treats providerInstances as an optional whole-map replacement", () => {
    const patch = decodeServerSettingsPatch({});
    expect(patch.providerInstances).toBeUndefined();

    const replacement = decodeServerSettingsPatch({
      providerInstances: {
        codex_personal: { driver: "codex", config: { homePath: "~/.codex" } },
      },
    });
    expect(replacement.providerInstances).toBeDefined();
    expect(replacement.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.driver).toBe(
      "codex",
    );
  });

  it("preserves a fork-defined driver entry through patch decoding", () => {
    const patch = decodeServerSettingsPatch({
      providerInstances: {
        ollama_local: {
          driver: "ollama",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const ollamaId = ProviderInstanceId.make("ollama_local");
    expect(patch.providerInstances?.[ollamaId]?.driver).toBe("ollama");
  });
});
