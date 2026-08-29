import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  resolveModelPickerDisabledReason,
  shouldIncludeModelPickerOption,
} from "./ModelPickerContent";

function entry(status: ServerProvider["status"]) {
  return deriveProviderInstanceEntries([
    {
      instanceId: ProviderInstanceId.make("opencode_work"),
      driver: ProviderDriverKind.make("opencode"),
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
  it.each(["error", "warning"] as const)(
    "keeps only the active synthetic OpenCode row when the provider status is %s",
    (status) => {
      const providerEntry = entry(status);
      const activeInstanceId = ProviderInstanceId.make("opencode_work");
      const activeModel = "openrouter/kimi-k3";

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
    },
  );
});

describe("resolveModelPickerDisabledReason", () => {
  it("disables an unrunnable model without a caller-supplied reason", () => {
    // The settings pickers never pass getModelDisabledReason, so an
    // org-restricted model has to disable itself or it stays selectable there.
    expect(
      resolveModelPickerDisabledReason(
        { unavailableReason: "Restricted by your organization." },
        undefined,
      ),
    ).toBe("Restricted by your organization.");
  });

  it("keeps caller-supplied reasons for runnable models", () => {
    expect(resolveModelPickerDisabledReason({}, "Start a new thread to use this model.")).toBe(
      "Start a new thread to use this model.",
    );
    expect(resolveModelPickerDisabledReason(undefined, null)).toBeNull();
  });

  it("prefers the model's own reason over the caller's", () => {
    expect(
      resolveModelPickerDisabledReason(
        { unavailableReason: "Restricted by your organization." },
        "Start a new thread to use this model.",
      ),
    ).toBe("Restricted by your organization.");
  });
});
