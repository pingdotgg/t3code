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
  ClaudeSettings,
  DEFAULT_SERVER_SETTINGS,
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
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const encodeServerSettingsPatch = Schema.encodeSync(ServerSettingsPatch);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

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

  it.each([0, -1, 1.5, 3651])("rejects invalid retention %s", (days) => {
    expect(() =>
      decodeServerSettingsPatch({ storageCleanup: { browserArtifactsAfterDays: days } }),
    ).toThrow();
  });

  it.each([-1, 1.5, 3651])("rejects invalid settled retention %s", (days) => {
    expect(() =>
      decodeServerSettingsPatch({ storageCleanup: { worktreeSettledAfterDays: days } }),
    ).toThrow();
  });
});

describe("ClientSettings rich text composer", () => {
  it("keeps math opt-in and preserves its preference through patches and persistence", () => {
    expect(decodeClientSettings({}).mathRenderingEnabled).toBe(true);
    for (const mathRenderingEnabled of [true, false]) {
      const preference = { mathRenderingEnabled };
      expect(decodeClientSettingsPatch(preference)).toEqual(preference);
      expect(encodeClientSettings(decodeClientSettings(preference))).toMatchObject(preference);
    }
    expect(() => decodeClientSettingsPatch({ mathRenderingEnabled: "yes" })).toThrow();
  });
  it("enables rich text for new and existing settings without a saved preference", () => {
    expect(decodeClientSettings({}).composerRichTextEnabled).toBe(true);
    expect(decodeClientSettings({ sendShortcut: "mod-enter" }).composerRichTextEnabled).toBe(true);
  });

  it("preserves an explicit opt-out through patches and persistence", () => {
    const preference = { composerRichTextEnabled: false };
    expect(decodeClientSettingsPatch(preference)).toEqual(preference);
    expect(encodeClientSettings(decodeClientSettings(preference))).toMatchObject(preference);
  });
});

describe("ServerSettings default permissions", () => {
  it("keeps full access for settings saved before a default was configured", () => {
    expect(decodeServerSettings({}).defaultRuntimeMode).toBe("full-access");
    expect(DEFAULT_SERVER_SETTINGS.defaultRuntimeMode).toBe("full-access");
  });

  it.each(["approval-required", "auto-accept-edits", "auto", "full-access"])(
    "round-trips %s as an environment default and project override",
    (defaultRuntimeMode) => {
      const input = {
        defaultRuntimeMode,
        projectSettingsOverrides: { project: { defaultRuntimeMode } },
      };
      expect(encodeServerSettings(decodeServerSettings(input))).toMatchObject(input);
      expect(decodeServerSettingsPatch(input)).toEqual(input);
    },
  );

  it("rejects unsupported permission defaults", () => {
    expect(() => decodeServerSettings({ defaultRuntimeMode: "unsupported" })).toThrow();
    expect(() => decodeServerSettingsPatch({ defaultRuntimeMode: "unsupported" })).toThrow();
    expect(() =>
      decodeServerSettingsPatch({
        projectSettingsOverrides: { project: { defaultRuntimeMode: "unsupported" } },
      }),
    ).toThrow();
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

  it.each([true, false])(
    "round-trips in-app notifications set to %s",
    (inAppNotificationsEnabled) => {
      const settings = decodeClientSettings({ inAppNotificationsEnabled });
      expect(encodeClientSettings(settings).inAppNotificationsEnabled).toBe(
        inAppNotificationsEnabled,
      );
      expect(
        decodeClientSettingsPatch({ inAppNotificationsEnabled }).inAppNotificationsEnabled,
      ).toBe(inAppNotificationsEnabled);
    },
  );

  it.each(["true", 1, null])(
    "rejects an invalid in-app notification preference %s",
    (inAppNotificationsEnabled) => {
      expect(() => decodeClientSettings({ inAppNotificationsEnabled })).toThrow();
      expect(() => decodeClientSettingsPatch({ inAppNotificationsEnabled })).toThrow();
    },
  );

  it.each(["off", "notifications", "sound", "notifications-and-sound"])(
    "round-trips the %s mode",
    (notificationMode) => {
      const settings = decodeClientSettings({ notificationMode });
      expect(encodeClientSettings(settings).notificationMode).toBe(notificationMode);
      expect(decodeClientSettingsPatch({ notificationMode }).notificationMode).toBe(
        notificationMode,
      );
    },
  );

  it.each(["always", true, null])(
    "rejects unsupported notification mode %s",
    (notificationMode) => {
      expect(() => decodeClientSettings({ notificationMode })).toThrow();
      expect(() => decodeClientSettingsPatch({ notificationMode })).toThrow();
    },
  );
});

describe("ClientSettings default diff file state", () => {
  it("keeps files collapsed when existing settings omit the preference", () => {
    expect(decodeClientSettings({}).diffFilesCollapsed).toBe(true);
  });

  it.each([true, false])("preserves a saved collapsed preference of %s", (diffFilesCollapsed) => {
    const settings = decodeClientSettings({ diffFilesCollapsed });
    expect(encodeClientSettings(settings).diffFilesCollapsed).toBe(diffFilesCollapsed);
    expect(decodeClientSettingsPatch({ diffFilesCollapsed }).diffFilesCollapsed).toBe(
      diffFilesCollapsed,
    );
  });
});

describe("ClientSettings diff colors", () => {
  it("keeps red and green for existing settings without a saved palette", () => {
    expect(decodeClientSettings({}).diffColorScheme).toBe("red-green");
  });

  it.each(["red-green", "blue-orange"])("round-trips the %s palette", (diffColorScheme) => {
    const settings = decodeClientSettings({ diffColorScheme });
    expect(encodeClientSettings(settings).diffColorScheme).toBe(diffColorScheme);
    expect(decodeClientSettingsPatch({ diffColorScheme }).diffColorScheme).toBe(diffColorScheme);
  });

  it("rejects unsupported palettes", () => {
    expect(() => decodeClientSettings({ diffColorScheme: "purple-yellow" })).toThrow();
    expect(() => decodeClientSettingsPatch({ diffColorScheme: "purple-yellow" })).toThrow();
  });
});

describe("ClientSettings chat width", () => {
  it("keeps the comfortable width for existing settings without a saved width", () => {
    expect(decodeClientSettings({}).chatWidth).toBe("comfortable");
  });

  it.each(["comfortable", "wide", "full"])("round-trips the %s width", (chatWidth) => {
    const settings = decodeClientSettings({ chatWidth });
    expect(encodeClientSettings(settings).chatWidth).toBe(chatWidth);
    expect(decodeClientSettingsPatch({ chatWidth }).chatWidth).toBe(chatWidth);
  });

  it("rejects unsupported widths", () => {
    expect(() => decodeClientSettings({ chatWidth: "huge" })).toThrow();
    expect(() => decodeClientSettingsPatch({ chatWidth: "huge" })).toThrow();
  });
});

describe("ClientSettings load balancing", () => {
  it("requires opt-in when settings are new or omit load balancing", () => {
    expect(decodeClientSettings({}).loadBalancingEnabled).toBe(false);
    expect(decodeClientSettings({ loadBalancingWeights: {} }).loadBalancingEnabled).toBe(false);
  });

  it.each([true, false])("preserves a saved choice of %s", (loadBalancingEnabled) => {
    const settings = decodeClientSettings({ loadBalancingEnabled });
    expect(encodeClientSettings(settings).loadBalancingEnabled).toBe(loadBalancingEnabled);
    expect(decodeClientSettingsPatch({ loadBalancingEnabled }).loadBalancingEnabled).toBe(
      loadBalancingEnabled,
    );
  });
});

describe("ClaudeSettings advisor model", () => {
  it("inherits Claude's own advisor setting when none is configured", () => {
    expect(decodeClaudeSettings({}).advisorModel).toBe("");
  });

  it("keeps a configured advisor alias", () => {
    expect(decodeClaudeSettings({ advisorModel: "opus" }).advisorModel).toBe("opus");
  });

  it("accepts an advisor model at the settings patch boundary", () => {
    expect(
      decodeServerSettingsPatch({ providers: { claudeAgent: { advisorModel: "fable" } } }),
    ).toBeDefined();
  });
});

describe("ClientSettings composer context strip", () => {
  it("defaults to draft-only and accepts a persistent strip preference", () => {
    expect(decodeClientSettings({}).persistComposerContextStrip).toBe(false);
    expect(
      decodeClientSettingsPatch({ persistComposerContextStrip: true }).persistComposerContextStrip,
    ).toBe(true);
  });
});

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

describe("ClientSettings window capture", () => {
  it("defaults capture off while keeping its feedback enabled", () => {
    const settings = decodeClientSettings({});

    expect(settings.snapShotEnabled).toBe(false);
    expect(settings.snapShotIncludeAccessibility).toBe(true);
    expect(settings.snapShotShortcut).toEqual({ kind: "both-shift-keys" });
    expect(settings.snapShotPlaySound).toBe(true);
    expect(settings.snapShotSound).toBe("soft-pop");
    expect(settings.snapShotFlash).toBe(true);
    expect(settings.snapShotAnimations).toBe(true);
  });

  it("accepts capture preference updates", () => {
    expect(
      decodeClientSettingsPatch({
        snapShotEnabled: true,
        snapShotIncludeAccessibility: false,
        snapShotShortcut: {
          key: "w",
          metaKey: false,
          ctrlKey: false,
          shiftKey: true,
          altKey: true,
          modKey: false,
        },
        snapShotPlaySound: false,
        snapShotSound: "camera-shutter",
        snapShotFlash: false,
        snapShotAnimations: false,
      }),
    ).toEqual({
      snapShotEnabled: true,
      snapShotIncludeAccessibility: false,
      snapShotShortcut: {
        key: "w",
        metaKey: false,
        ctrlKey: false,
        shiftKey: true,
        altKey: true,
        modKey: false,
      },
      snapShotPlaySound: false,
      snapShotSound: "camera-shutter",
      snapShotFlash: false,
      snapShotAnimations: false,
    });
  });

  it("rejects unknown capture sounds", () => {
    expect(() => decodeClientSettingsPatch({ snapShotSound: "doorbell" })).toThrow();
  });

  it("accepts modifier pair shortcuts", () => {
    expect(
      decodeClientSettingsPatch({
        snapShotShortcut: { kind: "modifier-pair", modifier: "meta" },
      }),
    ).toEqual({
      snapShotShortcut: { kind: "modifier-pair", modifier: "meta" },
    });
    expect(() =>
      decodeClientSettingsPatch({
        snapShotShortcut: { kind: "modifier-pair", modifier: "hyper" },
      }),
    ).toThrow();
  });

  it("rejects a capture shortcut with no modifier", () => {
    expect(() =>
      decodeClientSettingsPatch({
        snapShotShortcut: {
          key: "w",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: false,
        },
      }),
    ).toThrow();
  });
});

describe("ClientSettings proactive panels", () => {
  it("is opt-in and accepts client-local updates", () => {
    expect(decodeClientSettings({}).proactivePanelsEnabled).toBe(false);
    expect(decodeClientSettingsPatch({ proactivePanelsEnabled: true }).proactivePanelsEnabled).toBe(
      true,
    );
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

  it("rejects legacy booleans at the patch boundary", () => {
    expect(() => decodeClientSettingsPatch({ confirmQuit: true })).toThrow();
  });
});

describe("ServerSettings environment label", () => {
  it("defaults to automatic naming", () => {
    expect(decodeServerSettings({}).environmentLabel).toBe("");
  });

  it("trims labels and accepts an empty reset", () => {
    expect(
      decodeServerSettingsPatch({ environmentLabel: "  Build server  " }).environmentLabel,
    ).toBe("Build server");
    expect(decodeServerSettingsPatch({ environmentLabel: "   " }).environmentLabel).toBe("");
  });

  it("rejects labels longer than 40 characters", () => {
    expect(() => decodeServerSettingsPatch({ environmentLabel: "x".repeat(41) })).toThrow();
  });
});

describe("ClientSettings sound notifications", () => {
  it("defaults sound notifications on", () => {
    expect(decodeClientSettings({}).soundNotificationsEnabled).toBe(true);
  });

  it("decodes explicit sound notifications setting", () => {
    expect(
      decodeClientSettings({ soundNotificationsEnabled: false }).soundNotificationsEnabled,
    ).toBe(false);
    expect(
      decodeClientSettingsPatch({ soundNotificationsEnabled: false }).soundNotificationsEnabled,
    ).toBe(false);
  });
});

describe("ClientSettings browser recording frame rate", () => {
  it("defaults to 30 fps", () => {
    expect(decodeClientSettings({}).browserRecordingFrameRate).toBe(30);
  });

  it.each([30, 60])("accepts a supported frame rate: %s", (frameRate) => {
    expect(
      decodeClientSettings({ browserRecordingFrameRate: frameRate }).browserRecordingFrameRate,
    ).toBe(frameRate);
    expect(
      decodeClientSettingsPatch({ browserRecordingFrameRate: frameRate }).browserRecordingFrameRate,
    ).toBe(frameRate);
  });

  it.each([24, 59, 120])("rejects an unsupported frame rate: %s", (frameRate) => {
    expect(() => decodeClientSettings({ browserRecordingFrameRate: frameRate })).toThrow();
    expect(() => decodeClientSettingsPatch({ browserRecordingFrameRate: frameRate })).toThrow();
  });
});

describe("ClientSettings recording input overlays", () => {
  it("defaults both overlays off and accepts independent opt-ins", () => {
    const settings = decodeClientSettings({});
    expect(settings.browserRecordingShowKeyPresses).toBe(false);
    expect(settings.browserRecordingShowMousePresses).toBe(false);
    expect(
      decodeClientSettingsPatch({
        browserRecordingShowKeyPresses: true,
        browserRecordingShowMousePresses: false,
      }),
    ).toMatchObject({
      browserRecordingShowKeyPresses: true,
      browserRecordingShowMousePresses: false,
    });
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

  it.each([40, 100])("accepts a glass opacity within the supported range: %s", (value) => {
    expect(decodeClientSettings({ glassOpacity: value }).glassOpacity).toBe(value);
    expect(decodeClientSettingsPatch({ glassOpacity: value }).glassOpacity).toBe(value);
  });
});

describe("ClientSettings appearance contrast", () => {
  it("defaults to the theme's original contrast", () => {
    expect(decodeClientSettings({}).appearanceContrast).toBe(100);
  });

  it.each([49, 201, 92.5])("rejects an invalid appearance contrast: %s", (value) => {
    expect(() => decodeClientSettings({ appearanceContrast: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ appearanceContrast: value })).toThrow();
  });

  it.each([50, 200])("accepts an appearance contrast in range: %s", (value) => {
    expect(decodeClientSettings({ appearanceContrast: value }).appearanceContrast).toBe(value);
    expect(decodeClientSettingsPatch({ appearanceContrast: value }).appearanceContrast).toBe(value);
  });
});

describe("ClientSettings panel animations", () => {
  it("defaults to instant changes", () => {
    expect(decodeClientSettings({}).panelAnimationDurationMs).toBe(0);
  });

  it.each([0, 400])("accepts a panel animation duration: %s", (value) => {
    expect(decodeClientSettingsPatch({ panelAnimationDurationMs: value })).toEqual({
      panelAnimationDurationMs: value,
    });
  });

  it.each([-1, 401, 150.5])("rejects an invalid panel animation duration: %s", (value) => {
    expect(() => decodeClientSettingsPatch({ panelAnimationDurationMs: value })).toThrow();
  });
});

describe("ClientSettings environment identification", () => {
  it("defaults to artwork and accepts each presentation mode", () => {
    expect(decodeClientSettings({}).environmentIdentificationMode).toBe("artwork");

    for (const mode of ["artwork", "pill", "none"] as const) {
      expect(
        decodeClientSettingsPatch({ environmentIdentificationMode: mode })
          .environmentIdentificationMode,
      ).toBe(mode);
    }
  });

  it("rejects unsupported presentation modes", () => {
    expect(() => decodeClientSettings({ environmentIdentificationMode: "badge" })).toThrow();
    expect(() => decodeClientSettingsPatch({ environmentIdentificationMode: "badge" })).toThrow();
  });
});

describe("ClientSettings sidebar", () => {
  it("defaults to the current sidebar", () => {
    const settings = decodeClientSettings({});
    expect(settings.legacySidebarEnabled).toBe(false);
    expect(settings.tabsEnabled).toBe(false);
    expect(settings.sidebarActiveThreadSortOrder).toBe("updated_at");
  });

  it("accepts an active thread sort preference", () => {
    expect(
      decodeClientSettingsPatch({ sidebarActiveThreadSortOrder: "updated_at" })
        .sidebarActiveThreadSortOrder,
    ).toBe("updated_at");
  });

  it("preserves an explicit tabsEnabled setting", () => {
    expect(decodeClientSettings({ tabsEnabled: false }).tabsEnabled).toBe(false);
    expect(decodeClientSettings({ tabsEnabled: true }).tabsEnabled).toBe(true);
    expect(decodeClientSettingsPatch({ tabsEnabled: false }).tabsEnabled).toBe(false);
    expect(decodeClientSettingsPatch({ tabsEnabled: true }).tabsEnabled).toBe(true);
  });

  it("drops the retired sidebar v2 beta keys, resetting everyone to the default", () => {
    const decoded = decodeClientSettings({
      sidebarV2Enabled: false,
      sidebarV2ConfiguredByUser: true,
    });
    expect(decoded.legacySidebarEnabled).toBe(false);
    expect(decoded).not.toHaveProperty("sidebarV2Enabled");
    expect(decoded).not.toHaveProperty("sidebarV2ConfiguredByUser");
  });

  it("drops the retired compact sidebar keys for users who opted in", () => {
    const stored = { compactSidebarEnabled: true, sidebarCompactThreadRows: true };
    const decoded = decodeClientSettings(stored);
    expect(decoded).not.toHaveProperty("compactSidebarEnabled");
    expect(decoded).not.toHaveProperty("sidebarCompactThreadRows");
    expect(decodeClientSettingsPatch(stored)).toEqual({});
  });

  it("preserves an explicit legacy sidebar opt-in", () => {
    expect(decodeClientSettings({ legacySidebarEnabled: true }).legacySidebarEnabled).toBe(true);
    expect(decodeClientSettingsPatch({ legacySidebarEnabled: true }).legacySidebarEnabled).toBe(
      true,
    );
  });

  it("keeps unpin confirmation opt-in and patchable", () => {
    expect(decodeClientSettings({}).confirmThreadUnpin).toBe(false);
    expect(decodeClientSettingsPatch({ confirmThreadUnpin: true }).confirmThreadUnpin).toBe(true);
    expect(() => decodeClientSettingsPatch({ confirmThreadUnpin: "yes" })).toThrow();
  });
});

describe("ClientSettings context window meter", () => {
  it("defaults off and preserves an explicit legacy opt-in", () => {
    expect(decodeClientSettings({}).contextWindowMeterEnabled).toBe(false);
    expect(
      decodeClientSettings({ contextWindowMeterEnabled: true }).contextWindowMeterEnabled,
    ).toBe(true);
    expect(
      decodeClientSettingsPatch({ contextWindowMeterEnabled: true }).contextWindowMeterEnabled,
    ).toBe(true);
  });
});

describe("ClientSettings send shortcut", () => {
  it("defaults to Enter and validates the supported choices", () => {
    expect(decodeClientSettings({}).sendShortcut).toBe("enter");
    for (const sendShortcut of ["enter", "mod-enter-multiline", "mod-enter"]) {
      expect(decodeClientSettings({ sendShortcut }).sendShortcut).toBe(sendShortcut);
      expect(decodeClientSettingsPatch({ sendShortcut }).sendShortcut).toBe(sendShortcut);
    }
    expect(() => decodeClientSettingsPatch({ sendShortcut: "invalid" })).toThrow();
  });
});

describe("ClientSettings follow-up behavior", () => {
  it("defaults to queue and accepts either behavior", () => {
    expect(decodeClientSettings({}).followUpBehavior).toBe("queue");
    for (const followUpBehavior of ["queue", "steer"]) {
      expect(decodeClientSettings({ followUpBehavior }).followUpBehavior).toBe(followUpBehavior);
      expect(decodeClientSettingsPatch({ followUpBehavior }).followUpBehavior).toBe(
        followUpBehavior,
      );
    }
    expect(() => decodeClientSettingsPatch({ followUpBehavior: "invalid" })).toThrow();
  });
});

describe("ServerSettings thread settlement", () => {
  it("defaults merge settlement on and inactivity settlement to seven days", () => {
    const settings = decodeServerSettings({});
    expect(settings.sidebarAutoSettleAfterDays).toBe(7);
    expect(settings.sidebarAutoSettleScope).toBe("all");
    expect(settings.sidebarAutoSettleOnMerge).toBe(true);
    expect(settings.sidebarAutoSettlePinnedThreads).toBe(false);
  });

  it("allows both automatic rules to be disabled", () => {
    expect(
      decodeServerSettings({
        sidebarAutoSettleAfterDays: null,
        sidebarAutoSettleOnMerge: false,
        sidebarAutoSettlePinnedThreads: true,
      }),
    ).toMatchObject({
      sidebarAutoSettleAfterDays: null,
      sidebarAutoSettleOnMerge: false,
      sidebarAutoSettlePinnedThreads: true,
    });
    expect(
      decodeServerSettingsPatch({
        sidebarAutoSettleAfterDays: null,
        sidebarAutoSettleOnMerge: false,
        sidebarAutoSettlePinnedThreads: true,
      }),
    ).toMatchObject({
      sidebarAutoSettleAfterDays: null,
      sidebarAutoSettleOnMerge: false,
      sidebarAutoSettlePinnedThreads: true,
    });
  });

  it("accepts the linked-PR exclusion and rejects unknown scopes", () => {
    expect(decodeServerSettingsPatch({ sidebarAutoSettleScope: "without-pr" })).toEqual({
      sidebarAutoSettleScope: "without-pr",
    });
    expect(() => decodeServerSettingsPatch({ sidebarAutoSettleScope: "unknown" })).toThrow();
  });

  it.each([-1, 0, 91])("rejects an auto-settle threshold outside 1..90: %s", (value) => {
    expect(() => decodeServerSettings({ sidebarAutoSettleAfterDays: value })).toThrow();
    expect(() => decodeServerSettingsPatch({ sidebarAutoSettleAfterDays: value })).toThrow();
  });
});

describe("ClientSettings retired fork dictation keys", () => {
  it("ignores the cloud dictation keys older MT Code builds persisted", () => {
    const settings = decodeClientSettings({
      voiceTranscriptionEnabled: true,
      voiceTranscriptionProvider: "groq",
      voiceTranscriptionApiKey: "sk-old",
      voiceTranscriptionModel: "whisper-large-v3",
      soundNotificationsEnabled: false,
    });

    expect(settings).not.toHaveProperty("voiceTranscriptionApiKey");
    expect(settings.soundNotificationsEnabled).toBe(false);
    expect(settings.voiceMicrophone).toBe("");
  });
});

describe("ClientSettings pull request merge methods", () => {
  it("defaults to no project overrides and accepts supported methods", () => {
    expect(decodeClientSettings({}).pullRequestMergeMethodOverrides).toEqual({});
    expect(
      decodeClientSettingsPatch({
        pullRequestMergeMethodOverrides: { project: "squash" },
      }).pullRequestMergeMethodOverrides,
    ).toEqual({ project: "squash" });
  });

  it("rejects unsupported project merge methods", () => {
    expect(() =>
      decodeClientSettingsPatch({
        pullRequestMergeMethodOverrides: { project: "fast-forward" },
      }),
    ).toThrow();
  });
});

describe("ServerSettings permission defaults", () => {
  it("defaults new threads to full access without provider overrides", () => {
    const settings = decodeServerSettings({});

    expect(settings.defaultRuntimeMode).toBe("full-access");
    expect(settings.providerRuntimeModeDefaults).toEqual({});
  });

  it("accepts per-instance overrides and null removals in patches", () => {
    expect(
      decodeServerSettingsPatch({
        defaultRuntimeMode: "approval-required",
        providerRuntimeModeDefaults: {
          codex_work: "auto",
          claude_work: null,
        },
      }),
    ).toMatchObject({
      defaultRuntimeMode: "approval-required",
      providerRuntimeModeDefaults: {
        codex_work: "auto",
        claude_work: null,
      },
    });
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

  it("defaults start-from-origin on for legacy configs", () => {
    expect(decodeServerSettings({}).newWorktreesStartFromOrigin).toBe(true);
  });

  it("accepts start-from-origin updates", () => {
    expect(
      decodeServerSettingsPatch({ newWorktreesStartFromOrigin: false }).newWorktreesStartFromOrigin,
    ).toBe(false);
  });

  it("defaults the worktree branch prefix for legacy configs", () => {
    expect(decodeServerSettings({}).worktreeBranchPrefix).toBe("t3code");
  });

  it.each(["", "team", "my-team", "team/backend", "team_1"])(
    "accepts the worktree branch prefix %j",
    (worktreeBranchPrefix) => {
      expect(decodeServerSettingsPatch({ worktreeBranchPrefix }).worktreeBranchPrefix).toBe(
        worktreeBranchPrefix,
      );
    },
  );

  it.each(["../unsafe", "team//backend", "Team", "-team", "team-", "a".repeat(65)])(
    "rejects the unsafe worktree branch prefix %j",
    (worktreeBranchPrefix) => {
      expect(() => decodeServerSettingsPatch({ worktreeBranchPrefix })).toThrow();
    },
  );

  it("defaults worktree submodules to inherit and tolerates unknown modes", () => {
    expect(decodeServerSettings({}).worktreeSubmodules).toBeNull();
    expect(decodeServerSettings({ worktreeSubmodules: "top-level" }).worktreeSubmodules).toBe(
      "top-level",
    );
    expect(decodeServerSettings({ worktreeSubmodules: "shallow" }).worktreeSubmodules).toBeNull();
    expect(decodeServerSettingsPatch({ worktreeSubmodules: null }).worktreeSubmodules).toBeNull();
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

describe("ServerSettings draft pull requests", () => {
  it("keeps ready-for-review creation as the default", () => {
    expect(decodeServerSettings({}).createGitHubPullRequestsAsDraft).toBe(false);
  });
  it.each([false, true])("round-trips the draft preference %s", (enabled) => {
    const patch = decodeServerSettingsPatch({ createGitHubPullRequestsAsDraft: enabled });
    const settings = decodeServerSettings(patch);
    expect(encodeServerSettings(settings).createGitHubPullRequestsAsDraft).toBe(enabled);
  });
});

const decodeDeviceHostSettings = Schema.decodeSync(ServerSettings);

// `deviceHosts` as it was decoded before EAS hosts existed: an SSH host needs a target.
const decodeOlderDeviceHostSettings = Schema.decodeUnknownSync(
  Schema.Struct({
    deviceHosts: Schema.Array(Schema.Struct({ id: Schema.String, target: Schema.String })),
  }),
);

it("keeps EAS hosts out of the SSH host list servers and clients before EAS hosts decode", () => {
  const settings = decodeDeviceHostSettings({
    deviceHosts: [{ id: "mini", label: "Mac mini", target: "user@mini" }],
    easDeviceHosts: [{ kind: "eas", id: "eas", label: "EAS Simulator" }],
  });
  const wire = encodeServerSettings(settings);
  expect(decodeOlderDeviceHostSettings(wire).deviceHosts).toEqual([
    { id: "mini", target: "user@mini" },
  ]);
  expect(settings.easDeviceHosts.map((host) => host.id)).toEqual(["eas"]);
});

it("validates remote device hosts and rejects ambiguous host ids", () => {
  const host = { id: "mini", label: "Mac mini", target: "user@mini", port: 2222 };
  // Hosts saved before EAS hosts existed have no `kind`; they are SSH hosts.
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

  it("stores the transcription model and resources on the environment", () => {
    expect(DEFAULT_SERVER_SETTINGS).toMatchObject({
      speechModelId: "handy-computer/parakeet-unified-en-0.6b-gguf",
      speechAcceleration: "auto",
      speechModelUnloadTimeout: "min_15",
    });
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
