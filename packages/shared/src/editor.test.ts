import { describe, expect, it } from "vite-plus/test";

import { isPrereleaseZedPath } from "./editor.ts";

describe("isPrereleaseZedPath", () => {
  it("recognizes prerelease Zed installs by their own folder name only", () => {
    for (const prerelease of [
      "C:\\Users\\me\\AppData\\Local\\Programs\\Zed Preview\\bin\\zed.exe",
      "C:\\Users\\me\\AppData\\Local\\Programs\\Zed Nightly\\bin\\zed.exe",
      "/Applications/Zed Nightly.app/Contents/MacOS/cli",
      "/home/me/.local/zed-preview.app/bin/zed",
    ]) {
      expect(isPrereleaseZedPath(prerelease), prerelease).toBe(true);
    }
    for (const stable of [
      "C:\\Users\\preview-user\\AppData\\Local\\Programs\\Zed\\bin\\zed.exe",
      "C:\\nightly-builds\\Zed\\bin\\zed.exe",
      "/Applications/Zed.app/Contents/MacOS/cli",
      "/home/me/.local/zed.app/bin/zed",
    ]) {
      expect(isPrereleaseZedPath(stable), stable).toBe(false);
    }
  });
});
