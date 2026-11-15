import { describe, expect, it } from "vite-plus/test";

import { windowOpacityHint } from "./WindowOpacitySetting.logic";

describe("windowOpacityHint", () => {
  it("asks Linux users to restart only when an opaque window must fade", () => {
    const appName = "Continuum IDE";
    expect(windowOpacityHint({ mode: "restart-required", opacity: 70, appName })).toContain(
      "restart Continuum IDE once",
    );
    expect(windowOpacityHint({ mode: "restart-required", opacity: 100, appName })).not.toContain(
      "restart",
    );
    expect(windowOpacityHint({ mode: "native", opacity: 70, appName })).not.toContain("restart");
    expect(windowOpacityHint({ mode: "compositor", opacity: 70, appName })).toContain(
      "stay opaque",
    );
  });
});
