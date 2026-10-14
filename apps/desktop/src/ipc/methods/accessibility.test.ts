import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";

const native = vi.hoisted(() => ({
  enabled: false,
  windows: [] as { isDestroyed: () => boolean; webContents: { send: ReturnType<typeof vi.fn> } }[],
}));
vi.mock("electron", () => ({
  app: {
    get accessibilitySupportEnabled() {
      return native.enabled;
    },
  },
  BrowserWindow: { getAllWindows: () => native.windows },
}));
import { getAccessibilitySupport } from "./accessibility.ts";

describe("desktop accessibility detection", () => {
  beforeEach(() => {
    native.enabled = false;
  });
  it.effect("reads the current native accessibility state without changing it", () =>
    Effect.gen(function* () {
      expect(yield* getAccessibilitySupport.handler(undefined)).toBe(false);
      native.enabled = true;
      expect(yield* getAccessibilitySupport.handler(undefined)).toBe(true);
      expect(native.enabled).toBe(true);
    }),
  );
});
