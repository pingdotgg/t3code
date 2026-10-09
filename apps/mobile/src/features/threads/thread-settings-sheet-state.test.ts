import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ProviderOptionSelection } from "@t3tools/contracts";

import type { ModelOption } from "../../lib/modelOptions";
import {
  resolvePendingModelForCommit,
  favoritesFirst,
  getModelDaybreakToggleState,
  modelFavoriteKey,
  modelMatchesCatalogQuery,
  pendingModelAfterPress,
  toggleModelFavorite,
} from "./thread-settings-sheet-state";

function modelOption(
  model: string,
  options: ReadonlyArray<ProviderOptionSelection> = [],
  programs?: ReadonlyArray<string>,
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
    capabilities: programs
      ? {
          optionDescriptors: [
            {
              id: "cyberAccessProgram",
              label: "Daybreak",
              type: "select",
              options: ["standard", ...programs].map((id) => ({ id, label: id })),
              currentValue: "standard",
            },
          ],
        }
      : null,
    selection: {
      instanceId: ProviderInstanceId.make("codex"),
      model,
      options,
    },
  };
}

describe("thread settings sheet state", () => {
  it("keeps favorites in catalog order ahead of other models", () => {
    const models = [
      modelOption("first"),
      modelOption("second"),
      modelOption("third"),
      modelOption("fourth"),
    ];
    const favorites = new Set([models[2]!.key, models[0]!.key]);

    expect(favoritesFirst(models, favorites).map((model) => model.selection.model)).toEqual([
      "first",
      "third",
      "second",
      "fourth",
    ]);
    expect(models.map((model) => model.selection.model)).toEqual([
      "first",
      "second",
      "third",
      "fourth",
    ]);
  });

  it("adds and removes favorites for one provider instance", () => {
    const codexModel = modelOption("shared");
    const otherProvider = ProviderInstanceId.make("codex_personal");
    const personalModel = {
      ...codexModel,
      key: modelFavoriteKey(otherProvider, "shared"),
      selection: { ...codexModel.selection, instanceId: otherProvider },
    };
    const favorites = toggleModelFavorite([], codexModel);

    expect(toggleModelFavorite(favorites, personalModel)).toEqual([
      { provider: ProviderInstanceId.make("codex"), model: "shared" },
      { provider: otherProvider, model: "shared" },
    ]);
    expect(toggleModelFavorite(favorites, codexModel)).toEqual([]);
  });

  it("matches visible model and provider terms", () => {
    const model = modelOption("gpt-next");

    expect(modelMatchesCatalogQuery({ model, providerLabel: "Codex", query: "NEXT" })).toBe(true);
    expect(modelMatchesCatalogQuery({ model, providerLabel: "Codex", query: "codex" })).toBe(true);
    expect(modelMatchesCatalogQuery({ model, providerLabel: "Codex", query: "claude" })).toBe(
      false,
    );
  });

  it("treats whitespace-only catalog searches as empty", () => {
    expect(
      modelMatchesCatalogQuery({
        model: modelOption("gpt-next"),
        providerLabel: "Codex",
        query: "   ",
      }),
    ).toBe(true);
  });

  it("matches the upstream provider's display name", () => {
    const model = {
      ...modelOption("opencode/claude-fable-5"),
      label: "Claude Fable 5",
      subtitle: "OpenCode Zen",
    };

    expect(modelMatchesCatalogQuery({ model, providerLabel: "OpenCode", query: " ZEN " })).toBe(
      true,
    );
    expect(modelMatchesCatalogQuery({ model, providerLabel: "OpenCode", query: "copilot" })).toBe(
      false,
    );
  });

  it("clears staging when the applied model is pressed", () => {
    expect(
      pendingModelAfterPress({
        current: modelOption("gpt-next"),
        pressed: modelOption("gpt-current"),
        pressedIsApplied: true,
      }),
    ).toBeNull();
  });

  it("refreshes model capabilities while preserving staged options on another press", () => {
    const pending = modelOption("gpt-next", [{ id: "effort", value: "high" }]);
    const refreshed = modelOption("gpt-next", [], ["daybreakBlue"]);

    expect(
      pendingModelAfterPress({
        current: pending,
        pressed: refreshed,
        pressedIsApplied: false,
      }),
    ).toEqual({ ...refreshed, selection: pending.selection });
  });

  it("stages a different model", () => {
    const pressed = modelOption("gpt-other");

    expect(
      pendingModelAfterPress({
        current: modelOption("gpt-next"),
        pressed,
        pressedIsApplied: false,
      }),
    ).toEqual(pressed);
  });

  it("applies Daybreak when a model is chosen while preserving other options", () => {
    const reasoning = [{ id: "reasoningEffort", value: "high" }];
    const programs = ["daybreakBlue", "daybreakRed"];
    const redOptions = [...reasoning, { id: "cyberAccessProgram", value: "daybreakRed" }];
    const model = modelOption("gpt-test", reasoning, programs);
    for (const program of ["daybreakBlue", "daybreakRed", "standard"]) {
      const pending = pendingModelAfterPress({
        current: null,
        pressed: model,
        pressedIsApplied: true,
        daybreakProgram: program,
      });
      expect(pending?.selection.options).toEqual([
        { id: "reasoningEffort", value: "high" },
        { id: "cyberAccessProgram", value: program },
      ]);
      expect(
        pendingModelAfterPress({ current: pending, pressed: model, pressedIsApplied: false })
          ?.selection.options,
      ).toEqual(pending?.selection.options);
    }
    expect(model.selection.options).toEqual([{ id: "reasoningEffort", value: "high" }]);
    expect(getModelDaybreakToggleState({ ...model, providerDriver: "claudeAgent" })).toBeNull();
    expect(getModelDaybreakToggleState({ ...model, isUnavailable: true })).toBeNull();
    const blueOnly = modelOption("gpt-test", reasoning, ["daybreakBlue"]);
    const staged = modelOption("gpt-test", redOptions, programs);
    expect(
      pendingModelAfterPress({
        current: staged,
        pressed: modelOption("gpt-other"),
        pressedIsApplied: false,
        daybreakProgram: "daybreakRed",
      }),
    ).toBe(staged);
    for (const pressed of [blueOnly, { ...model, capabilities: null }]) {
      for (const daybreakProgram of [undefined, "daybreakRed"]) {
        const cleaned = pendingModelAfterPress({
          current: staged,
          pressed,
          pressedIsApplied: false,
          daybreakProgram,
        });
        expect(cleaned).toEqual({ ...pressed, selection: model.selection });
      }
      expect(
        pendingModelAfterPress({
          current: null,
          pressed: { ...pressed, selection: staged.selection },
          pressedIsApplied: false,
        }),
      ).toEqual({ ...pressed, selection: model.selection });
    }
  });

  it("cannot save a staged model after sign-out removes it from the catalog", () => {
    const pending = modelOption("gemini-native");
    const group = { providerKey: "codex", providerLabel: "Codex", models: [pending] };

    expect(resolvePendingModelForCommit(pending, [group])).toEqual(pending);
    expect(resolvePendingModelForCommit(pending, [])).toBeNull();
    expect(
      resolvePendingModelForCommit(pending, [
        {
          ...group,
          models: [{ ...pending, isUnavailable: true }],
        },
      ]),
    ).toBeNull();
  });

  it("revalidates staged Daybreak access at Save without discarding other options", () => {
    for (const reasoning of [[], [{ id: "reasoningEffort", value: "high" }]]) {
      const options = [...reasoning, { id: "cyberAccessProgram", value: "daybreakBlue" }];
      const pending = modelOption("gpt-test", options, ["daybreakBlue"]);
      for (const programs of [["daybreakBlue"], ["daybreakRed"], [], undefined]) {
        const refreshed = modelOption("gpt-test", [], programs);
        expect(
          resolvePendingModelForCommit(pending, [
            { providerKey: "codex", providerLabel: "Codex", models: [refreshed] },
          ]),
        ).toEqual({
          ...refreshed,
          selection: {
            ...pending.selection,
            options: programs?.includes("daybreakBlue") ? options : reasoning,
          },
        });
      }
      expect(pending.selection.options).toEqual(options);
    }
  });
});
