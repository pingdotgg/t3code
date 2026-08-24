import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ProviderOptionSelection } from "@t3tools/contracts";

import type { ModelOption } from "../../lib/modelOptions";
import {
  catalogVendorRuns,
  modelMatchesCatalogQuery,
  pendingModelAfterPress,
} from "./thread-settings-sheet-state";

function modelOption(
  model: string,
  options: ReadonlyArray<ProviderOptionSelection> = [],
  subProvider?: string,
): ModelOption {
  return {
    key: `codex:${model}`,
    label: model,
    subtitle: "Codex",
    providerKey: "codex",
    providerLabel: "Codex",
    providerDriver: "codex",
    ...(subProvider ? { subProvider } : {}),
    isDefault: false,
    isLegacy: false,
    capabilities: null,
    selection: {
      instanceId: ProviderInstanceId.make("codex"),
      model,
      options,
    },
  };
}

describe("thread settings sheet state", () => {
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

  it("clears staging when the applied model is pressed", () => {
    expect(
      pendingModelAfterPress({
        current: modelOption("gpt-next"),
        pressed: modelOption("gpt-current"),
        pressedIsApplied: true,
      }),
    ).toBeNull();
  });

  it("preserves staged options when the highlighted model is pressed again", () => {
    const pending = modelOption("gpt-next", [{ id: "effort", value: "high" }]);

    expect(
      pendingModelAfterPress({
        current: pending,
        pressed: modelOption("gpt-next"),
        pressedIsApplied: false,
      }),
    ).toBe(pending);
  });

  it("stages a different model", () => {
    const pressed = modelOption("gpt-other");

    expect(
      pendingModelAfterPress({
        current: modelOption("gpt-next"),
        pressed,
        pressedIsApplied: false,
      }),
    ).toBe(pressed);
  });

  it("matches the vendor of an aggregated model", () => {
    const model = modelOption("claude-haiku", [], "Anthropic");

    expect(modelMatchesCatalogQuery({ model, providerLabel: "OpenCode", query: "anthropic" })).toBe(
      true,
    );
  });

  it("chunks a multi-vendor catalog into runs, keeping vendorless models flat", () => {
    const models = [
      modelOption("claude-haiku", [], "Anthropic"),
      modelOption("claude-sonnet", [], "Anthropic"),
      modelOption("gpt-5.4", [], "OpenAI"),
      modelOption("my-custom-model"),
    ];

    const runs = catalogVendorRuns(models);

    expect(runs).toEqual([
      { subProvider: "Anthropic", models: [models[0], models[1]] },
      { subProvider: "OpenAI", models: [models[2]] },
      { subProvider: undefined, models: [models[3]] },
    ]);
  });

  it("skips vendor runs for single-vendor catalogs", () => {
    expect(catalogVendorRuns([modelOption("gpt-5.4"), modelOption("gpt-5.5")])).toBeNull();
    expect(
      catalogVendorRuns([
        modelOption("gpt-5.4", [], "OpenAI"),
        modelOption("gpt-5.5", [], "OpenAI"),
      ]),
    ).toBeNull();
  });
});
