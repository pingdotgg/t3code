import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { ProviderInstanceId, type ProviderOptionSelection } from "@t3tools/contracts";
import { getProviderOptionDescriptors } from "@t3tools/shared/model";

import type { ModelOption } from "../../lib/modelOptions";
import { appAtomRegistry } from "../../state/atom-registry";
import { modelOptionMemoryAtom } from "../../state/use-composer-drafts";
import {
  rememberModelOptions,
  withRememberedModelOptions,
} from "../../state/use-model-option-memory";
import {
  canCommitPendingModel,
  overlayPendingOptionDescriptors,
  partitionThreadSettingsDescriptors,
  pendingModelAfterPress,
  resolveDefaultProviderFilter,
  resolveEffectiveProviderFilter,
  resolvePendingRuntimeMode,
} from "./thread-settings-sheet-state";

function modelOption(
  model: string,
  options: ReadonlyArray<ProviderOptionSelection> = [],
): ModelOption {
  return {
    key: `codex:${model}`,
    label: model,
    subtitle: "",
    providerKey: "codex",
    providerLabel: "Codex",
    providerDriver: "codex",
    isDefault: false,
    isLegacy: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "medium", label: "Medium", isDefault: true },
            { id: "high", label: "High" },
          ],
          currentValue: "medium",
        },
        {
          id: "serviceTier",
          label: "Service Tier",
          type: "select",
          options: [
            { id: "default", label: "Standard", isDefault: true },
            { id: "priority", label: "Fast" },
          ],
          currentValue: "default",
        },
      ],
    },
    selection: {
      instanceId: ProviderInstanceId.make("codex"),
      model,
      options,
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  appAtomRegistry.set(modelOptionMemoryAtom, {});
});

describe("thread settings sheet state", () => {
  it("revalidates a staged permission against the current model and workspace policy", () => {
    expect(resolvePendingRuntimeMode(null, [])).toBeNull();
    expect(resolvePendingRuntimeMode("full-access", [{ mode: "full-access" }])).toBe("full-access");
    expect(
      resolvePendingRuntimeMode("full-access", [{ mode: "approval-required" }]),
    ).toBeUndefined();
    expect(
      resolvePendingRuntimeMode("full-access", [
        { mode: "full-access", disabledReason: "Managed policy" },
      ]),
    ).toBeUndefined();
  });

  it("preserves untouched descriptor defaults when overlaying partial staged options", () => {
    const descriptors = [
      {
        id: "effort",
        label: "Reasoning",
        type: "select" as const,
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
        ],
        currentValue: "high",
      },
      {
        id: "ultracode",
        label: "Ultracode",
        type: "boolean" as const,
        currentValue: false,
      },
    ];

    expect(
      overlayPendingOptionDescriptors(descriptors, [{ id: "ultracode", value: true }]).map(
        ({ id, currentValue }) => ({ id, currentValue }),
      ),
    ).toEqual([
      { id: "effort", currentValue: "high" },
      { id: "ultracode", currentValue: true },
    ]);
  });

  it("partitions reasoning, speed, ultracode, and non-reasoning selects without duplicating serviceTier", () => {
    const serviceTierOnly = partitionThreadSettingsDescriptors([
      {
        id: "serviceTier",
        label: "Service Tier",
        type: "select",
        options: [
          { id: "default", label: "Standard", isDefault: true },
          { id: "priority", label: "Fast" },
        ],
        currentValue: "default",
      },
      {
        id: "agent",
        label: "Agent",
        type: "select",
        options: [{ id: "build", label: "Build", isDefault: true }],
        currentValue: "build",
      },
      {
        id: "ultracode",
        label: "Ultracode",
        type: "boolean",
        currentValue: false,
      },
    ]);

    expect(serviceTierOnly.reasoning).toBeNull();
    expect(serviceTierOnly.speed?.id).toBe("serviceTier");
    expect(serviceTierOnly.ultracode?.id).toBe("ultracode");
    expect(serviceTierOnly.extraOptions.map((descriptor) => descriptor.id)).toEqual(["agent"]);
  });

  it("defaults to Favorites only when visible favorites exist and widens search from Favorites", () => {
    const model = modelOption("gpt-next");
    const groups = [{ providerKey: "codex", providerLabel: "Codex", models: [model] }];

    expect(
      resolveDefaultProviderFilter({
        providerGroups: groups,
        favoriteKeys: new Set(),
        favoritesFilter: "@favorites",
      }),
    ).toBeNull();
    expect(
      resolveDefaultProviderFilter({
        providerGroups: groups,
        favoriteKeys: new Set([model.key]),
        favoritesFilter: "@favorites",
      }),
    ).toBe("@favorites");
    expect(
      resolveDefaultProviderFilter({
        providerGroups: groups,
        favoriteKeys: new Set([model.key]),
        lockedProviderInstanceId: ProviderInstanceId.make("codex"),
        favoritesFilter: "@favorites",
      }),
    ).toBeNull();
    expect(
      resolveEffectiveProviderFilter({
        userFilter: undefined,
        defaultFilter: "@favorites",
        searchQuery: "haiku",
        manageHidden: false,
        favoritesFilter: "@favorites",
      }),
    ).toBeNull();
    expect(
      resolveEffectiveProviderFilter({
        userFilter: "codex",
        defaultFilter: "@favorites",
        searchQuery: "haiku",
        manageHidden: false,
        favoritesFilter: "@favorites",
      }),
    ).toBe("codex");
  });
  it("preserves in-progress edits when the staged model is pressed again", () => {
    rememberModelOptions("codex", "gpt-next", [{ id: "effort", value: "medium" }]);
    const pending = modelOption("gpt-next", [{ id: "effort", value: "high" }]);

    expect(
      pendingModelAfterPress({
        current: pending,
        pressed: modelOption("gpt-next"),
        pressedIsApplied: false,
        restoreSelection: withRememberedModelOptions,
      })?.selection.options,
    ).toEqual([{ id: "effort", value: "high" }]);
  });

  it("previews remembered options before Save when switching models", () => {
    const remembered = [
      { id: "effort", value: "high" },
      { id: "serviceTier", value: "priority" },
    ];
    rememberModelOptions("codex", "gpt-other", remembered);
    const pressed = modelOption("gpt-other");

    const pending = pendingModelAfterPress({
      current: modelOption("gpt-next"),
      pressed,
      pressedIsApplied: false,
      restoreSelection: withRememberedModelOptions,
    });

    expect(pending?.selection).toEqual({ ...pressed.selection, options: remembered });
    const preview = getProviderOptionDescriptors({
      caps: pressed.capabilities!,
      selections: pending?.selection.options,
    });
    expect(preview.map(({ id, currentValue }) => ({ id, value: currentValue }))).toEqual(
      remembered,
    );
    expect(pending?.selection).toEqual(withRememberedModelOptions(pressed.selection));
  });

  it("keeps catalog defaults for scheduled-task picks even when options are remembered", () => {
    rememberModelOptions("codex", "gpt-other", [
      { id: "effort", value: "high" },
      { id: "serviceTier", value: "priority" },
    ]);
    const pressed = modelOption("gpt-other");

    const pending = pendingModelAfterPress({
      current: modelOption("gpt-next"),
      pressed,
      pressedIsApplied: false,
    });

    expect(pending?.selection).toEqual(pressed.selection);
    const preview = getProviderOptionDescriptors({
      caps: pressed.capabilities!,
      selections: pending?.selection.options,
    });
    expect(preview.map(({ id, currentValue }) => ({ id, value: currentValue }))).toEqual([
      { id: "effort", value: "medium" },
      { id: "serviceTier", value: "default" },
    ]);
  });

  // regression: #16816 sync model favorites and visibility across clients
  it("cannot select a hidden model exposed only for visibility management", () => {
    const pending = modelOption("gpt-next");
    expect(
      canCommitPendingModel(pending, [
        { providerKey: "codex", providerLabel: "Codex", models: [{ ...pending, isHidden: true }] },
      ]),
    ).toBe(false);
  });

  it("cannot save a staged model after sign-out removes it from the catalog", () => {
    const pending = modelOption("gemini-native");
    const group = { providerKey: "codex", providerLabel: "Codex", models: [pending] };

    expect(canCommitPendingModel(pending, [group])).toBe(true);
    expect(canCommitPendingModel(pending, [])).toBe(false);
    expect(
      canCommitPendingModel(pending, [
        {
          ...group,
          models: [{ ...pending, isUnavailable: true }],
        },
      ]),
    ).toBe(false);
  });
});
