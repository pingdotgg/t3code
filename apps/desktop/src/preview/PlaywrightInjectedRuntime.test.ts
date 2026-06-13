import { describe, expect, it } from "vite-plus/test";

import {
  playwrightInjectedRuntimeInstallExpression,
  playwrightInjectedRuntimeSource,
} from "./PlaywrightInjectedRuntime.ts";

describe("playwright injected runtime", () => {
  it("extracts the pinned runtime from playwright-core", async () => {
    const source = await playwrightInjectedRuntimeSource();
    expect(source.length).toBeGreaterThan(100_000);
    expect(source).toContain("InjectedScript");
  });

  it("builds an idempotent install expression", async () => {
    const expression = await playwrightInjectedRuntimeInstallExpression();
    expect(expression).toContain("__t3PlaywrightInjected");
    expect(expression).toContain('testIdAttributeName":"data-testid');
  });
});
