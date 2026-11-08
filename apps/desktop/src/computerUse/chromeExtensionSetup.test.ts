// @effect-diagnostics nodeBuiltinImport:off - temp-dir fixtures for the extension copy.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({
  systemPreferences: { isTrustedAccessibilityClient: vi.fn(() => true) },
  Notification: Object.assign(vi.fn(), { isSupported: vi.fn(() => false) }),
}));
// Never touch the machine's Chrome or run the real binary from a unit test.
vi.mock("./nativeHost.ts", () => ({ ensureChromeNativeHostRegistered: vi.fn(async () => false) }));

import { decideAutoInstall, findChromeExecutable } from "./chromeExtensionSetup.ts";
import { syncChromeExtensionCopySync } from "../computerHistory/resolveBinary.ts";

describe("decideAutoInstall", () => {
  const env = {};

  it("runs on a fresh install with the extension missing", () => {
    assert.deepStrictEqual(decideAutoInstall({}, false, env, false), { run: true });
  });

  it("does nothing when the extension is already there", () => {
    assert.deepStrictEqual(decideAutoInstall({}, true, env, false), {
      run: false,
      reason: "installed",
    });
  });

  it("leaves an extension the user removed removed", () => {
    assert.deepStrictEqual(decideAutoInstall({ seenInstalled: true }, false, env, false), {
      run: false,
      reason: "removed-by-user",
    });
  });

  it("stops after three launch-time attempts", () => {
    assert.deepStrictEqual(decideAutoInstall({ automaticAttempts: 2 }, false, env, false), {
      run: true,
    });
    assert.deepStrictEqual(decideAutoInstall({ automaticAttempts: 3 }, false, env, false), {
      run: false,
      reason: "gave-up",
    });
  });

  it("is off in development unless asked for, and off everywhere with =0", () => {
    assert.deepStrictEqual(decideAutoInstall({}, false, env, true), {
      run: false,
      reason: "disabled",
    });
    assert.deepStrictEqual(
      decideAutoInstall({}, false, { MTCODE_CHROME_EXTENSION_AUTOINSTALL: "1" }, true),
      { run: true },
    );
    assert.deepStrictEqual(
      decideAutoInstall({}, false, { MTCODE_CHROME_EXTENSION_AUTOINSTALL: "0" }, false),
      { run: false, reason: "disabled" },
    );
  });
});

describe("findChromeExecutable", () => {
  it("finds Chrome under Program Files on Windows", () => {
    const expected = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    assert.strictEqual(
      findChromeExecutable("win32", { PROGRAMFILES: "C:\\Program Files" }, (p) => p === expected),
      expected,
    );
  });

  it("finds google-chrome on PATH on Linux", () => {
    assert.strictEqual(
      findChromeExecutable(
        "linux",
        { PATH: "/usr/local/bin:/usr/bin" },
        (p) => p === "/usr/bin/google-chrome",
      ),
      "/usr/bin/google-chrome",
    );
  });

  it("returns nothing when Chrome is not installed", () => {
    assert.strictEqual(
      findChromeExecutable("darwin", {}, () => false),
      undefined,
    );
  });
});

describe("syncChromeExtensionCopySync", () => {
  it("keeps a stable copy of the bundled extension in step with the bundle", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mt-ext-copy-"));
    const resources = NodePath.join(root, "resources");
    const bundled = NodePath.join(resources, "munim-computer-use", "chrome-extension");
    const stateDir = NodePath.join(root, "state");
    NodeFS.mkdirSync(NodePath.join(bundled, "icons"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(bundled, "manifest.json"), '{"version":"1"}');
    NodeFS.writeFileSync(NodePath.join(bundled, "icons", "a.png"), "a");
    const previous = process.resourcesPath;
    Object.defineProperty(process, "resourcesPath", { value: resources, configurable: true });
    try {
      const copy = syncChromeExtensionCopySync(stateDir);
      assert.strictEqual(copy, NodePath.join(stateDir, "chrome-extension"));
      assert.strictEqual(
        NodeFS.readFileSync(NodePath.join(copy!, "manifest.json"), "utf8"),
        '{"version":"1"}',
      );

      // An update changes one file and drops another.
      NodeFS.writeFileSync(NodePath.join(bundled, "manifest.json"), '{"version":"2"}');
      NodeFS.rmSync(NodePath.join(bundled, "icons", "a.png"));
      syncChromeExtensionCopySync(stateDir);
      assert.strictEqual(
        NodeFS.readFileSync(NodePath.join(copy!, "manifest.json"), "utf8"),
        '{"version":"2"}',
      );
      assert.ok(!NodeFS.existsSync(NodePath.join(copy!, "icons", "a.png")));
    } finally {
      Object.defineProperty(process, "resourcesPath", { value: previous, configurable: true });
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
