import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  getDefaultProviderInstanceModel,
  isProviderInstancePickerReady,
  isProviderInstancePickerVisible,
  resolveDefaultProviderModelSelection,
  resolveSelectableProviderInstance,
  resolveProviderDriverKindForInstanceSelection,
} from "./providerInstances";

function provider(input: {
  provider: ProviderDriverKind;
  instanceId: string;
  enabled?: boolean;
  availability?: ServerProvider["availability"];
  displayName?: string;
  status?: ServerProvider["status"];
  models?: ServerProvider["models"];
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.provider,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: input.status ?? "ready",
    ...(input.availability ? { availability: input.availability } : {}),
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: input.models ?? [],
    slashCommands: [],
    skills: [],
  };
}

const model = (slug: string, isCustom = false, isDefault = false) => ({
  slug,
  name: slug,
  isCustom,
  ...(isDefault ? { isDefault: true } : {}),
  capabilities: {},
});

describe("isProviderInstancePickerReady", () => {
  it("rejects a disabled instance even while its last probe status is ready", () => {
    const [entry] = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: "codex",
        enabled: false,
      }),
    ]);

    expect(entry?.status).toBe("ready");
    expect(entry && isProviderInstancePickerReady(entry)).toBe(false);
  });

  it("accepts an enabled, available, ready instance", () => {
    const [entry] = deriveProviderInstanceEntries([
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
    ]);

    expect(entry && isProviderInstancePickerReady(entry)).toBe(true);
  });
});

describe("isProviderInstancePickerVisible", () => {
  it("keeps enabled instances in the rail and removes disabled instances", () => {
    const [enabledEntry, disabledEntry] = deriveProviderInstanceEntries([
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claudeAgent",
        enabled: false,
      }),
    ]);

    expect(enabledEntry && isProviderInstancePickerVisible(enabledEntry)).toBe(true);
    expect(disabledEntry && isProviderInstancePickerVisible(disabledEntry)).toBe(false);
  });
});

describe("applyProviderInstanceSettings", () => {
  it("uses settings when a streamed snapshot still reports a disabled default as enabled", () => {
    const entries = deriveProviderInstanceEntries([
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
    ]);
    const [entry] = applyProviderInstanceSettings(entries, {
      providerInstances: {
        [ProviderInstanceId.make("codex")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: false,
        },
      },
      providers: {} as never,
    });

    expect(entry?.enabled).toBe(false);
  });

  it("treats a removed custom instance snapshot as disabled", () => {
    const entries = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claude_work",
      }),
    ]);
    const [entry] = applyProviderInstanceSettings(entries, {
      providerInstances: {},
      providers: {} as never,
    });

    expect(entry?.enabled).toBe(false);
  });
});

describe("deriveProviderInstanceEntries", () => {
  it("uses explicit instance id and driver kind from the snapshot", () => {
    const snapshot = provider({
      provider: ProviderDriverKind.make("codex"),
      instanceId: "codex_personal",
    });
    const [entry] = deriveProviderInstanceEntries([snapshot]);

    expect(entry?.instanceId).toBe("codex_personal");
    expect(entry?.driverKind).toBe("codex");
    expect(entry?.isDefault).toBe(false);
  });
});

describe("resolveSelectableProviderInstance", () => {
  it("returns the requested instance when it is enabled and available", () => {
    const requested = ProviderInstanceId.make("claude_work");
    const providers = [
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: requested }),
    ];

    expect(resolveSelectableProviderInstance(providers, requested)).toBe(requested);
  });

  it("falls back to the first enabled and available instance", () => {
    const disabled = ProviderInstanceId.make("codex");
    const fallback = ProviderInstanceId.make("claudeAgent");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: disabled,
        enabled: false,
      }),
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: fallback }),
    ];

    expect(resolveSelectableProviderInstance(providers, disabled)).toBe(fallback);
  });

  it("prefers a ready instance over an enabled one whose driver cannot start", () => {
    const notInstalled = ProviderInstanceId.make("codex");
    const ready = ProviderInstanceId.make("claudeAgent");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: notInstalled,
        status: "error",
      }),
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: ready }),
    ];

    expect(resolveSelectableProviderInstance(providers, undefined)).toBe(ready);
  });

  it("prefers an unprobed (warning) instance over one whose probe errored", () => {
    const notInstalled = ProviderInstanceId.make("codex");
    const unprobed = ProviderInstanceId.make("claudeAgent");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: notInstalled,
        status: "error",
      }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: unprobed,
        status: "warning",
      }),
    ];

    expect(resolveSelectableProviderInstance(providers, undefined)).toBe(unprobed);
  });

  it("keeps a requested instance even when its probe errored", () => {
    const requested = ProviderInstanceId.make("codex");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: requested,
        status: "error",
      }),
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: "claudeAgent" }),
    ];

    expect(resolveSelectableProviderInstance(providers, requested)).toBe(requested);
  });

  it("does not invent an errored instance as a new-user default", () => {
    const notInstalled = ProviderInstanceId.make("codex");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: notInstalled,
        status: "error",
      }),
    ];

    expect(resolveSelectableProviderInstance(providers, undefined)).toBeUndefined();
  });

  it("does not return disabled, unavailable, or unknown instances when none are sendable", () => {
    const disabled = ProviderInstanceId.make("codex");
    const unavailable = ProviderInstanceId.make("claudeAgent");
    const unknown = ProviderInstanceId.make("removed_instance");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: disabled,
        enabled: false,
      }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: unavailable,
        availability: "unavailable",
      }),
    ];

    expect(resolveSelectableProviderInstance(providers, disabled)).toBeUndefined();
    expect(resolveSelectableProviderInstance(providers, unavailable)).toBeUndefined();
    expect(resolveSelectableProviderInstance(providers, unknown)).toBeUndefined();
  });
});

describe("resolveProviderDriverKindForInstanceSelection", () => {
  it("maps custom provider instance ids back to their driver kind", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claude_openrouter",
        displayName: "Claude OpenRouter",
      }),
    ];
    const entries = deriveProviderInstanceEntries(providers);

    expect(
      resolveProviderDriverKindForInstanceSelection(
        entries,
        providers,
        ProviderInstanceId.make("claude_openrouter"),
      ),
    ).toBe("claudeAgent");
  });

  it("does not guess a provider kind when the instance selection is unknown", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex", enabled: false }),
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: "claudeAgent" }),
    ];
    const entries = deriveProviderInstanceEntries(providers);

    expect(
      resolveProviderDriverKindForInstanceSelection(
        entries,
        providers,
        ProviderInstanceId.make("removed_instance"),
      ),
    ).toBeUndefined();
  });
});

describe("getDefaultProviderInstanceModel", () => {
  it("uses the instance's own models, not the default instance of the kind", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claude_openrouter",
        models: [model("openai/gpt-5.5", true), model("claude-opus-4-8")],
      }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claudeAgent",
        models: [model("claude-sonnet-5")],
      }),
    ];

    expect(
      getDefaultProviderInstanceModel(providers, ProviderInstanceId.make("claude_openrouter")),
    ).toBe("claude-opus-4-8");
  });

  it("falls back to the driver default when the instance reports no models", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: "claudeAgent" }),
    ];

    const resolved = getDefaultProviderInstanceModel(
      providers,
      ProviderInstanceId.make("claudeAgent"),
    );
    expect(typeof resolved).toBe("string");
    expect(resolved?.length).toBeGreaterThan(0);
  });

  it("honors the instance's declared default before model-list order", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claudeAgent",
        models: [model("claude-sonnet-5"), model("claude-opus-4-8", false, true)],
      }),
    ];

    expect(getDefaultProviderInstanceModel(providers, ProviderInstanceId.make("claudeAgent"))).toBe(
      "claude-opus-4-8",
    );
  });

  it("returns undefined for an unknown instance", () => {
    expect(
      getDefaultProviderInstanceModel([], ProviderInstanceId.make("removed_instance")),
    ).toBeUndefined();
  });
});

describe("resolveDefaultProviderModelSelection", () => {
  it.each([
    ["codex", "codex", "gpt-5.6"],
    ["claudeAgent", "claudeAgent", "claude-fable-5"],
    ["cursor", "cursor", "composer-2"],
  ])("uses the only available %s instance", (driver, instanceId, modelSlug) => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make(driver),
        instanceId,
        models: [model(modelSlug, false, true)],
      }),
    ];

    expect(resolveDefaultProviderModelSelection(providers, null)).toEqual({
      instanceId,
      model: modelSlug,
    });
  });

  it("preserves a valid stored selection including its options", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claudeAgent",
        models: [model("claude-opus-4-8")],
      }),
    ];
    const stored = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "custom-model",
      options: [{ id: "effort", value: "high" }],
    };

    expect(resolveDefaultProviderModelSelection(providers, stored)).toBe(stored);
  });

  it("replaces a stale stored instance with the first ready instance and its model", () => {
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: "codex",
        status: "warning",
        models: [model("gpt-5.6")],
      }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claudeAgent",
        models: [model("claude-opus-4-8", false, true)],
      }),
    ];

    expect(
      resolveDefaultProviderModelSelection(providers, {
        instanceId: ProviderInstanceId.make("removed-provider"),
        model: "stale-model",
      }),
    ).toEqual({ instanceId: "claudeAgent", model: "claude-opus-4-8" });
  });

  it.each([{ enabled: false }, { availability: "unavailable" as const }])(
    "replaces an unavailable stored instance deterministically",
    (requestedState) => {
      const providers = [
        provider({
          provider: ProviderDriverKind.make("codex"),
          instanceId: "codex",
          models: [model("gpt-5.6")],
          ...requestedState,
        }),
        provider({
          provider: ProviderDriverKind.make("claudeAgent"),
          instanceId: "claudeAgent",
          models: [model("claude-opus-4-8", false, true)],
        }),
      ];

      expect(
        resolveDefaultProviderModelSelection(providers, {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6",
        }),
      ).toEqual({ instanceId: "claudeAgent", model: "claude-opus-4-8" });
    },
  );

  it("returns no selection for empty, disabled, unavailable, or error-only profiles", () => {
    expect(resolveDefaultProviderModelSelection([], null)).toBeNull();
    expect(
      resolveDefaultProviderModelSelection(
        [
          provider({
            provider: ProviderDriverKind.make("codex"),
            instanceId: "codex",
            enabled: false,
          }),
        ],
        null,
      ),
    ).toBeNull();
    expect(
      resolveDefaultProviderModelSelection(
        [
          provider({
            provider: ProviderDriverKind.make("codex"),
            instanceId: "codex",
            availability: "unavailable",
          }),
        ],
        null,
      ),
    ).toBeNull();
    expect(
      resolveDefaultProviderModelSelection(
        [
          provider({
            provider: ProviderDriverKind.make("codex"),
            instanceId: "codex",
            status: "error",
          }),
        ],
        null,
      ),
    ).toBeNull();
  });
});
