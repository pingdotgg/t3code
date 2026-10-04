import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ProviderInstanceId } from "./providerInstance.ts";
import {
  ClientSettingsPatch,
  ClientSettingsSchema,
  DEFAULT_AUTO_ARCHIVE_SETTLED_AFTER_DAYS,
  DEFAULT_CHAT_EXPORT_DETAIL_SETTINGS,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_CODE_FONT,
  DEFAULT_COMPOSER_META_FONT_SIZE,
  DEFAULT_MESSAGE_PREVIEW_LINE_LIMITS,
  DEFAULT_PULL_REQUESTS_BODY_FONT_SIZE,
  DEFAULT_PULL_REQUESTS_CODE_FONT_SIZE,
  DEFAULT_PULL_REQUESTS_DEFAULT_STATE,
  DEFAULT_SIDEBAR_FONT_SIZE,
  DEFAULT_SIDEBAR_ICON_SIZE,
  DEFAULT_SIDEBAR_META_FONT_SIZE,
  DEFAULT_SIDEBAR_ROW_SPACING,
  DEFAULT_SIDEBAR_TRANSLUCENCY,
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_UI_DENSITY,
  MAX_AUTO_ARCHIVE_SETTLED_AFTER_DAYS,
  MIN_AUTO_ARCHIVE_SETTLED_AFTER_DAYS,
  RECOMMENDED_FONT_SIZES_BY_UI_DENSITY,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";
import { DEFAULT_FIX_REVIEW_ISSUES_PROMPT_TEMPLATE } from "./workflowRuntime.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

describe("Copilot ACP containment", () => {
  it("defaults automation policy off outside provider runtime config", () => {
    expect(decodeServerSettings({}).copilotAutomaticPrFeedback).toEqual({});
    expect(decodeServerSettings({}).providers.copilot).not.toHaveProperty(
      "allowAutomaticPrFeedback",
    );
  });

  it("requires a boolean opt-in", () => {
    expect(() =>
      decodeServerSettings({ copilotAutomaticPrFeedback: { copilot: "true" } }),
    ).toThrow();
    expect(
      decodeServerSettingsPatch({ copilotAutomaticPrFeedback: { copilot: true } })
        .copilotAutomaticPrFeedback?.[ProviderInstanceId.make("copilot")],
    ).toBe(true);
  });
});

describe("ServerSettings.agentWorkflows", () => {
  it("defaults the Fix Review Issues workflow on for legacy settings", () => {
    const decoded = decodeServerSettings({});

    expect(decoded.agentWorkflows.fixReviewIssues).toEqual({
      enabled: true,
      promptTemplate: DEFAULT_FIX_REVIEW_ISSUES_PROMPT_TEMPLATE,
    });
  });

  it("accepts partial Fix Review Issues workflow patches", () => {
    const patch = decodeServerSettingsPatch({
      agentWorkflows: {
        fixReviewIssues: {
          enabled: false,
          promptTemplate: "Validate and fix these findings.",
        },
      },
    });

    expect(patch.agentWorkflows?.fixReviewIssues).toEqual({
      enabled: false,
      promptTemplate: "Validate and fix these findings.",
    });
  });
});

describe("ServerSettings.autoArchiveSettledAfterDays", () => {
  it("defaults to two days", () => {
    expect(DEFAULT_AUTO_ARCHIVE_SETTLED_AFTER_DAYS).toBe(2);
    expect(DEFAULT_SERVER_SETTINGS.autoArchiveSettledAfterDays).toBe(2);
    expect(decodeServerSettings({}).autoArchiveSettledAfterDays).toBe(2);
  });

  it("passes null through to disable auto-archive (fail closed)", () => {
    expect(
      decodeServerSettings({ autoArchiveSettledAfterDays: null }).autoArchiveSettledAfterDays,
    ).toBeNull();
    expect(
      decodeServerSettingsPatch({ autoArchiveSettledAfterDays: null }).autoArchiveSettledAfterDays,
    ).toBeNull();
  });

  it("accepts day values inside the 1-90 range in patches", () => {
    expect(
      decodeServerSettingsPatch({ autoArchiveSettledAfterDays: 2 }).autoArchiveSettledAfterDays,
    ).toBe(2);
  });

  it("exports the range bounds mirroring the sidebar auto-settle pattern", () => {
    expect(MIN_AUTO_ARCHIVE_SETTLED_AFTER_DAYS).toBe(1);
    expect(MAX_AUTO_ARCHIVE_SETTLED_AFTER_DAYS).toBe(90);
  });
});

describe("provider log retention settings", () => {
  it("defaults the age and total-size policies", () => {
    expect(DEFAULT_SERVER_SETTINGS.providerLogRetentionDays).toBe(14);
    expect(DEFAULT_SERVER_SETTINGS.providerLogMaxTotalMb).toBe(5120);
    expect(decodeServerSettings({}).providerLogRetentionDays).toBe(14);
    expect(decodeServerSettings({}).providerLogMaxTotalMb).toBe(5120);
  });

  it("preserves null as disabled and accepts numeric patch values", () => {
    expect(
      decodeServerSettingsPatch({ providerLogRetentionDays: null }).providerLogRetentionDays,
    ).toBeNull();
    expect(
      decodeServerSettingsPatch({ providerLogMaxTotalMb: null }).providerLogMaxTotalMb,
    ).toBeNull();
    expect(
      decodeServerSettingsPatch({ providerLogRetentionDays: 30 }).providerLogRetentionDays,
    ).toBe(30);
    expect(decodeServerSettingsPatch({ providerLogMaxTotalMb: 2048 }).providerLogMaxTotalMb).toBe(
      2048,
    );
  });
});

describe("ServerSettings.pullRequestMonitoring", () => {
  it("defaults automatic monitoring and maintenance chats on", () => {
    expect(DEFAULT_SERVER_SETTINGS.autoMonitorPullRequestsOnCreate).toBe(true);
    expect(DEFAULT_SERVER_SETTINGS.autoLaunchPrMonitorFallback).toBe(true);
  });

  it("accepts patches for both monitoring controls", () => {
    expect(
      decodeServerSettingsPatch({
        autoMonitorPullRequestsOnCreate: false,
        autoLaunchPrMonitorFallback: false,
      }),
    ).toEqual({
      autoMonitorPullRequestsOnCreate: false,
      autoLaunchPrMonitorFallback: false,
    });
  });
});

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

describe("ClientSettings.filePreviewLineSpacing", () => {
  it("defaults to upstream-like spacing and accepts only supported values", () => {
    expect(DEFAULT_CLIENT_SETTINGS.filePreviewLineSpacing).toBe(1.5);
    expect(decodeClientSettings({}).filePreviewLineSpacing).toBe(1.5);
    expect(decodeClientSettingsPatch({ filePreviewLineSpacing: 1.65 })).toEqual({
      filePreviewLineSpacing: 1.65,
    });
    expect(() => decodeClientSettingsPatch({ filePreviewLineSpacing: 2 })).toThrow();
  });
});

describe("ClientSettings.uiFont", () => {
  it("defaults to DM Sans", () => {
    expect(DEFAULT_CLIENT_SETTINGS.uiFont).toBe("dm-sans");
    expect(decodeClientSettings({}).uiFont).toBe("dm-sans");
  });

  it("accepts known interface font options in patches", () => {
    expect(decodeClientSettingsPatch({ uiFont: "geist" }).uiFont).toBe("geist");
    expect(decodeClientSettingsPatch({ uiFont: "system-ui" }).uiFont).toBe("system-ui");
  });

  it("rejects unknown interface font options in patches", () => {
    expect(() => decodeClientSettingsPatch({ uiFont: "not-a-font" })).toThrow();
  });
});

describe("ClientSettings.pullRequests", () => {
  it("defaults the list state to open and the diff code size to 12px", () => {
    expect(DEFAULT_CLIENT_SETTINGS.pullRequestsDefaultState).toBe(
      DEFAULT_PULL_REQUESTS_DEFAULT_STATE,
    );
    expect(decodeClientSettings({}).pullRequestsDefaultState).toBe("open");
    expect(DEFAULT_CLIENT_SETTINGS.pullRequestsCodeFontSize).toBe(
      DEFAULT_PULL_REQUESTS_CODE_FONT_SIZE,
    );
    expect(decodeClientSettings({}).pullRequestsCodeFontSize).toBe(12);
    expect(DEFAULT_CLIENT_SETTINGS.pullRequestsBodyFontSize).toBe(
      DEFAULT_PULL_REQUESTS_BODY_FONT_SIZE,
    );
    expect(decodeClientSettings({}).pullRequestsBodyFontSize).toBe(14);
  });

  it("accepts valid pull request patches and rejects unknown states", () => {
    expect(
      decodeClientSettingsPatch({
        pullRequestsDefaultState: "merged",
        pullRequestsCodeFontSize: 14,
        pullRequestsBodyFontSize: 15,
      }),
    ).toEqual({
      pullRequestsDefaultState: "merged",
      pullRequestsCodeFontSize: 14,
      pullRequestsBodyFontSize: 15,
    });

    expect(() => decodeClientSettingsPatch({ pullRequestsDefaultState: "draft" })).toThrow();
    expect(() => decodeClientSettingsPatch({ pullRequestsCodeFontSize: 99 })).toThrow();
    expect(() => decodeClientSettingsPatch({ pullRequestsBodyFontSize: 99 })).toThrow();
  });
});

describe("ClientSettings.messagePreviewLineLimits", () => {
  it("defaults monitoring messages to four lines and other messages to ten", () => {
    expect(DEFAULT_CLIENT_SETTINGS.messagePreviewLineLimits).toEqual(
      DEFAULT_MESSAGE_PREVIEW_LINE_LIMITS,
    );
    expect(decodeClientSettings({}).messagePreviewLineLimits).toEqual({
      normal: 10,
      crossThread: 10,
      monitoring: 4,
    });
  });

  it("accepts valid line limit patches and rejects out-of-range values", () => {
    expect(
      decodeClientSettingsPatch({
        messagePreviewLineLimits: { normal: 8, crossThread: 6, monitoring: 3 },
      }).messagePreviewLineLimits,
    ).toEqual({ normal: 8, crossThread: 6, monitoring: 3 });

    expect(() =>
      decodeClientSettingsPatch({
        messagePreviewLineLimits: { normal: 0, crossThread: 6, monitoring: 3 },
      }),
    ).toThrow();
  });
});

describe("ClientSettings.sidebarFontSize", () => {
  it("defaults to the sidebar title font size", () => {
    expect(DEFAULT_CLIENT_SETTINGS.sidebarFontSize).toBe(DEFAULT_SIDEBAR_FONT_SIZE);
    expect(decodeClientSettings({}).sidebarFontSize).toBe(DEFAULT_SIDEBAR_FONT_SIZE);
  });

  describe("ClientSettings.sidebarTranslucency", () => {
    it("defaults to the opaque sidebar", () => {
      expect(DEFAULT_CLIENT_SETTINGS.sidebarTranslucency).toBe(DEFAULT_SIDEBAR_TRANSLUCENCY);
      expect(decodeClientSettings({}).sidebarTranslucency).toBe(DEFAULT_SIDEBAR_TRANSLUCENCY);
    });

    it("accepts known sidebar translucency levels in patches", () => {
      expect(decodeClientSettingsPatch({ sidebarTranslucency: "medium" }).sidebarTranslucency).toBe(
        "medium",
      );
      expect(
        decodeClientSettingsPatch({ sidebarTranslucency: "liquid-glass" }).sidebarTranslucency,
      ).toBe("liquid-glass");
    });

    it("rejects unknown sidebar translucency levels in patches", () => {
      expect(() => decodeClientSettingsPatch({ sidebarTranslucency: "glass" })).toThrow();
    });
  });

  it("accepts valid sidebar font size patches", () => {
    expect(decodeClientSettingsPatch({ sidebarFontSize: 13 }).sidebarFontSize).toBe(13);
  });

  it("rejects invalid sidebar font size patches", () => {
    expect(() => decodeClientSettingsPatch({ sidebarFontSize: 25 })).toThrow();
  });

  describe("ClientSettings.sidebarMetaFontSize", () => {
    it("defaults below the sidebar title font size so metadata stays secondary", () => {
      expect(DEFAULT_CLIENT_SETTINGS.sidebarMetaFontSize).toBe(DEFAULT_SIDEBAR_META_FONT_SIZE);
      expect(decodeClientSettings({}).sidebarMetaFontSize).toBe(DEFAULT_SIDEBAR_META_FONT_SIZE);
      expect(DEFAULT_SIDEBAR_META_FONT_SIZE).toBeLessThan(DEFAULT_SIDEBAR_FONT_SIZE);
    });

    it("accepts valid sidebar metadata font size patches", () => {
      expect(decodeClientSettingsPatch({ sidebarMetaFontSize: 9 }).sidebarMetaFontSize).toBe(9);
    });

    it("rejects invalid sidebar metadata font size patches", () => {
      expect(() => decodeClientSettingsPatch({ sidebarMetaFontSize: 25 })).toThrow();
    });
  });

  describe("ClientSettings.sidebarIconSize", () => {
    it("defaults to the size-3.5 convention in pixels", () => {
      expect(DEFAULT_CLIENT_SETTINGS.sidebarIconSize).toBe(DEFAULT_SIDEBAR_ICON_SIZE);
      expect(decodeClientSettings({}).sidebarIconSize).toBe(DEFAULT_SIDEBAR_ICON_SIZE);
      expect(DEFAULT_SIDEBAR_ICON_SIZE).toBe(14);
    });

    it("accepts valid sidebar icon size patches", () => {
      expect(decodeClientSettingsPatch({ sidebarIconSize: 18 }).sidebarIconSize).toBe(18);
    });

    it("rejects invalid sidebar icon size patches", () => {
      expect(() => decodeClientSettingsPatch({ sidebarIconSize: 25 })).toThrow();
    });
  });

  describe("ClientSettings.composerMetaFontSize", () => {
    it("defaults the under-composer metadata line to 11px", () => {
      expect(DEFAULT_CLIENT_SETTINGS.composerMetaFontSize).toBe(DEFAULT_COMPOSER_META_FONT_SIZE);
      expect(decodeClientSettings({}).composerMetaFontSize).toBe(DEFAULT_COMPOSER_META_FONT_SIZE);
      expect(DEFAULT_COMPOSER_META_FONT_SIZE).toBe(11);
    });

    it("accepts valid composer metadata font size patches", () => {
      expect(decodeClientSettingsPatch({ composerMetaFontSize: 9 }).composerMetaFontSize).toBe(9);
    });

    it("rejects invalid composer metadata font size patches", () => {
      expect(() => decodeClientSettingsPatch({ composerMetaFontSize: 25 })).toThrow();
    });
  });

  describe("ClientSettings.sidebarRowSpacing", () => {
    it("defaults to the default row spacing", () => {
      expect(DEFAULT_CLIENT_SETTINGS.sidebarRowSpacing).toBe(DEFAULT_SIDEBAR_ROW_SPACING);
      expect(decodeClientSettings({}).sidebarRowSpacing).toBe(DEFAULT_SIDEBAR_ROW_SPACING);
    });

    it("accepts known sidebar row spacing levels in patches", () => {
      expect(decodeClientSettingsPatch({ sidebarRowSpacing: "compact" }).sidebarRowSpacing).toBe(
        "compact",
      );
      expect(decodeClientSettingsPatch({ sidebarRowSpacing: "relaxed" }).sidebarRowSpacing).toBe(
        "relaxed",
      );
    });

    it("rejects unknown sidebar row spacing levels in patches", () => {
      expect(() => decodeClientSettingsPatch({ sidebarRowSpacing: "tight" })).toThrow();
    });
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

  it("defaults text generation to Copilot", () => {
    expect(DEFAULT_SERVER_SETTINGS.textGenerationModelSelection).toMatchObject({
      instanceId: "copilot",
      model: "gpt-6-luna",
    });
  });

  it("defaults delegated threads to Copilot gpt-6-luna", () => {
    expect(DEFAULT_SERVER_SETTINGS.delegatedThreadModelSelection).toMatchObject({
      instanceId: "copilot",
      model: "gpt-6-luna",
    });
    expect(decodeServerSettings({}).delegatedThreadModelSelection).toMatchObject({
      instanceId: "copilot",
      model: "gpt-6-luna",
    });
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

describe("RECOMMENDED_FONT_SIZES_BY_UI_DENSITY", () => {
  it("matches the shipped defaults at the default density", () => {
    // The defaults are what a fresh install renders, so the density that ships
    // by default must not silently disagree with them.
    const recommended = RECOMMENDED_FONT_SIZES_BY_UI_DENSITY[DEFAULT_UI_DENSITY];
    for (const [key, size] of Object.entries(recommended)) {
      expect(DEFAULT_CLIENT_SETTINGS[key as keyof typeof recommended], key).toBe(size);
    }
  });

  it("increases monotonically from compact through spacious", () => {
    const order = ["compact", "default", "comfortable", "spacious"] as const;
    const keys = Object.keys(RECOMMENDED_FONT_SIZES_BY_UI_DENSITY.default) as ReadonlyArray<
      keyof (typeof RECOMMENDED_FONT_SIZES_BY_UI_DENSITY)["default"]
    >;
    for (const key of keys) {
      for (let index = 1; index < order.length; index += 1) {
        const previous = RECOMMENDED_FONT_SIZES_BY_UI_DENSITY[order[index - 1]!][key];
        const current = RECOMMENDED_FONT_SIZES_BY_UI_DENSITY[order[index]!][key];
        expect(current, `${key}: ${order[index - 1]!} -> ${order[index]!}`).toBeGreaterThan(
          previous,
        );
      }
    }
  });

  it("keeps sidebar metadata a step below the sidebar title at every density", () => {
    for (const sizes of Object.values(RECOMMENDED_FONT_SIZES_BY_UI_DENSITY)) {
      expect(sizes.sidebarMetaFontSize).toBeLessThan(sizes.sidebarFontSize);
    }
  });
});

describe("ClientSettings.headerSidebarButtons", () => {
  it("defaults all header and sidebar buttons to visible", () => {
    expect(decodeClientSettings({}).headerShowProjectScripts).toBe(true);
    expect(decodeClientSettings({}).headerShowOpenIn).toBe(true);
    expect(decodeClientSettings({}).headerShowGitActions).toBe(true);
    expect(decodeClientSettings({}).headerShowWorkflows).toBe(true);
    expect(decodeClientSettings({}).headerShowWorkflowRuns).toBe(true);
    expect(decodeClientSettings({}).headerShowExportChat).toBe(true);
    expect(decodeClientSettings({}).headerShowInsightsToggle).toBe(true);
    expect(decodeClientSettings({}).headerShowBrowserToggle).toBe(true);
    expect(decodeClientSettings({}).headerShowFilesToggle).toBe(true);
    expect(decodeClientSettings({}).headerShowTerminalToggle).toBe(true);
    expect(decodeClientSettings({}).headerShowDiffToggle).toBe(true);
    expect(decodeClientSettings({}).sidebarShowSearch).toBe(true);
    expect(decodeClientSettings({}).sidebarShowPullRequests).toBe(true);
    expect(decodeClientSettings({}).sidebarShowSkills).toBe(true);
    expect(decodeClientSettings({}).sidebarShowNewThread).toBe(true);
  });

  it("defaults confirms off except the default-branch git guard", () => {
    expect(decodeClientSettings({}).headerExportConfirm).toBe(false);
    expect(decodeClientSettings({}).projectScriptsConfirmRun).toBe(false);
    expect(decodeClientSettings({}).openInUpdatePreferred).toBe(true);
    expect(decodeClientSettings({}).gitConfirmDefaultBranch).toBe(true);
    expect(decodeClientSettings({}).gitShowQuickAction).toBe(true);
    expect(decodeClientSettings({}).workflowConfirmRun).toBe(false);
    expect(decodeClientSettings({}).workflowPrewarmOnHover).toBe(true);
    expect(decodeClientSettings({}).workflowRunsShowBadge).toBe(true);
    expect(decodeClientSettings({}).sidebarSearchShowShortcut).toBe(true);
    expect(decodeClientSettings({}).sidebarNewThreadConfirm).toBe(false);
    expect(decodeClientSettings({}).localRebuildStalenessCheckMinutes).toBe(15);
  });

  it("accepts and bounds the local rebuild staleness check interval", () => {
    expect(decodeClientSettingsPatch({ localRebuildStalenessCheckMinutes: 30 })).toEqual({
      localRebuildStalenessCheckMinutes: 30,
    });
    expect(decodeClientSettingsPatch({ localRebuildStalenessCheckMinutes: 0 })).toEqual({
      localRebuildStalenessCheckMinutes: 0,
    });
    expect(() => decodeClientSettingsPatch({ localRebuildStalenessCheckMinutes: -1 })).toThrow();
    expect(() => decodeClientSettingsPatch({ localRebuildStalenessCheckMinutes: 1441 })).toThrow();
    expect(() => decodeClientSettingsPatch({ localRebuildStalenessCheckMinutes: 2.5 })).toThrow();
  });

  it("accepts visibility and behavior patches", () => {
    expect(
      decodeClientSettingsPatch({
        headerShowGitActions: false,
        headerShowExportChat: false,
        sidebarShowSkills: false,
        headerExportConfirm: true,
        gitShowQuickAction: false,
        workflowPrewarmOnHover: false,
      }),
    ).toEqual({
      headerShowGitActions: false,
      headerShowExportChat: false,
      sidebarShowSkills: false,
      headerExportConfirm: true,
      gitShowQuickAction: false,
      workflowPrewarmOnHover: false,
    });
  });
});

const decodeDeviceHostSettings = Schema.decodeSync(ServerSettings);

it("validates remote device hosts and rejects ambiguous host ids", () => {
  const host = { id: "mini", label: "Mac mini", target: "user@mini", port: 2222 };
  expect(decodeDeviceHostSettings({ deviceHosts: [host] }).deviceHosts).toEqual([host]);
  expect(() => decodeDeviceHostSettings({ deviceHosts: [host, host] })).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, id: "local" }] })).toThrow();
  expect(() =>
    decodeDeviceHostSettings({ deviceHosts: [{ ...host, target: "-oProxyCommand=bad" }] }),
  ).toThrow();
  expect(() => decodeDeviceHostSettings({ deviceHosts: [{ ...host, port: 0 }] })).toThrow();
});
