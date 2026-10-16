// @effect-diagnostics nodeBuiltinImport:off - tests use POSIX path joining to match the Linux startup boundary.
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";

import {
  resolveEarlyLinuxElectronOptions,
  resolveEarlyLinuxPasswordStorePreference,
  resolveLinuxDisableFeaturesSwitch,
} from "./DesktopEarlyElectronStartup.ts";

describe("DesktopEarlyElectronStartup", () => {
  const joinPath = NodePath.posix.join;

  it("reads the persisted linux password-store preference before Electron is ready", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: { T3CODE_HOME: "/home/user/.t3-test" },
      homeDirectory: "/home/user",
      joinPath,
      readFileString: (path) => {
        assert.equal(path, "/home/user/.t3-test/userdata/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "kwallet6" });
      },
    });

    assert.equal(preference, "kwallet6");
  });

  it("accepts JSONC in the early desktop settings file", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: { T3CODE_HOME: "/home/user/.t3-test" },
      homeDirectory: "/home/user",
      joinPath,
      readFileString: () => `{
        // manually edited setting
        "linuxPasswordStore": "gnome-libsecret",
      }`,
    });

    assert.equal(preference, "gnome-libsecret");
  });

  it("falls back to auto when the early settings document is missing or invalid", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: {},
      homeDirectory: "/home/user",
      joinPath,
      readFileString: () => {
        throw new Error("missing");
      },
    });

    assert.equal(preference, "auto");
  });

  it("preserves absolute root paths when resolving early settings", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: { T3CODE_HOME: "/" },
      homeDirectory: "/home/user",
      joinPath,
      readFileString: (path) => {
        assert.equal(path, "/userdata/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "kwallet6" });
      },
    });

    assert.equal(preference, "kwallet6");
  });

  it("resolves the early linux Electron switches", () => {
    const options = resolveEarlyLinuxElectronOptions({
      env: {
        T3CODE_HOME: "/home/user/.t3-test",
        XDG_CURRENT_DESKTOP: "niri",
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      },
      homeDirectory: "/home/user",
      joinPath,
      readFileString: (path) => {
        assert.equal(path, "/home/user/.t3-test/userdata/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "auto" });
      },
    });

    assert.deepEqual(options, {
      isDevelopment: true,
      linuxWmClass: "t3code-dev",
      linuxDesktopEntryName: "com.t3tools.T3Code.Development.desktop",
      passwordStore: "gnome-libsecret",
    });
  });

  it("keeps implicit development state under ~/.t3/dev when T3CODE_HOME is unset", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: {
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      },
      homeDirectory: "/home/user",
      joinPath,
      readFileString: (path) => {
        assert.equal(path, "/home/user/.t3/dev/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "kwallet" });
      },
    });

    assert.equal(preference, "kwallet");
  });

  it("treats whitespace-only T3CODE_HOME as unconfigured in development", () => {
    const preference = resolveEarlyLinuxPasswordStorePreference({
      env: {
        T3CODE_HOME: "   ",
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      },
      homeDirectory: "/home/user",
      joinPath,
      readFileString: (path) => {
        assert.equal(path, "/home/user/.t3/dev/desktop-settings.json");
        return JSON.stringify({ linuxPasswordStore: "gnome-libsecret" });
      },
    });

    assert.equal(preference, "gnome-libsecret");
  });

  describe("resolveLinuxDisableFeaturesSwitch", () => {
    const hyprland = { XDG_CURRENT_DESKTOP: "Hyprland", XDG_SESSION_TYPE: "wayland" };
    const releaseCommits: Record<string, string> = {
      "0.48.0": "5ee35f914f921e5696030698e74fb5566a804768",
      "0.48.1": "29e2e59fdbab8ed2cc23a20e3c6043d5decb5cdc",
      "0.49.0": "9958d297641b5c84dcff93f9039d80a5ad37ab00",
      "0.50.0": "c4a4c341568944bd4fb9cd503558b2de602c0213",
      "0.50.1": "4e242d086e20b32951fdc0ebcbfb4d41b5be8dcc",
    };
    const hyprctlVersion =
      (version: string, overrides: Record<string, unknown> = {}) =>
      () =>
        JSON.stringify({
          commit: releaseCommits[version] ?? "0123456789abcdef0123456789abcdef01234567",
          version,
          dirty: false,
          tag: `v${version}`,
          flags: [],
          ...overrides,
        });
    const brokenHyprland = {
      env: hyprland,
      ozonePlatform: "wayland",
      enableFeatures: null,
      disableFeatures: null,
      readHyprctlVersionJson: hyprctlVersion("0.48.1"),
    };

    it.each(["0.48.0", "0.48.1", "0.49.0", "0.50.0", "0.50.1"])(
      "disables the color manager on Hyprland %s",
      (version) => {
        assert.equal(
          resolveLinuxDisableFeaturesSwitch({
            ...brokenHyprland,
            readHyprctlVersionJson: hyprctlVersion(version),
          }),
          "WaylandWpColorManagerV1",
        );
      },
    );

    it.each([
      { label: "case-insensitive desktop tokens", env: { XDG_CURRENT_DESKTOP: "foo:HYPRLAND" } },
      {
        label: "XDG_SESSION_DESKTOP when XDG_CURRENT_DESKTOP is unset",
        env: { XDG_SESSION_DESKTOP: "hyprland" },
      },
    ])("detects Hyprland via $label", ({ env }) => {
      assert.equal(
        resolveLinuxDisableFeaturesSwitch({ ...brokenHyprland, env }),
        "WaylandWpColorManagerV1",
      );
    });

    it("keeps existing disabled features", () => {
      assert.equal(
        resolveLinuxDisableFeaturesSwitch({
          ...brokenHyprland,
          disableFeatures: "Vulkan,WaylandWpColorManagerV1Extra",
        }),
        "Vulkan,WaylandWpColorManagerV1Extra,WaylandWpColorManagerV1",
      );
    });

    it.each([
      { label: "Hyprland 0.47.2", readHyprctlVersionJson: hyprctlVersion("0.47.2") },
      { label: "Hyprland 0.51.0", readHyprctlVersionJson: hyprctlVersion("0.51.0") },
      { label: "Hyprland 0.56.2", readHyprctlVersionJson: hyprctlVersion("0.56.2") },
      { label: "an unrecognized version", readHyprctlVersionJson: hyprctlVersion("1.0.0") },
      {
        label: "a malformed version",
        readHyprctlVersionJson: hyprctlVersion("0.48.not-a-version"),
      },
      { label: "a two-part version", readHyprctlVersionJson: hyprctlVersion("0.48") },
      { label: "a prerelease version", readHyprctlVersionJson: hyprctlVersion("0.49.0-rc1") },
      {
        label: "a development build after an affected release",
        readHyprctlVersionJson: hyprctlVersion("0.50.1", { tag: "v0.50.1-87-g4e8875b5" }),
      },
      {
        label: "a later Nix build reporting an affected release tag",
        readHyprctlVersionJson: hyprctlVersion("0.50.1", {
          commit: "4e8875b5e9700c81ca4e169dc7b85bb5b3c8cb7a",
        }),
      },
      {
        label: "an affected version with another release's commit",
        readHyprctlVersionJson: hyprctlVersion("0.48.0", { commit: releaseCommits["0.48.1"] }),
      },
      { label: "an unknown patch release", readHyprctlVersionJson: hyprctlVersion("0.50.2") },
      {
        label: "missing commit metadata",
        readHyprctlVersionJson: () =>
          JSON.stringify({ version: "0.48.1", tag: "v0.48.1", dirty: false }),
      },
      {
        label: "a build without git metadata",
        readHyprctlVersionJson: hyprctlVersion("0.48.1", { tag: "" }),
      },
      {
        label: "a dirty build",
        readHyprctlVersionJson: hyprctlVersion("0.48.1", { dirty: true }),
      },
      {
        label: "output without build metadata",
        readHyprctlVersionJson: () => JSON.stringify({ version: "0.48.1" }),
      },
      { label: "unparseable hyprctl output", readHyprctlVersionJson: () => "ok" },
      {
        label: "a missing hyprctl",
        readHyprctlVersionJson: () => {
          throw new Error("spawnSync hyprctl ENOENT");
        },
      },
    ])("preserves color management for $label", (overrides) => {
      assert.isNull(resolveLinuxDisableFeaturesSwitch({ ...brokenHyprland, ...overrides }));
    });

    it.each([
      {
        label: "a stale Hyprland signature in KDE",
        env: { XDG_CURRENT_DESKTOP: "KDE", HYPRLAND_INSTANCE_SIGNATURE: "abc_123" },
      },
      {
        label: "resolved X11 in a Wayland session",
        ozonePlatform: "x11",
        env: { ...hyprland, WAYLAND_DISPLAY: "wayland-1" },
      },
      { label: "a missing platform", ozonePlatform: null },
      { label: "an unrelated platform", ozonePlatform: "headless" },
      { label: "already disabled features", disableFeatures: "Vulkan, WaylandWpColorManagerV1" },
      { label: "an explicitly enabled feature", enableFeatures: "Vulkan,WaylandWpColorManagerV1" },
      {
        label: "a feature enabled with trial parameters",
        enableFeatures: "*WaylandWpColorManagerV1<Study.Group:mode/strict",
      },
    ])("skips the Hyprland probe for $label", (overrides) => {
      assert.isNull(
        resolveLinuxDisableFeaturesSwitch({
          ...brokenHyprland,
          ...overrides,
          readHyprctlVersionJson: () => assert.fail("hyprctl should not run"),
        }),
      );
    });
  });
});
