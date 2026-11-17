import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { type CommandId, ProjectId } from "./baseSchemas.ts";
import {
  ProviderDriverKind,
  ProviderInstanceEnvironment,
  ProviderInstanceId,
} from "./providerInstance.ts";
import {
  ClientSettingsSchema,
  ClientSettingsPatch,
  ClientServerSettingsPatch,
  ClaudeSettings,
  CodexSettings,
  DEFAULT_SERVER_SETTINGS,
  LegacyClientSettings,
  globalIdleCompaction,
  idleCompactionPatch,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  requiredScopesForProjectMutation,
  resolveIdleCompaction,
  resolveProjectProviderInstanceEnabled,
  resolveProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsPatch,
  withIdleCompaction,
} from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const encodeProviderInstanceEnvironment = Schema.encodeSync(ProviderInstanceEnvironment);
const decodeProviderInstanceEnvironment = Schema.decodeSync(ProviderInstanceEnvironment);
// The environment variable shape builds released before secret references decode.
const decodeStringOnlyEnvironment = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({ name: Schema.String, value: Schema.String, sensitive: Schema.Boolean }),
  ),
);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const decodeClientServerSettingsPatch = Schema.decodeUnknownSync(ClientServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const encodeServerSettingsPatch = Schema.encodeSync(ServerSettingsPatch);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);

describe("ServerSettings completion audio", () => {
  it("defaults older settings to Off and preserves the environment sound settings", () => {
    expect(decodeServerSettings({}).completionAudio).toEqual({
      defaultMode: "off",
      tone: "completion",
      volume: 1,
    });
    const completionAudio = { defaultMode: "sound", tone: "input", volume: 0.25 };
    expect(encodeServerSettings(decodeServerSettings({ completionAudio }))).toMatchObject({
      completionAudio,
    });
    expect(decodeServerSettingsPatch({ completionAudio })).toEqual({ completionAudio });
  });

  it.each([-0.1, 1.1, NaN, Infinity, -Infinity])("rejects completion volume %s", (volume) => {
    const completionAudio = { defaultMode: "sound", tone: "completion", volume };
    expect(() => decodeServerSettings({ completionAudio })).toThrow();
    expect(() => decodeServerSettingsPatch({ completionAudio })).toThrow();
  });
});

describe("ServerSettings delegation tiers", () => {
  it("decodes an empty default for older settings files", () => {
    expect(decodeServerSettings({}).delegationTiers).toEqual({
      small: [],
      medium: [],
      large: [],
    });
  });

  it("round-trips ordered tier candidates through settings and patches", () => {
    const delegationTiers = {
      small: [{ providerInstanceId: "codex", model: "gpt-5.4" }],
      medium: [],
      large: [
        {
          providerInstanceId: "claudeAgent",
          model: "claude-opus-4-6",
          minHeadroomPercent: 20,
        },
      ],
    };
    expect(encodeServerSettings(decodeServerSettings({ delegationTiers }))).toMatchObject({
      delegationTiers,
    });
    expect(decodeServerSettingsPatch({ delegationTiers })).toEqual({ delegationTiers });
  });
});

describe("CodexSettings maximum concurrent subagents", () => {
  it("defaults to Codex's concurrency and accepts legacy settings with a cap", () => {
    expect(decodeCodexSettings({}).maxConcurrentSubagents).toBe("");
    expect(decodeCodexSettings({ maxConcurrentSubagents: "20" }).maxConcurrentSubagents).toBe("20");
  });

  it.each(["0", "-1", "1.5", "1e3", "9007199254740992"])(
    "rejects an invalid concurrency count: %s",
    (value) => {
      expect(() => decodeCodexSettings({ maxConcurrentSubagents: value })).toThrow();
    },
  );

  it("trims and accepts an empty patch value to clear the override", () => {
    expect(decodeCodexSettings({ maxConcurrentSubagents: " 20 " })).toMatchObject({
      maxConcurrentSubagents: "20",
    });
    expect(decodeCodexSettings({ maxConcurrentSubagents: "  " })).toMatchObject({
      maxConcurrentSubagents: "",
    });
  });
});

describe("ServerSettings optimizer configuration", () => {
  it("defaults omitted optimizer settings without changing existing settings files", () => {
    const settings = decodeServerSettings({
      projectOptimizerOverrides: {
        "project-one": { rtk: true },
      },
    });

    expect(settings.projectOptimizerOverrides).toEqual({
      "project-one": { rtk: true, headroom: false, cbm: false },
    });
    expect(settings.optimizerBinaryPaths.cbm).toBe("codebase-memory-mcp");
    expect(settings.headroomProxyUrl).toBe("http://127.0.0.1:6767");
  });

  it("accepts partial optimizer patches and CBM path overrides", () => {
    expect(
      decodeServerSettingsPatch({
        projectOptimizerOverrides: {
          "project-one": { cbm: true },
          "project-two": null,
        },
        optimizerBinaryPaths: { cbm: "  /opt/cbm  " },
      }),
    ).toEqual({
      projectOptimizerOverrides: {
        "project-one": { cbm: true },
        "project-two": null,
      },
      optimizerBinaryPaths: { cbm: "/opt/cbm" },
    });
  });

  it.each([
    "http://127.0.0.1:8787",
    "http://127.0.0.1:8787/",
    "http://localhost:8787",
    "http://[::1]:8787",
  ])("accepts a local Headroom proxy origin: %s", (headroomProxyUrl) => {
    expect(decodeServerSettingsPatch({ headroomProxyUrl }).headroomProxyUrl).toBe(headroomProxyUrl);
  });

  it.each([
    "https://127.0.0.1:8787",
    "http://192.168.1.10:8787",
    "http://example.com:8787",
    "http://user@127.0.0.1:8787",
    "http://127.0.0.1:8787/stats",
    "http://127.0.0.1:8787?mode=cache",
    "http://127.0.0.1:8787#status",
  ])("rejects an unsafe Headroom proxy URL: %s", (headroomProxyUrl) => {
    expect(() => decodeServerSettingsPatch({ headroomProxyUrl })).toThrow();
  });
});

it("drops theme defaults from a client's settings patch", () => {
  expect(
    decodeClientServerSettingsPatch({
      newWorktreesStartFromOrigin: false,
      defaultTheme: "grove",
      defaultThemeSetAt: "2026-11-13T00:00:00.000Z",
      defaultAppearance: "dark",
      defaultAppearanceSetAt: "2026-11-13T00:00:00.000Z",
    }),
  ).toEqual({ newWorktreesStartFromOrigin: false });
});

describe("storage cleanup settings", () => {
  it("keeps cleanup disabled for existing installations", () => {
    expect(decodeServerSettings({}).worktreeCleanup).toBeNull();
    expect(decodeServerSettings({}).storageCleanup).toEqual({
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
      worktreeKeepWhen: "uncommitted-changes",
      browserArtifactsAfterDays: null,
      logsAfterDays: null,
    });
  });

  it("accepts partial custom patches but requires complete stored project rules", () => {
    expect(
      decodeServerSettingsPatch({
        worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } },
      }),
    ).toEqual({ worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } } });
    expect(() =>
      decodeServerSettings({
        projectSettingsOverrides: {
          project: { worktreeCleanup: { mode: "custom", rules: { worktreeAfterDays: 8 } } },
        },
      }),
    ).toThrow();
    expect(
      decodeServerSettings({
        projectSettingsOverrides: {
          project: {
            worktreeCleanup: {
              mode: "custom",
              rules: {
                worktreeAfterDays: null,
                worktreeOnMerge: false,
                worktreeOnDelete: false,
                worktreeUnchanged: false,
              },
            },
          },
        },
      }).projectSettingsOverrides[ProjectId.make("project")]?.worktreeCleanup,
    ).toMatchObject({
      mode: "custom",
      rules: { worktreeSettledAfterDays: null, worktreeKeepWhen: "uncommitted-changes" },
    });
  });

  it("decodes older custom rules with the default local-file policy", () => {
    const settings = decodeServerSettings({
      worktreeCleanup: {
        mode: "custom",
        rules: {
          worktreeAfterDays: 8,
          worktreeOnMerge: false,
          worktreeOnDelete: false,
          worktreeUnchanged: false,
        },
      },
    });
    expect(settings.worktreeCleanup).toMatchObject({
      rules: { worktreeKeepWhen: "uncommitted-changes" },
    });
    expect(
      decodeServerSettingsPatch({ storageCleanup: { worktreeKeepWhen: "tracked-changes" } }),
    ).toEqual({ storageCleanup: { worktreeKeepWhen: "tracked-changes" } });
    expect(() =>
      decodeServerSettingsPatch({ storageCleanup: { worktreeKeepWhen: "unknown" } }),
    ).toThrow();
  });
});

describe("ServerSettings provider model defaults", () => {
  it("decodes fork defaults into providerModelPreferences and defaults older entries", () => {
    const codex = ProviderInstanceId.make("codex");
    const claudeAgent = ProviderInstanceId.make("claudeAgent");
    const decoded = decodeServerSettings({
      providerModelPreferences: {
        codex: {
          hiddenModels: ["gpt-old"],
          modelOrder: ["gpt-5.6-sol"],
          defaultModel: "gpt-5.6-sol",
          defaultOptions: [{ id: "reasoningEffort", value: "high" }],
        },
        claudeAgent: { hiddenModels: [], modelOrder: [] },
      },
    });

    expect(decoded.providerModelPreferences?.[codex]).toEqual({
      hiddenModels: ["gpt-old"],
      modelOrder: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      defaultOptions: [{ id: "reasoningEffort", value: "high" }],
    });
    expect(decoded.providerModelPreferences?.[claudeAgent]).toEqual({
      hiddenModels: [],
      modelOrder: [],
      defaultModel: null,
      defaultOptions: [],
    });
    expect(encodeServerSettings(decoded).providerModelPreferences).toMatchObject({
      codex: { defaultModel: "gpt-5.6-sol" },
    });
    expect(decodeServerSettings({}).providerModelPreferences).toBeNull();
    expect(
      decodeServerSettingsPatch({
        providerModelPreferences: { codex: { hiddenModels: ["gpt-old"], modelOrder: [] } },
      }).providerModelPreferences,
    ).toMatchObject({ codex: { hiddenModels: ["gpt-old"] } });
  });

  it("keeps saved client preferences decodable for environment migration", () => {
    const decoded = decodeClientSettings({});
    expect(decoded.providerModelPreferences).toEqual({});
    const decodeLegacyClientSettings = Schema.decodeSync(LegacyClientSettings);
    const legacy = decodeLegacyClientSettings({
      providerModelPreferences: { codex: { hiddenModels: ["gpt-old"], modelOrder: [] } },
    });
    expect(legacy.providerModelPreferences?.[ProviderInstanceId.make("codex")]).toMatchObject({
      hiddenModels: ["gpt-old"],
    });
    expect(decodeLegacyClientSettings({}).providerModelPreferences).toEqual({});
  });
});

describe("ClientSettings terminal close confirmation", () => {
  it("keeps confirmation enabled for settings without a saved preference", () => {
    expect(decodeClientSettings({}).confirmTerminalClose).toBe(true);
  });
});

describe("ServerSettings usage price overrides", () => {
  const prices = { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 };

  it("rejects empty model IDs and incomplete input/output pricing", () => {
    for (const usagePriceOverrides of [
      { " ": prices },
      { "example-model": { inputCostPerMillionTokens: 2 } },
      { "example-model": { outputCostPerMillionTokens: 8 } },
    ]) {
      expect(() => decodeServerSettingsPatch({ usagePriceOverrides })).toThrow();
    }
  });

  it("ignores an invalid model filter without dropping the other settings", () => {
    const valid = { include: [{ provider: "newer-provider", model: "orbit-1" }] };
    expect(decodeServerSettings({ usageModelFilter: valid }).usageModelFilter).toEqual(valid);
    const settings = decodeServerSettings({
      usageModelFilter: { exclude: [{ model: "" }] },
      usageModelAliases: { "drift-9": "orbit-1" },
    });
    expect(settings.usageModelFilter).toBeUndefined();
    expect(settings.usageModelAliases).toEqual({ "drift-9": "orbit-1" });
  });
});

it("drops a hand-edited non-string hidden tag and keeps the rest of the settings", () => {
  const settings = decodeServerSettings({
    hiddenThreadTags: ["private", 123],
    hideTaggedThreads: true,
  });
  expect(settings.hiddenThreadTags).toEqual(["private"]);
  expect(settings.hideTaggedThreads).toBe(true);
});

describe("ServerSettings secret providers", () => {
  const onePassword = (account: string) => ({
    kind: "one_password",
    label: "Personal",
    config: { account },
  });

  it("keeps an unknown kind or a longer label from invalidating the rest of the settings", () => {
    const openbao = { kind: "openbao", label: "V".repeat(65), config: { address: "https://x" } };
    const decoded = decodeServerSettings({
      worktreesDirectory: "/work",
      secretProviders: { vault: openbao, personal: onePassword("my.1password.com") },
    });
    expect(decoded.worktreesDirectory).toBe("/work");
    expect(encodeServerSettings(decoded).secretProviders).toEqual({
      vault: openbao,
      personal: onePassword("my.1password.com"),
    });
  });

  it("accepts slug ids and null removals but no id that is not a slug", () => {
    expect(
      decodeServerSettingsPatch({
        secretProviders: { "1password": onePassword("my.1password.com"), work: null },
      }).secretProviders,
    ).toEqual({ "1password": onePassword("my.1password.com"), work: null });
    for (const id of ["", "My Vault", "a/b", "-vault"]) {
      expect(() =>
        decodeServerSettingsPatch({ secretProviders: { [id]: onePassword("my.1password.com") } }),
      ).toThrow();
    }
    expect(() =>
      decodeServerSettingsPatch({
        secretProviders: { work: { ...onePassword("my.1password.com"), label: "V".repeat(65) } },
      }),
    ).toThrow();
  });

  it("stores a provider environment secret reference in a layout older builds still decode", () => {
    const providerInstances = (secret: unknown) => ({
      codex: {
        driver: "codex",
        environment: [
          { name: "OPENAI_API_KEY", sensitive: true, value: "", secret },
          { name: "BASE_URL", value: "https://example.test" },
        ],
      },
    });
    const secret = { provider: "personal", reference: "op://Private/OpenAI/credential" };
    const environment = decodeServerSettings({ providerInstances: providerInstances(secret) })
      .providerInstances[ProviderInstanceId.make("codex")]?.environment;
    expect(environment).toEqual([
      { name: "OPENAI_API_KEY", value: secret, sensitive: true },
      { name: "BASE_URL", value: "https://example.test", sensitive: false },
    ]);

    const encoded = encodeProviderInstanceEnvironment(environment ?? []);
    expect(encoded).toEqual([
      { name: "OPENAI_API_KEY", value: "", sensitive: true, secret },
      { name: "BASE_URL", value: "https://example.test", sensitive: false },
    ]);
    expect(decodeProviderInstanceEnvironment(encoded)).toEqual(environment);
    expect(decodeStringOnlyEnvironment(encoded)).toEqual([
      { name: "OPENAI_API_KEY", value: "", sensitive: true },
      { name: "BASE_URL", value: "https://example.test", sensitive: false },
    ]);

    for (const invalid of [
      { provider: "My Vault", reference: "op://a/b/c" },
      { provider: "personal", reference: " " },
      { provider: "personal", reference: "op://Private/OpenAI\n/credential" },
      { provider: "personal", reference: "x".repeat(1025) },
    ]) {
      expect(() =>
        decodeServerSettings({ providerInstances: providerInstances(invalid) }),
      ).toThrow();
    }
  });
});

describe("custom model settings", () => {
  const capabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
      },
    ],
  };

  it("accepts legacy bare slugs alongside full entries", () => {
    const decoded = decodeClaudeSettings({
      customModels: ["bare-slug", { slug: "named", name: "Named", capabilities }],
    });
    expect(decoded.customModels).toEqual([
      "bare-slug",
      { slug: "named", name: "Named", capabilities },
    ]);
  });
});

describe("resolveIdleCompaction", () => {
  it("lets a Claude instance override the global default", () => {
    const settings = decodeServerSettings({
      idleCompaction: "off",
      providerInstances: {
        claude_work: { driver: "claudeAgent", config: { idleCompaction: "onReturn" } },
        claude_personal: { driver: "claudeAgent" },
      },
    });
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claude_work"))).toBe(
      "onReturn",
    );
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claude_personal"))).toBe("off");
    expect(resolveIdleCompaction(settings, ProviderInstanceId.make("claudeAgent"))).toBe("off");
  });

  it("reads the mode from the legacy switch, in either form servers saved it", () => {
    expect(globalIdleCompaction(decodeServerSettings({ compactIdleThreads: true }))).toBe(
      "beforeCacheExpires",
    );
    expect(globalIdleCompaction(decodeServerSettings({ compactIdleThreads: "off" }))).toBe("off");
    expect(globalIdleCompaction(decodeServerSettings({}))).toBe("onReturn");
  });

  it("keeps the legacy switch a boolean, as shipped clients decode it", () => {
    const encode = Schema.encodeSync(Schema.toCodecJson(ServerSettings));
    for (const mode of ["onReturn", "beforeCacheExpires", "off"] as const) {
      const encoded = encode(withIdleCompaction(DEFAULT_SERVER_SETTINGS, mode)) as {
        readonly compactIdleThreads: unknown;
        readonly idleCompaction: unknown;
      };
      expect(encoded.compactIdleThreads).toBe(mode === "beforeCacheExpires");
      expect(encoded.idleCompaction).toBe(mode);
    }
  });

  it("patches the field the server reads", () => {
    expect(
      idleCompactionPatch({ compactIdleThreads: false, idleCompaction: "onReturn" }, "off"),
    ).toEqual({
      idleCompaction: "off",
    });
    expect(idleCompactionPatch({ compactIdleThreads: "onReturn" }, "off")).toEqual({
      compactIdleThreads: "off",
    });
    expect(idleCompactionPatch({ compactIdleThreads: false }, "beforeCacheExpires")).toEqual({
      compactIdleThreads: true,
    });
  });
});

describe("ClientSettings notifications", () => {
  it("requires opt-in when existing settings omit notification preferences", () => {
    expect(decodeClientSettings({}).notificationMode).toBe("off");
    expect(decodeClientSettings({}).inAppNotificationsEnabled).toBe(false);
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("inAppNotificationsEnabled");
    expect(decodeClientSettingsPatch({})).not.toHaveProperty("notificationMode");
  });
});

describe("ClientSettings quit confirmation", () => {
  it.each([
    [true, "hold"],
    [false, "direct"],
  ] as const)("migrates the legacy %s value to %s", (legacyValue, mode) => {
    const settings = decodeClientSettings({ confirmQuit: legacyValue });

    expect(settings.confirmQuit).toBe(mode);
    expect(encodeClientSettings(settings).confirmQuit).toBe(mode);
  });
});

describe("provider enabled defaults", () => {
  it("resolves instance enabled state with explicit false winning", () => {
    const grok = ProviderDriverKind.make("grok");
    const codex = ProviderDriverKind.make("codex");
    expect(resolveProviderInstanceEnabled({ driver: grok, config: {} })).toBe(false);
    expect(resolveProviderInstanceEnabled({ driver: codex, config: {} })).toBe(true);
    expect(
      resolveProviderInstanceEnabled({ driver: ProviderDriverKind.make("ollama"), config: {} }),
    ).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: {} })).toBe(true);
    expect(resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: {} })).toBe(
      false,
    );
    expect(resolveProviderInstanceEnabled({ driver: grok, config: { enabled: true } })).toBe(true);
    expect(
      resolveProviderInstanceEnabled({ driver: grok, enabled: true, config: { enabled: false } }),
    ).toBe(false);
    expect(
      resolveProviderInstanceEnabled({ driver: codex, enabled: false, config: { enabled: true } }),
    ).toBe(false);
  });
});

describe("ServerSettings worktree defaults", () => {
  it("defaults the thread env mode to inherit and keeps stored values", () => {
    expect(decodeServerSettings({}).defaultThreadEnvMode).toBeNull();
    expect(decodeServerSettings({ defaultThreadEnvMode: "worktree" }).defaultThreadEnvMode).toBe(
      "worktree",
    );
    expect(
      decodeServerSettings({ defaultThreadEnvMode: "remote" }).defaultThreadEnvMode,
    ).toBeNull();
    expect(
      decodeServerSettingsPatch({ defaultThreadEnvMode: null }).defaultThreadEnvMode,
    ).toBeNull();
  });

  it("keeps an inherited thread env mode off the wire for older clients", () => {
    const encode = Schema.encodeSync(ServerSettings);
    expect("defaultThreadEnvMode" in encode(decodeServerSettings({}))).toBe(false);
    expect(
      encode(decodeServerSettings({ defaultThreadEnvMode: "worktree" })).defaultThreadEnvMode,
    ).toBe("worktree");
  });
});

describe("ServerSettings.sourceControlWritingStyle", () => {
  it.each([
    { legacy: "", mode: "repo_conventions", customInstructions: "" },
    { legacy: " \t\n ", mode: "repo_conventions", customInstructions: "" },
    {
      legacy: "  Prefer concise wording.\nKeep issue references.  ",
      mode: "custom",
      customInstructions: "Prefer concise wording.\nKeep issue references.",
    },
  ])("normalizes legacy writing style $legacy in snapshots only", ({ legacy, ...expected }) => {
    const style = { ...expected, followChangeRequestTemplates: true };
    for (const [input, normalized] of [
      [{ sourceControlWritingStyle: legacy }, { sourceControlWritingStyle: style }],
      [
        { projectSettingsOverrides: { project: { sourceControlWritingStyle: legacy } } },
        { projectSettingsOverrides: { project: { sourceControlWritingStyle: style } } },
      ],
    ] as const) {
      const settings = decodeServerSettings(input);
      expect(settings).toMatchObject(normalized);
      expect(encodeServerSettings(settings)).toMatchObject(normalized);
      expect(() => decodeServerSettingsPatch(input)).toThrow();
    }
  });
});

describe("ServerSettings environment icon", () => {
  it("decodes a kind from a newer server as null instead of failing the snapshot", () => {
    expect(decodeServerSettings({ environmentIcon: "toaster" }).environmentIcon).toBeNull();
  });
});

const decodeDeviceHostSettings = Schema.decodeSync(ServerSettings);

// `deviceHosts` as it was decoded before Expo hosts existed: an SSH host needs a target.
const decodeOlderDeviceHostSettings = Schema.decodeUnknownSync(
  Schema.Struct({
    deviceHosts: Schema.Array(Schema.Struct({ id: Schema.String, target: Schema.String })),
  }),
);

it("keeps Expo hosts out of the SSH host list servers and clients before Expo hosts decode", () => {
  const settings = decodeDeviceHostSettings({
    deviceHosts: [{ id: "mini", label: "Mac mini", target: "user@mini" }],
    easDeviceHosts: [{ kind: "eas", id: "eas", label: "Expo Simulators" }],
  });
  const wire = encodeServerSettings(settings);
  expect(decodeOlderDeviceHostSettings(wire).deviceHosts).toEqual([
    { id: "mini", target: "user@mini" },
  ]);
  expect(settings.easDeviceHosts.map((host) => host.id)).toEqual(["eas"]);
});

it("validates remote device hosts and rejects ambiguous host ids", () => {
  const host = { id: "mini", label: "Mac mini", target: "user@mini", port: 2222 };
  // Hosts saved before Expo hosts existed have no `kind`; they are SSH hosts.
  expect(decodeDeviceHostSettings({ deviceHosts: [host] }).deviceHosts).toEqual([
    { kind: "ssh", ...host },
  ]);
  expect(() => decodeDeviceHostSettings({ deviceHosts: [host, host] })).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, id: "local" }] })).toThrow();
  expect(() =>
    decodeDeviceHostSettings({ deviceHosts: [{ ...host, target: "-oProxyCommand=bad" }] }),
  ).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, port: 0 }] })).toThrow();
});

describe("ServerSettings project overrides across versions", () => {
  it("sends back an override key from a newer server when an older client edits the entry", () => {
    const projectId = ProjectId.make("project-a");
    // As an older client reads a newer server's settings, with one key it does not know.
    const entry = decodeServerSettings({
      projectSettingsOverrides: {
        [projectId]: { defaultAutoPull: true, addedByNewerServer: { mode: "kept" } },
      },
    }).projectSettingsOverrides[projectId];

    const sent = encodeServerSettingsPatch({
      projectSettingsOverrides: { [projectId]: { ...entry, defaultAutoPull: false } },
    });

    expect(decodeServerSettingsPatch(sent).projectSettingsOverrides?.[projectId]).toEqual({
      defaultAutoPull: false,
      addedByNewerServer: { mode: "kept" },
    });
  });
});

describe("resolveProjectProviderInstanceEnabled", () => {
  const projectId = "project-a" as ProjectId;
  const instanceId = ProviderInstanceId.make("codex_work");

  it("lets a project disable an instance the machine enabled", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    };
    expect(resolveProjectProviderInstanceEnabled(settings, projectId, instanceId)).toBe(false);
  });
});

describe("requiredScopesForProjectMutation", () => {
  it("adds the settings scope only when a mutation carries scripts", () => {
    const projectId = "project-1" as ProjectId;
    const commandId = "command-1" as CommandId;
    expect(
      requiredScopesForProjectMutation({ type: "project.update", commandId, projectId }),
    ).toEqual(["orchestration:operate"]);
    expect(
      requiredScopesForProjectMutation({
        type: "project.update",
        commandId,
        projectId,
        scripts: [],
      }),
    ).toEqual(["orchestration:operate", "settings:write"]);
  });
});

describe("voice settings", () => {
  it("does not import voice consent from ordinary device preferences", () => {
    const imported = {
      voiceTranscriptionEnvironmentId: "env-1",
      voiceTranscriptionDestination: { kind: "environment", environmentId: "env-1" },
      speechPostProcessingEnabled: true,
    };
    expect(decodeClientSettings({}).speechSilenceFiltering).toBe(true);
    expect(decodeClientSettings({}).speechStreaming).toBe(true);
    expect(decodeClientSettings({ speechStreaming: false }).speechStreaming).toBe(false);
    expect(decodeClientSettingsPatch({ speechStreaming: false })).toEqual({
      speechStreaming: false,
    });
    expect(decodeClientSettingsPatch({ speechSilenceFiltering: false })).toEqual({
      speechSilenceFiltering: false,
    });
    for (const key of Object.keys(imported)) {
      expect(decodeClientSettings(imported)).not.toHaveProperty(key);
      expect(decodeClientSettingsPatch(imported)).not.toHaveProperty(key);
    }
  });

  it("keeps the correction cue personal and project vocabulary on the environment", () => {
    expect(decodeClientSettings({}).speechCorrectionWord).toBe("");
    expect(() => decodeClientSettingsPatch({ speechCorrectionWord: "x".repeat(51) })).toThrow();
    expect(DEFAULT_SERVER_SETTINGS.speechProjectCustomWords).toEqual([]);
    expect(PROJECT_SCOPED_SERVER_SETTING_KEYS).toContain("speechProjectCustomWords");
  });
});

describe("server model preferences", () => {
  it("distinguishes unmigrated lists from deliberately cleared lists", () => {
    expect(decodeServerSettings({})).toMatchObject({
      favorites: null,
      providerModelPreferences: null,
    });
    const input = { favorites: [], providerModelPreferences: {} };
    expect(encodeServerSettings(decodeServerSettings(input))).toMatchObject(input);
    expect(decodeServerSettingsPatch(input)).toEqual(input);
  });
});
