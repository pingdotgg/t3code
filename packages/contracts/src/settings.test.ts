import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";
import {
  ClientSettingsSchema,
  ClientSettingsPatch,
  DEFAULT_SERVER_SETTINGS,
  HermesAcpSettings,
  HermesSettings,
  OpenClawSettings,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const decodeHermesSettings = Schema.decodeUnknownSync(HermesSettings);
const decodeHermesAcpSettings = Schema.decodeUnknownSync(HermesAcpSettings);
const decodeOpenClawSettings = Schema.decodeUnknownSync(OpenClawSettings);

describe("ClientSettings word wrap", () => {
  it("defaults word wrap on", () => {
    expect(decodeClientSettings({}).wordWrap).toBe(true);
  });

  it("ignores obsolete wrapping preferences", () => {
    const decoded = decodeClientSettings({
      chatWordWrap: false,
      diffWordWrap: false,
    });

    expect(decoded.wordWrap).toBe(true);
    expect(decoded).not.toHaveProperty("chatWordWrap");
    expect(decoded).not.toHaveProperty("diffWordWrap");
  });
});

describe("ClientSettings glass opacity", () => {
  it("defaults to a readable translucent surface", () => {
    expect(decodeClientSettings({}).glassOpacity).toBe(80);
  });

  it.each([39, 101, 72.5])("rejects an invalid glass opacity: %s", (value) => {
    expect(() => decodeClientSettings({ glassOpacity: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ glassOpacity: value })).toThrow();
  });

  it.each([40, 75, 100])("accepts a glass opacity within the supported range: %s", (value) => {
    expect(decodeClientSettings({ glassOpacity: value }).glassOpacity).toBe(value);
    expect(decodeClientSettingsPatch({ glassOpacity: value }).glassOpacity).toBe(value);
  });
});

describe("ClientSettings sidebar v2", () => {
  it("defaults the beta off with a three-day auto-settle threshold", () => {
    const settings = decodeClientSettings({});
    expect(settings.sidebarV2Enabled).toBe(false);
    expect(settings.sidebarAutoSettleAfterDays).toBe(3);
  });

  it("allows auto-settle by inactivity to be disabled", () => {
    expect(
      decodeClientSettings({ sidebarAutoSettleAfterDays: null }).sidebarAutoSettleAfterDays,
    ).toBeNull();
  });

  it.each([-1, 0, 91])("rejects an auto-settle threshold outside 1..90: %s", (value) => {
    expect(() => decodeClientSettings({ sidebarAutoSettleAfterDays: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ sidebarAutoSettleAfterDays: value })).toThrow();
  });
});

describe("ServerSettings.providerInstances (slice-2 invariant)", () => {
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

describe("ServerSettings Hermes rollout", () => {
  it("defaults the global feature off and accepts an explicit instance envelope", () => {
    expect(decodeServerSettings({}).enableHermes).toBe(false);
    expect(decodeServerSettings({}).enableRemoteHermes).toBe(false);
    expect(decodeServerSettingsPatch({ enableHermes: true }).enableHermes).toBe(true);
    expect(decodeServerSettingsPatch({ enableRemoteHermes: true }).enableRemoteHermes).toBe(true);
    expect(
      decodeServerSettingsPatch({
        providers: { hermes: { managedServerEnabled: false } },
      }).providers?.hermes?.managedServerEnabled,
    ).toBe(false);

    const decoded = decodeServerSettings({
      enableHermes: true,
      providerInstances: {
        hermes_local: {
          driver: "hermes",
          enabled: true,
          environment: [
            {
              name: "HERMES_GATEWAY_TOKEN",
              value: "",
              sensitive: true,
              valueRedacted: true,
            },
          ],
          config: {
            endpoint: "ws://127.0.0.1:9119/api/ws",
            profileKey: "real-profile",
          },
        },
      },
    });

    expect(decoded.providerInstances[ProviderInstanceId.make("hermes_local")]).toMatchObject({
      driver: "hermes",
      enabled: true,
      config: {
        endpoint: "ws://127.0.0.1:9119/api/ws",
        profileKey: "real-profile",
      },
    });
    expect(decoded.providers.hermes).toEqual({
      enabled: false,
      endpoint: "",
      remoteAccessEnabled: false,
      profileKey: "default",
      managedServerEnabled: true,
      customModels: [],
      importEnabled: false,
      mcpEnabled: true,
      attachmentsEnabled: true,
      proactiveEnabled: false,
      voiceEnabled: false,
    });
  });

  it("accepts dormant encrypted remote configuration but rejects plaintext or credentials", () => {
    expect(
      decodeHermesSettings({
        endpoint: "wss://gateway.example.com/api/ws",
        profileKey: "profile",
      }),
    ).toMatchObject({
      endpoint: "wss://gateway.example.com/api/ws",
      remoteAccessEnabled: false,
    });
    expect(() =>
      decodeHermesSettings({
        endpoint: "ws://gateway.example.com/api/ws",
        profileKey: "profile",
      }),
    ).toThrow();
    expect(() =>
      decodeHermesSettings({
        endpoint: "ws://127.0.0.1:9119/api/ws?token=plain-text-secret",
        profileKey: "profile",
      }),
    ).toThrow();
  });
});

describe("Hermes in Code ACP settings", () => {
  it("defaults to the real Hermes ACP executable boundary", () => {
    expect(decodeHermesAcpSettings({})).toEqual({
      enabled: true,
      binaryPath: "hermes",
      customModels: [],
    });
  });

  it("preserves an explicit executable and custom model list", () => {
    expect(
      decodeHermesAcpSettings({
        binaryPath: "/opt/hermes/bin/hermes",
        customModels: ["openrouter/model"],
      }),
    ).toMatchObject({
      binaryPath: "/opt/hermes/bin/hermes",
      customModels: ["openrouter/model"],
    });
  });
});

describe("OpenClaw ACP settings", () => {
  it("defaults to OpenClaw's normal config and environment boundary", () => {
    expect(decodeOpenClawSettings({})).toEqual({
      enabled: true,
      binaryPath: "openclaw",
      url: "",
      tokenFile: "",
      passwordFile: "",
      session: "",
      resetSession: false,
      customModels: [],
    });
  });

  it("accepts file-based authentication and gateway session overrides", () => {
    expect(
      decodeOpenClawSettings({
        url: "wss://gateway.example.com",
        tokenFile: "/run/secrets/openclaw-token",
        passwordFile: "/run/secrets/openclaw-password",
        session: "agent:main:main",
        resetSession: true,
      }),
    ).toMatchObject({
      url: "wss://gateway.example.com",
      tokenFile: "/run/secrets/openclaw-token",
      passwordFile: "/run/secrets/openclaw-password",
      session: "agent:main:main",
      resetSession: true,
    });
  });

  it("rejects credentials embedded in the Gateway URL", () => {
    expect(() =>
      decodeOpenClawSettings({
        url: "wss://gateway.example.com?token=plain-text-secret",
      }),
    ).toThrow();
    expect(() =>
      decodeOpenClawSettings({
        url: "wss://user:password@gateway.example.com",
      }),
    ).toThrow();
  });
});

describe("ServerSettings worktree defaults", () => {
  it("defaults start-from-origin on for legacy configs", () => {
    expect(decodeServerSettings({}).newWorktreesStartFromOrigin).toBe(true);
  });

  it("accepts start-from-origin updates", () => {
    expect(
      decodeServerSettingsPatch({ newWorktreesStartFromOrigin: false }).newWorktreesStartFromOrigin,
    ).toBe(false);
  });
});

describe("ServerSettings Cursor legacy settings", () => {
  it("ignores obsolete Cursor CLI settings when reading server settings", () => {
    const decoded = decodeServerSettings({
      providers: {
        cursor: {
          enabled: true,
          binaryPath: "cursor-agent",
          apiEndpoint: "http://127.0.0.1:3774",
        },
      },
    });

    expect(decoded.providers.cursor.enabled).toBe(true);
    expect(decoded.providers.cursor).not.toHaveProperty("binaryPath");
    expect(decoded.providers.cursor).not.toHaveProperty("apiEndpoint");
  });

  it("ignores obsolete Cursor CLI settings in patches", () => {
    const patch = decodeServerSettingsPatch({
      providers: {
        cursor: {
          enabled: true,
          binaryPath: "cursor-agent",
          apiEndpoint: "http://127.0.0.1:3774",
        },
      },
    });

    expect(patch.providers?.cursor?.enabled).toBe(true);
    expect(patch.providers?.cursor).not.toHaveProperty("binaryPath");
    expect(patch.providers?.cursor).not.toHaveProperty("apiEndpoint");
  });
});

describe("ServerSettingsPatch.providerInstances", () => {
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

describe("ServerSettingsPatch string normalization", () => {
  it("trims string settings while decoding patches", () => {
    const patch = decodeServerSettingsPatch({
      addProjectBaseDirectory: "  ~/Development  ",
      textGenerationModelSelection: { model: "  gpt-5.4-mini  " },
      observability: {
        otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
      },
      providers: {
        codex: {
          binaryPath: "  /opt/homebrew/bin/codex  ",
          homePath: "  ~/.codex  ",
          launchArgs: "  --strict-config --enable foo  ",
        },
      },
      providerInstances: {
        codex_personal: {
          driver: "  codex  ",
          displayName: "  Codex Personal  ",
          config: { homePath: "  ~/.codex-personal  " },
        },
      },
    });

    expect(patch.addProjectBaseDirectory).toBe("~/Development");
    expect(patch.textGenerationModelSelection?.model).toBe("gpt-5.4-mini");
    expect(patch.observability?.otlpTracesUrl).toBe("http://localhost:4318/v1/traces");
    expect(patch.providers?.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
    expect(patch.providers?.codex?.homePath).toBe("~/.codex");
    expect(patch.providers?.codex?.launchArgs).toBe("--strict-config --enable foo");
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.driver).toBe(
      "codex",
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.displayName).toBe(
      "Codex Personal",
    );
    expect(patch.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.config).toEqual({
      homePath: "  ~/.codex-personal  ",
    });
  });

  it("trims encoded server settings values before validation", () => {
    const defaultSettings = decodeServerSettings({});
    const encoded = encodeServerSettings({
      ...defaultSettings,
      addProjectBaseDirectory: "  ~/Development  ",
      providers: {
        ...defaultSettings.providers,
        codex: {
          ...defaultSettings.providers.codex,
          binaryPath: "  /opt/homebrew/bin/codex  ",
          launchArgs: "  --strict-config  ",
        },
      },
    });

    expect(encoded.addProjectBaseDirectory).toBe("~/Development");
    expect(encoded.providers?.codex?.binaryPath).toBe("/opt/homebrew/bin/codex");
    expect(encoded.providers?.codex?.launchArgs).toBe("--strict-config");
  });
});
