import type * as Electron from "electron";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const switches = vi.hoisted(() => new Set<string>());
vi.mock("electron", () => ({
  app: {
    commandLine: {
      hasSwitch: (name: string) => switches.has(name),
      appendSwitch: (name: string) => switches.add(name),
      removeSwitch: (name: string) => switches.delete(name),
    },
  },
}));

import { showWindowsCaptureOverlay } from "./WindowsCaptureFeedback.ts";

const animationSwitch = "wm-window-animations-disabled";

function overlay(showInactive: () => void) {
  return { showInactive } as Electron.BaseWindow;
}

beforeEach(() => {
  switches.clear();
  switches.add("unrelated-switch");
});

it("disables Chromium window animation only while showing the capture overlay", () => {
  const flagsDuringShow: string[][] = [];

  showWindowsCaptureOverlay(overlay(() => flagsDuringShow.push([...switches])));

  expect(flagsDuringShow).toEqual([["unrelated-switch", animationSwitch]]);
  expect([...switches]).toEqual(["unrelated-switch"]);
});

it("preserves an animation switch supplied before capture", () => {
  switches.add(animationSwitch);
  const flagsDuringShow: string[][] = [];

  showWindowsCaptureOverlay(overlay(() => flagsDuringShow.push([...switches])));

  expect(flagsDuringShow).toEqual([["unrelated-switch", animationSwitch]]);
  expect([...switches]).toEqual(["unrelated-switch", animationSwitch]);
});

it.each([false, true])(
  "restores the original switch state when showing throws (preexisting: %s)",
  (preexisting) => {
    if (preexisting) switches.add(animationSwitch);
    const original = [...switches];
    const failure = new Error("Overlay was destroyed");
    const window = overlay(() => {
      expect(switches.has(animationSwitch)).toBe(true);
      throw failure;
    });

    expect(() => showWindowsCaptureOverlay(window)).toThrow(failure);
    expect([...switches]).toEqual(original);
  },
);
