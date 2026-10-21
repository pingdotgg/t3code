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
