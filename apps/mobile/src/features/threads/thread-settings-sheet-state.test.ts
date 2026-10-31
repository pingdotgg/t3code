import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import {
  DEFAULT_SERVER_SETTINGS,
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
  it("shows a visibility toggle at once and reconciles it with server snapshots", () => {
    const environmentId = EnvironmentId.make("env-a");
    const model = { ...modelOption("gpt-next"), canHide: true, isHidden: false };
    const groups = (isHidden: boolean) => [
      { providerKey: "codex", providerLabel: "Codex", models: [{ ...model, isHidden }] },
    ];
    const isHidden = (shown: ReturnType<typeof withHiddenModelOverrides>): boolean | undefined =>
      shown[0]?.models[0]?.isHidden;
    const key = hiddenModelOverrideKey(environmentId, model.selection);
    const before = { ...DEFAULT_SERVER_SETTINGS };
    const override = { hidden: true, baseline: before, pending: true };
    const overrides = new Map([[key, override]]);

    expect(
      isHidden(withHiddenModelOverrides(groups(false), environmentId, before, overrides)),
    ).toBe(true);
    expect(
      isHidden(
        withHiddenModelOverrides(groups(false), EnvironmentId.make("env-b"), before, overrides),
      ),
    ).toBe(false);
    const unrelated = { ...DEFAULT_SERVER_SETTINGS };
    expect(
      isHidden(withHiddenModelOverrides(groups(false), environmentId, unrelated, overrides)),
    ).toBe(true);

    const succeeded = settleHiddenModelOverride(overrides, key, override, true, before);
    expect(
      isHidden(withHiddenModelOverrides(groups(false), environmentId, before, succeeded)),
    ).toBe(true);
    const after = { ...DEFAULT_SERVER_SETTINGS };
    expect(isHidden(withHiddenModelOverrides(groups(true), environmentId, after, succeeded))).toBe(
      true,
    );
    expect(isHidden(withHiddenModelOverrides(groups(false), environmentId, after, succeeded))).toBe(
      false,
    );
    expect(settleHiddenModelOverride(overrides, key, override, true, after).has(key)).toBe(false);

    const failed = settleHiddenModelOverride(overrides, key, override, false, before);
    expect(isHidden(withHiddenModelOverrides(groups(false), environmentId, before, failed))).toBe(
      false,
    );
    const superseding = new Map([[key, { ...override, hidden: false }]]);
    expect(settleHiddenModelOverride(superseding, key, override, false, before)).toBe(superseding);
  });
});
