import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  systemPreferences: {
    isTrustedAccessibilityClient: vi.fn(() => false),
    getMediaAccessStatus: vi.fn(() => "denied"),
  },
  shell: {
    openExternal: vi.fn(async () => undefined),
  },
}));

import * as Electron from "electron";

import { openComputerUsePrivacySettings, readComputerUsePermissions } from "./permissions.ts";

describe("computerUse permissions", () => {
  it("reports accessibility and screen recording on darwin", () => {
    const previous = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const state = readComputerUsePermissions();
      expect(state.platform).toBe("darwin");
      expect(state.permissions.map((permission) => permission.kind)).toEqual([
        "accessibility",
        "screenRecording",
      ]);
      expect(state.permissions[0]?.status).toBe("denied");
      expect(state.permissions[1]?.status).toBe("denied");
    } finally {
      Object.defineProperty(process, "platform", { value: previous });
    }
  });

  it("marks privacy permissions not required off macOS", () => {
    const previous = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const state = readComputerUsePermissions();
      expect(state.platform).toBe("linux");
      expect(state.permissions.every((permission) => permission.status === "notRequired")).toBe(
        true,
      );
    } finally {
      Object.defineProperty(process, "platform", { value: previous });
    }
  });

  it("opens the Accessibility privacy pane and prompts trust", async () => {
    const previous = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const opened = await openComputerUsePrivacySettings("accessibility");
      expect(opened).toBe(true);
      expect(Electron.systemPreferences.isTrustedAccessibilityClient).toHaveBeenCalledWith(true);
      expect(Electron.shell.openExternal).toHaveBeenCalledWith(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      );
    } finally {
      Object.defineProperty(process, "platform", { value: previous });
    }
  });

  it("detects an unpacked extension from Secure Preferences without state", () => {
    const previous = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    const home = NodeOS.homedir();
    const securePath = NodePath.join(
      home,
      "Library/Application Support/Google/Chrome/Default/Secure Preferences",
    );
    try {
      if (!NodeFS.existsSync(securePath)) return;
      const raw = NodeFS.readFileSync(securePath, "utf8");
      const parsed = JSON.parse(raw) as {
        extensions?: { settings?: Record<string, unknown> };
      };
      const hasExtension = Boolean(parsed.extensions?.settings?.kgdolgnijopbghhomnblabjkmjhnoage);
      const state = readComputerUsePermissions();
      if (hasExtension) {
        expect(state.chromeExtension).toEqual({
          status: "installed",
          detail: "Browser extension installed",
        });
      } else {
        expect(["missing", "unknown"]).toContain(state.chromeExtension.status);
      }
    } finally {
      Object.defineProperty(process, "platform", { value: previous });
    }
  });
});
