import { describe, expect, it } from "vite-plus/test";

import {
  ELECTRON_CLASS_NAME,
  ELECTRON_WINDOWS_CLASS_NAME,
  getElectronPlatformClassNames,
} from "./windowControlsOverlay";

describe("getElectronPlatformClassNames", () => {
  it("marks Windows Electron renderers for native resize gutter compensation", () => {
    expect(getElectronPlatformClassNames("Win32")).toEqual([
      ELECTRON_CLASS_NAME,
      ELECTRON_WINDOWS_CLASS_NAME,
    ]);
    expect(getElectronPlatformClassNames("windows_nt")).toEqual([
      ELECTRON_CLASS_NAME,
      ELECTRON_WINDOWS_CLASS_NAME,
    ]);
  });

  it("does not apply Windows scrollbar compensation on other desktop platforms", () => {
    expect(getElectronPlatformClassNames("MacIntel")).toEqual([ELECTRON_CLASS_NAME]);
    expect(getElectronPlatformClassNames("Linux x86_64")).toEqual([ELECTRON_CLASS_NAME]);
  });
});
