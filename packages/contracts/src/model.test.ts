import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind } from "./providerInstance.ts";
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  DEFAULT_MODEL_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  PROVIDER_DISPLAY_NAMES,
} from "./model.ts";

const PI = ProviderDriverKind.make("pi");

describe("model maps — pi", () => {
  it("registers Pi with an explicit empty alias map (canonical provider/id passthrough)", () => {
    expect(MODEL_SLUG_ALIASES_BY_PROVIDER[PI]).toEqual({});
  });

  it("intentionally omits Pi from the static default-model maps", () => {
    expect(DEFAULT_MODEL_BY_PROVIDER[PI]).toBeUndefined();
    expect(DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[PI]).toBeUndefined();
  });

  it("keeps the Pi display name registered", () => {
    expect(PROVIDER_DISPLAY_NAMES[PI]).toBe("Pi");
  });
});
