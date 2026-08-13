// @effect-diagnostics nodeBuiltinImport:off - Fixture reads of Chrome Secure Preferences stay synchronous.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

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
      assert.equal(state.platform, "darwin");
      assert.deepEqual(
        state.permissions.map((permission) => permission.kind),
        ["accessibility", "screenRecording"],
      );
      assert.equal(state.permissions[0]?.status, "denied");
      assert.equal(state.permissions[1]?.status, "denied");
    } finally {
      Object.defineProperty(process, "platform", { value: previous });
    }
  });

  it("marks privacy permissions not required off macOS", () => {
    const previous = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const state = readComputerUsePermissions();
      assert.equal(state.platform, "linux");
      assert.isTrue(state.permissions.every((permission) => permission.status === "notRequired"));
    } finally {
      Object.defineProperty(process, "platform", { value: previous });
    }
  });

  it("opens the Accessibility privacy pane and prompts trust", async () => {
    const previous = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const opened = await openComputerUsePrivacySettings("accessibility");
      assert.isTrue(opened);
      assert.equal(
        vi.mocked(Electron.systemPreferences.isTrustedAccessibilityClient).mock.calls.at(-1)?.[0],
        true,
      );
      assert.equal(
        vi.mocked(Electron.shell.openExternal).mock.calls.at(-1)?.[0],
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
        assert.deepEqual(state.chromeExtension, {
          status: "installed",
          detail: "Browser extension installed",
        });
      } else {
        assert.isTrue(["missing", "unknown"].includes(state.chromeExtension.status));
      }
    } finally {
      Object.defineProperty(process, "platform", { value: previous });
    }
  });
});
