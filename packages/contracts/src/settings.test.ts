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
const decodeClientServerSettingsPatch = Schema.decodeUnknownSync(ClientServerSettingsPatch);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const encodeServerSettingsPatch = Schema.encodeSync(ServerSettingsPatch);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

describe("worktree settings", () => {
  it("defaults to grouped worktrees with the upstream temporary prefix", () => {
    const settings = decodeServerSettings({});
    expect(settings.worktreesDirectory).toBe("");
    expect(settings.worktreeProjectFolders).toBe(true);
    expect(settings.worktreeBranchPrefix).toBe(DEFAULT_SERVER_SETTINGS.worktreeBranchPrefix);
  });

  it("accepts home-based roots and Git-safe prefixes at the patch boundary", () => {
    expect(
      decodeServerSettingsPatch({
        worktreesDirectory: " ~/.herdr/worktrees ",
        worktreeProjectFolders: true,
        worktreeBranchPrefix: "nick/tasks",
      }),
    ).toEqual({
      worktreesDirectory: "~/.herdr/worktrees",
      worktreeProjectFolders: true,
      worktreeBranchPrefix: "nick/tasks",
    });
    expect(() => decodeServerSettingsPatch({ worktreeBranchPrefix: "nick/" })).toThrow();
  });
});

describe("ServerSettings response streaming", () => {
  it("defaults to paragraph buffering", () => {
    expect(decodeServerSettings({}).responseStreamingMode).toBe("paragraph");
  });

  it.each(["turn", "paragraph"])(
    "round-trips %s as an environment setting and project override",
    (responseStreamingMode) => {
      const input = {
        responseStreamingMode,
        projectSettingsOverrides: { project: { responseStreamingMode } },
      };
      expect(encodeServerSettings(decodeServerSettings(input))).toMatchObject(input);
      expect(decodeServerSettingsPatch(input)).toEqual(input);
    },
  );

  it.each(["token", "unsupported"])("rejects %s in settings snapshots and writes", (mode) => {
    for (const input of [
      { responseStreamingMode: mode },
      { projectSettingsOverrides: { project: { responseStreamingMode: mode } } },
    ]) {
      expect(() => decodeServerSettings(input)).toThrow();
      expect(() => decodeServerSettingsPatch(input)).toThrow();
    }
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

describe("ClientSettings Vim composer", () => {
  it("defaults to ordinary editing with a private register and saves both preferences", () => {
    expect(decodeClientSettings({})).toMatchObject({
      composerVimEnabled: false,
      composerVimSystemClipboard: false,
    });
    const preference = { composerVimEnabled: true, composerVimSystemClipboard: true };
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

describe("project diff auto-collapse setting", () => {
  it("defaults to on and persists a project override", () => {
    const projectId = ProjectId.make("project");
    expect(decodeServerSettings({}).autoCollapseTestAndSnapshotFiles).toBe(true);
    const settings = decodeServerSettings({
      projectSettingsOverrides: {
        [projectId]: { autoCollapseTestAndSnapshotFiles: false },
      },
    });
    expect(encodeServerSettings(settings).projectSettingsOverrides).toEqual({
      [projectId]: { autoCollapseTestAndSnapshotFiles: false },
    });
    expect(
      decodeServerSettingsPatch({
        projectSettingsOverrides: {
          [projectId]: { autoCollapseTestAndSnapshotFiles: false },
        },
      }).projectSettingsOverrides?.[projectId],
    ).toEqual({ autoCollapseTestAndSnapshotFiles: false });
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
