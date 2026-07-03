import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import * as DesktopWindowState from "./DesktopWindowState.ts";

const DEFAULTS = { width: 1100, height: 780 } as const;
const DISPLAYS = [{ x: 0, y: 0, width: 1920, height: 1080 }] as const;

describe("resolveInitialWindowBounds", () => {
  it("falls back to defaults when there is no saved state", () => {
    assert.deepStrictEqual(
      DesktopWindowState.resolveInitialWindowBounds(Option.none(), DISPLAYS, DEFAULTS),
      { bounds: { width: 1100, height: 780 }, maximize: false },
    );
  });

  it("restores a saved position that is visible on a display", () => {
    assert.deepStrictEqual(
      DesktopWindowState.resolveInitialWindowBounds(
        Option.some({ x: 100, y: 120, width: 800, height: 600, maximized: true }),
        DISPLAYS,
        DEFAULTS,
      ),
      { bounds: { x: 100, y: 120, width: 800, height: 600 }, maximize: true },
    );
  });

  it("drops an off-screen position but keeps the size and maximized flag", () => {
    assert.deepStrictEqual(
      DesktopWindowState.resolveInitialWindowBounds(
        Option.some({ x: 5000, y: 5000, width: 800, height: 600, maximized: true }),
        DISPLAYS,
        DEFAULTS,
      ),
      { bounds: { width: 800, height: 600 }, maximize: true },
    );
  });

  it("uses size only when the saved state has no position", () => {
    assert.deepStrictEqual(
      DesktopWindowState.resolveInitialWindowBounds(
        Option.some({ width: 800, height: 600 }),
        DISPLAYS,
        DEFAULTS,
      ),
      { bounds: { width: 800, height: 600 }, maximize: false },
    );
  });
});
