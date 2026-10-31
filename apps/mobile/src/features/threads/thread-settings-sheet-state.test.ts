import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import {
  EnvironmentId,
  ProviderInstanceId,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
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
  hiddenModelOverrideKey,
  pendingModelAfterPress,
  settleHiddenModelOverride,
  withHiddenModelOverrides,
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

  // regression: #28318 hiding a model waited for the settings write before the eye changed
  it("shows visibility changes until the server confirms them and uses them throughout the picker", () => {
    const environmentId = EnvironmentId.make("env-a");
    const model = { ...modelOption("gpt-next"), canHide: true, isHidden: false };
    const groups = (isHidden: boolean) => [
      { providerKey: "codex", providerLabel: "Codex", models: [{ ...model, isHidden }] },
    ];
    const isHidden = (shown: ReturnType<typeof withHiddenModelOverrides>): boolean | undefined =>
      shown.providerGroups[0]?.models[0]?.isHidden;
    const key = hiddenModelOverrideKey(environmentId, model.selection);
    const override = { hidden: true };
    const overrides = new Map([[key, override]]);

    expect(isHidden(withHiddenModelOverrides(groups(false), environmentId, overrides))).toBe(true);
    expect(
      isHidden(withHiddenModelOverrides(groups(false), EnvironmentId.make("env-b"), overrides)),
    ).toBe(false);
    expect(
      withHiddenModelOverrides(groups(false), environmentId, overrides, false).providerGroups,
    ).toEqual([]);
    expect(
      canCommitPendingModel(
        model,
        withHiddenModelOverrides(groups(false), environmentId, overrides).providerGroups,
      ),
    ).toBe(false);

    const succeeded = settleHiddenModelOverride(overrides, key, override, true);
    const unrelatedUpdate = withHiddenModelOverrides(groups(false), environmentId, succeeded);
    expect(isHidden(unrelatedUpdate)).toBe(true);
    expect(unrelatedUpdate.overrides).toBe(succeeded);
    const confirmed = withHiddenModelOverrides(groups(true), environmentId, succeeded);
    expect(isHidden(confirmed)).toBe(true);
    expect(confirmed.overrides.size).toBe(0);
    const confirmedDuringWrite = withHiddenModelOverrides(groups(true), environmentId, overrides);
    expect(
      settleHiddenModelOverride(confirmedDuringWrite.overrides, key, override, true).size,
    ).toBe(0);
    expect(
      isHidden(withHiddenModelOverrides(groups(false), environmentId, confirmed.overrides)),
    ).toBe(false);

    const failed = settleHiddenModelOverride(overrides, key, override, false);
    expect(isHidden(withHiddenModelOverrides(groups(false), environmentId, failed))).toBe(false);
    const showOverride = { hidden: false };
    const superseding = new Map([[key, showOverride]]);
    expect(settleHiddenModelOverride(superseding, key, override, false)).toBe(superseding);

    const showing = withHiddenModelOverrides(groups(true), environmentId, superseding, false);
    expect(isHidden(showing)).toBe(false);
    expect(canCommitPendingModel(model, showing.providerGroups)).toBe(true);
    expect(canCommitPendingModel(model, showing.providerGroups, groups(true))).toBe(false);
    expect(canCommitPendingModel(model, showing.providerGroups, groups(false))).toBe(true);
    expect(showing.overrides).toBe(superseding);
    const shown = settleHiddenModelOverride(superseding, key, showOverride, true);
    expect(
      canCommitPendingModel(
        model,
        withHiddenModelOverrides(groups(true), environmentId, shown, false).providerGroups,
      ),
    ).toBe(true);
    expect(withHiddenModelOverrides(groups(false), environmentId, shown).overrides.size).toBe(0);
  });
});
