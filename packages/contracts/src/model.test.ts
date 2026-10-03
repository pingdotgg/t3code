import { describe, expect, it } from "@effect/vitest";

import { ProviderInstanceId } from "./providerInstance.ts";
import {
  COPILOT_DRIVER_KIND,
  DEFAULT_AUTOMATED_MODEL_SELECTION,
  DEFAULT_MODEL_BY_PROVIDER,
} from "./model.ts";

describe("automated model defaults", () => {
  it("defaults the Copilot provider to gpt-6-luna", () => {
    expect(DEFAULT_MODEL_BY_PROVIDER[COPILOT_DRIVER_KIND]).toBe("gpt-6-luna");
  });

  it("pins automated runs to gpt-6-luna on low reasoning", () => {
    expect(DEFAULT_AUTOMATED_MODEL_SELECTION).toEqual({
      instanceId: ProviderInstanceId.make("copilot"),
      model: "gpt-6-luna",
      options: [{ id: "reasoning", value: "low" }],
    });
  });
});
