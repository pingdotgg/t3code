import { describe, expect, it } from "vite-plus/test";

import { MOBILE_APP_NAME, MOBILE_APP_NAME_SUFFIX, resolveMobileStageLabel } from "./mobileBranding";

describe("mobile branding", () => {
  it("names the fork's app T3 Agents", () => {
    expect(MOBILE_APP_NAME).toBe("T3 Agents");
    expect(MOBILE_APP_NAME_SUFFIX).toBe("Agents");
  });

  it("shows no stage badge on release builds", () => {
    expect(resolveMobileStageLabel("production")).toBeNull();
    expect(resolveMobileStageLabel(undefined)).toBeNull();
    expect(resolveMobileStageLabel("development")).toBe("Dev");
    expect(resolveMobileStageLabel("preview")).toBe("Nightly");
  });
});
