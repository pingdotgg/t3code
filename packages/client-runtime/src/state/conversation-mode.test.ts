import { DEFAULT_KOMPAS_SETTINGS, type KompasSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isChatMode } from "./conversation-mode.ts";

const snapshot = (developerMode: boolean) =>
  ({ settings: { ...DEFAULT_KOMPAS_SETTINGS, developerMode } }) as KompasSnapshot;

describe("isChatMode", () => {
  it.each([
    ["a machine that has not answered yet", undefined, null, true],
    ["a server without Kompas", {}, null, false],
    ["Kompas before its settings load", { kompas: true }, null, true],
    ["Kompas", { kompas: true }, snapshot(false), true],
    ["Kompas with the coding tools on", { kompas: true }, snapshot(true), false],
  ])("%s", (_name, capabilities, loaded, expected) => {
    expect(isChatMode(capabilities, loaded)).toBe(expected);
  });
});
