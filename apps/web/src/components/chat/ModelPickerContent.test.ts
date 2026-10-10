import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  adjacentModelPickerProvider,
  groupOpenCodeModelsBySubProvider,
  openCodeSectionHeadings,
  resolveModelPickerSelectedModel,
  shouldIncludeModelPickerOption,
  shouldOfferModelPickerSetup,
} from "./ModelPickerContent";
import { modelPickerModelKey } from "./modelPickerKeys";

function entry(status: ServerProvider["status"], driver = "opencode") {
  return deriveProviderInstanceEntries([
    {
      instanceId: ProviderInstanceId.make(`${driver}_work`),
      driver: ProviderDriverKind.make(driver),
      enabled: true,
      installed: true,
      version: null,
      status,
      auth: { status: "authenticated" },
      checkedAt: "2026-08-28T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ])[0]!;
}

describe("shouldIncludeModelPickerOption", () => {
  it.each(["ready", "error"] as const)(
    "never offers the internal Antigravity default marker as a model when %s",
    (status) => {
      const providerEntry = entry(status, "antigravity");
      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option: {
            slug: ANTIGRAVITY_DEFAULT_MODEL,
            name: ANTIGRAVITY_DEFAULT_MODEL,
            isUnavailable: true,
          },
          activeInstanceId: providerEntry.instanceId,
          activeModel: ANTIGRAVITY_DEFAULT_MODEL,
        }),
      ).toBe(false);
    },
  );

  it.each([
    ["opencode", "error"],
    ["opencode", "warning"],
    ["antigravity", "error"],
    ["antigravity", "warning"],
  ] as const)(
    "keeps only the active synthetic %s row when the provider status is %s",
    (driver, status) => {
      const providerEntry = entry(status, driver);
      const activeInstanceId = providerEntry.instanceId;
      const activeModel = "missing-model";

      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option: {
            slug: activeModel,
            name: activeModel,
            isUnavailable: true,
          },
          activeInstanceId,
          activeModel,
        }),
      ).toBe(true);
      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option: { slug: "stale/model", name: "Stale model" },
          activeInstanceId,
          activeModel,
        }),
      ).toBe(false);
      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option: {
            slug: "other/missing",
            name: "Other missing",
            isUnavailable: true,
          },
          activeInstanceId,
          activeModel,
        }),
      ).toBe(false);
      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option: { slug: activeModel, name: activeModel, isUnavailable: true },
          activeInstanceId: ProviderInstanceId.make(`${driver}_personal`),
          activeModel,
        }),
      ).toBe(false);
    },
  );
});

describe("resolveModelPickerSelectedModel", () => {
  it("follows the catalog default for the marker but keeps an explicit native model", () => {
    const driverKind = ProviderDriverKind.make("antigravity");
    const previousOptions = [
      { slug: "gemini-fast", name: "Gemini Fast", aliases: [ANTIGRAVITY_DEFAULT_MODEL] },
      { slug: "gemini-pro", name: "Gemini Pro" },
    ];
    const nextOptions = [
      { slug: "gemini-fast", name: "Gemini Fast" },
      { slug: "gemini-pro", name: "Gemini Pro", aliases: [ANTIGRAVITY_DEFAULT_MODEL] },
    ];

    expect(
      resolveModelPickerSelectedModel({
        driverKind,
        model: ANTIGRAVITY_DEFAULT_MODEL,
        options: previousOptions,
      })?.slug,
    ).toBe("gemini-fast");
    expect(
      resolveModelPickerSelectedModel({
        driverKind,
        model: ANTIGRAVITY_DEFAULT_MODEL,
        options: nextOptions,
      })?.slug,
    ).toBe("gemini-pro");
    expect(
      resolveModelPickerSelectedModel({
        driverKind,
        model: "gemini-fast",
        options: nextOptions,
      })?.slug,
    ).toBe("gemini-fast");
  });

  it("does not guess the default from the first model in a catalog", () => {
    expect(
      resolveModelPickerSelectedModel({
        driverKind: ProviderDriverKind.make("antigravity"),
        model: ANTIGRAVITY_DEFAULT_MODEL,
        options: [{ slug: "gemini-fast", name: "Gemini Fast" }],
      }),
    ).toBeUndefined();
  });
});

describe("shouldOfferModelPickerSetup", () => {
  const availableModel = { slug: "gemini-3.1-pro", name: "Gemini 3.1 Pro" };

  it("offers setup before an Antigravity account has models", () => {
    expect(shouldOfferModelPickerSetup(entry("error", "antigravity"), [])).toBe(true);
  });

  it("offers setup after sign-out even if a model remains cached", () => {
    const providerEntry = entry("ready", "antigravity");
    expect(
      shouldOfferModelPickerSetup(
        {
          ...providerEntry,
          snapshot: { ...providerEntry.snapshot, auth: { status: "unauthenticated" } },
        },
        [availableModel],
      ),
    ).toBe(true);
  });

  it("offers setup when the only model is an unavailable saved selection", () => {
    expect(
      shouldOfferModelPickerSetup(entry("ready", "antigravity"), [
        { ...availableModel, isUnavailable: true },
      ]),
    ).toBe(true);
  });

  it("does not offer setup for a ready account with available models", () => {
    expect(shouldOfferModelPickerSetup(entry("ready", "antigravity"), [availableModel])).toBe(
      false,
    );
  });

  it("does not restore a disabled provider while its status snapshot is stale", () => {
    expect(
      shouldOfferModelPickerSetup({ ...entry("error", "antigravity"), enabled: false }, []),
    ).toBe(false);
  });

  it("keeps providers without integrated setup on their existing path", () => {
    expect(shouldOfferModelPickerSetup(entry("error", "codex"), [])).toBe(false);
  });

  it("uses the environment's setup capability for other drivers", () => {
    const providerEntry = entry("error", "custom_driver");
    expect(
      shouldOfferModelPickerSetup(
        {
          ...providerEntry,
          snapshot: {
            ...providerEntry.snapshot,
            setup: { canAuthenticate: true, canInstall: false },
          },
        },
        [],
      ),
    ).toBe(true);
  });
});

describe("adjacentModelPickerProvider", () => {
  const codex = entry("ready", "codex");
  const claude = entry("ready", "claudeAgent");
  const unavailable = entry("error");
  const input = {
    entries: [codex, unavailable, claude],
    disabledInstanceIds: undefined,
    selectableUnavailableInstanceIds: undefined,
  };

  it("wraps through favorites and ready instances, skipping unavailable providers", () => {
    expect(
      adjacentModelPickerProvider({ ...input, selectedInstanceId: codex.instanceId, direction: 1 }),
    ).toBe(claude.instanceId);
    expect(
      adjacentModelPickerProvider({ ...input, selectedInstanceId: "favorites", direction: -1 }),
    ).toBe(claude.instanceId);
    expect(
      adjacentModelPickerProvider({
        ...input,
        selectedInstanceId: claude.instanceId,
        direction: 1,
      }),
    ).toBe("favorites");
  });

  it("keeps thread locks and the selected unavailable catalog", () => {
    expect(
      adjacentModelPickerProvider({
        ...input,
        disabledInstanceIds: new Set([claude.instanceId]),
        selectedInstanceId: codex.instanceId,
        direction: 1,
      }),
    ).toBe("favorites");
    expect(
      adjacentModelPickerProvider({
        ...input,
        selectableUnavailableInstanceIds: new Set([unavailable.instanceId]),
        selectedInstanceId: codex.instanceId,
        direction: 1,
      }),
    ).toBe(unavailable.instanceId);
  });

  it("handles an empty catalog and a removed selection in either direction", () => {
    expect(
      adjacentModelPickerProvider({
        ...input,
        entries: [],
        selectedInstanceId: codex.instanceId,
        direction: -1,
      }),
    ).toBe("favorites");
    expect(
      adjacentModelPickerProvider({
        ...input,
        selectedInstanceId: unavailable.instanceId,
        direction: 1,
      }),
    ).toBe("favorites");
    expect(
      adjacentModelPickerProvider({
        ...input,
        selectedInstanceId: unavailable.instanceId,
        direction: -1,
      }),
    ).toBe(claude.instanceId);
  });
});

describe("OpenCode upstream-provider sections", () => {
  const instanceId = ProviderInstanceId.make("opencode");
  const opencode = ProviderDriverKind.make("opencode");
  const model = (slug: string, subProvider?: string, driverKind = opencode) => ({
    slug,
    instanceId,
    driverKind,
    ...(subProvider ? { subProvider } : {}),
  });

  it("gives each OpenCode provider its own section, ordered by name, keeping model order", () => {
    const models = [
      model("anthropic/claude-sonnet-5", "Anthropic"),
      model("opencode/claude-sonnet-5", "OpenCode Zen"),
      model("openrouter/claude-sonnet-5", "OpenRouter"),
      model("opencode-go/deepseek-v4-flash", "OpenCode Go"),
      model("opencode/deepseek-v4-flash", "OpenCode Zen"),
      model("openai/gpt-5.5", "OpenAI"),
      model("anthropic/claude-opus-5", "Anthropic"),
      model("opencode-go/kimi-k2.6", "OpenCode Go"),
    ];
    const grouped = groupOpenCodeModelsBySubProvider(models);

    expect(grouped.map((item) => item.slug)).toEqual([
      "anthropic/claude-sonnet-5",
      "anthropic/claude-opus-5",
      "openai/gpt-5.5",
      "opencode-go/deepseek-v4-flash",
      "opencode-go/kimi-k2.6",
      "opencode/claude-sonnet-5",
      "opencode/deepseek-v4-flash",
      "openrouter/claude-sonnet-5",
    ]);
    expect([...openCodeSectionHeadings(grouped)]).toEqual([
      [modelPickerModelKey(instanceId, "anthropic/claude-sonnet-5"), "Anthropic"],
      [modelPickerModelKey(instanceId, "openai/gpt-5.5"), "OpenAI"],
      [modelPickerModelKey(instanceId, "opencode-go/deepseek-v4-flash"), "OpenCode Go"],
      [modelPickerModelKey(instanceId, "opencode/claude-sonnet-5"), "OpenCode Zen"],
      [modelPickerModelKey(instanceId, "openrouter/claude-sonnet-5"), "OpenRouter"],
    ]);
  });

  it("leaves single-source OpenCode catalogs and other providers untouched", () => {
    const zenOnly = [model("opencode/b", "OpenCode Zen"), model("opencode/a", "OpenCode Zen")];
    expect(groupOpenCodeModelsBySubProvider(zenOnly)).toBe(zenOnly);
    expect(openCodeSectionHeadings(zenOnly).size).toBe(0);

    const copilot = ProviderDriverKind.make("copilot");
    const otherDriver = [model("b", "GitHub", copilot), model("a", "Azure", copilot)];
    expect(groupOpenCodeModelsBySubProvider(otherDriver)).toBe(otherDriver);
    expect(openCodeSectionHeadings(otherDriver).size).toBe(0);
  });

  it("puts models without an upstream provider last", () => {
    const grouped = groupOpenCodeModelsBySubProvider([
      model("local/a"),
      model("opencode-go/b", "OpenCode Go"),
    ]);
    expect(grouped.map((item) => item.slug)).toEqual(["opencode-go/b", "local/a"]);
    expect([...openCodeSectionHeadings(grouped).values()]).toEqual(["OpenCode Go", "Other"]);
  });
});
