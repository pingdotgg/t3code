import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";

import {
  deriveProviderModelsForDisplay,
  nextCustomModelsConfig,
  ProviderInstanceCard,
} from "./ProviderInstanceCard";

describe("deriveProviderModelsForDisplay", () => {
  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: ["kept-custom"],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });

  it("prunes deleted Claude custom model profiles", () => {
    expect(
      nextCustomModelsConfig(
        {
          customModels: ["kept", "removed"],
          customModelProfiles: {
            kept: { capabilities: { reasoning: { levels: ["high"] } } },
            removed: { capabilities: { reasoning: { levels: ["low"] } } },
          },
        },
        ["kept"],
        true,
      ),
    ).toEqual({
      customModels: ["kept"],
      customModelProfiles: {
        kept: { capabilities: { reasoning: { levels: ["high"] } } },
      },
    });
  });

  it("removes an empty Claude custom model profile map", () => {
    expect(
      nextCustomModelsConfig(
        {
          customModels: ["removed"],
          customModelProfiles: {
            removed: { capabilities: { reasoning: { levels: ["high"] } } },
          },
        },
        [],
        true,
      ),
    ).toEqual({ customModels: [] });
  });

  it("preserves opaque profiles for non-Claude providers", () => {
    expect(
      nextCustomModelsConfig(
        {
          customModels: ["removed"],
          customModelProfiles: { removed: { future: true } },
        },
        [],
      ),
    ).toEqual({
      customModels: [],
      customModelProfiles: { removed: { future: true } },
    });
  });

  it("shows a redacted provider email in the editor header status line", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const driver = ProviderDriverKind.make("codex");
    const liveProvider: ServerProvider = {
      instanceId,
      driver,
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated", email: "developer@example.com" },
      checkedAt: "2026-08-27T12:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    };

    const markup = renderToStaticMarkup(
      createElement(ProviderInstanceCard, {
        instanceId,
        instance: { driver },
        driverOption: undefined,
        liveProvider,
        mode: "editor",
        onUpdate: () => undefined,
        hiddenModels: [],
        favoriteModels: [],
        modelOrder: [],
        onHiddenModelsChange: () => undefined,
        onFavoriteModelsChange: () => undefined,
        onModelOrderChange: () => undefined,
      }),
    );

    expect(markup).toContain("Authenticated as");
    expect(markup).toContain('aria-label="Toggle account email visibility"');
    expect(markup).toContain("blur-[2px]");
    expect(markup).not.toContain("developer@example.com");
  });
  it("surfaces a failed probe message in both the list row and the editor", () => {
    const instanceId = ProviderInstanceId.make("codex_work");
    const driver = ProviderDriverKind.make("codex");
    const message =
      "Codex app-server provider probe failed: Cannot create Codex shadow home entry 'auth.json' because '/home/me/.codex-t3/work/auth.json' already exists and is not a symlink.";
    const liveProvider: ServerProvider = {
      instanceId,
      driver,
      enabled: true,
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      checkedAt: "2026-08-28T12:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
      message,
    };
    const props = {
      instanceId,
      instance: { driver },
      driverOption: undefined,
      liveProvider,
      onUpdate: () => undefined,
      hiddenModels: [],
      favoriteModels: [],
      modelOrder: [],
      onHiddenModelsChange: () => undefined,
      onFavoriteModelsChange: () => undefined,
      onModelOrderChange: () => undefined,
    } as const;

    for (const mode of ["list", "editor"] as const) {
      const markup = renderToStaticMarkup(createElement(ProviderInstanceCard, { ...props, mode }));
      expect(markup).toContain("Unavailable");
      expect(markup).toContain("is not a symlink");
    }
  });
});
