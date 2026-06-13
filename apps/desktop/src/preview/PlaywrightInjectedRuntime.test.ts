import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import {
  playwrightInjectedRuntimeInstallExpression,
  playwrightInjectedRuntimeSource,
} from "./PlaywrightInjectedRuntime.ts";

describe("playwright injected runtime", () => {
  effectIt.effect("extracts the pinned runtime from playwright-core", () =>
    Effect.gen(function* () {
      const source = yield* playwrightInjectedRuntimeSource();
      expect(source.length).toBeGreaterThan(100_000);
      expect(source).toContain("InjectedScript");
    }),
  );

  effectIt.effect("builds an idempotent install expression", () =>
    Effect.gen(function* () {
      const expression = yield* playwrightInjectedRuntimeInstallExpression();
      expect(expression).toContain("__t3PlaywrightInjected");
      expect(expression).toContain('testIdAttributeName":"data-testid');
    }),
  );
});
