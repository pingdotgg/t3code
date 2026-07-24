// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "node:path";

import {
  applyT3StorageDirectoryOverrides,
  resolveDefaultT3StorageRoots,
  resolveLegacyT3StorageRoots,
  resolveT3StorageDirectoryOverrides,
  selectT3StorageRoots,
  t3StorageEnvironment,
} from "./storagePaths.ts";

const path = {
  join: NodePath.posix.join,
  resolve: NodePath.posix.resolve,
  isAbsolute: NodePath.posix.isAbsolute,
};

const linuxDefaults = (environment: Readonly<Record<string, string | undefined>> = {}) =>
  resolveDefaultT3StorageRoots({
    platform: "linux",
    homeDirectory: "/home/alice",
    temporaryDirectory: "/tmp",
    userId: 1000,
    isDevelopment: false,
    environment,
    path,
  });

describe("T3 storage paths", () => {
  it("resolves all five Linux XDG roots independently", () => {
    expect(
      linuxDefaults({
        XDG_CONFIG_HOME: "/xdg/config",
        XDG_DATA_HOME: "/xdg/data",
        XDG_STATE_HOME: "/xdg/state",
        XDG_CACHE_HOME: "/xdg/cache",
        XDG_RUNTIME_DIR: "/run/user/1000",
      }),
    ).toEqual({
      layout: "split",
      configDir: "/xdg/config/t3code",
      dataDir: "/xdg/data/t3code",
      stateDir: "/xdg/state/t3code",
      cacheDir: "/xdg/cache/t3code",
      runtimeDir: "/run/user/1000/t3code",
    });
  });

  it("uses the XDG defaults and a per-user temporary runtime fallback", () => {
    expect(linuxDefaults()).toEqual({
      layout: "split",
      configDir: "/home/alice/.config/t3code",
      dataDir: "/home/alice/.local/share/t3code",
      stateDir: "/home/alice/.local/state/t3code",
      cacheDir: "/home/alice/.cache/t3code",
      runtimeDir: "/tmp/t3code-1000",
    });
  });

  it("ignores relative XDG base directories", () => {
    expect(
      linuxDefaults({
        XDG_CONFIG_HOME: "relative/config",
        XDG_RUNTIME_DIR: "relative/runtime",
      }),
    ).toMatchObject({
      configDir: "/home/alice/.config/t3code",
      runtimeDir: "/tmp/t3code-1000",
    });
  });

  it("applies granular T3 overrides without collapsing the other roots", () => {
    const overrides = resolveT3StorageDirectoryOverrides({
      environment: {
        T3CODE_CONFIG_DIR: "~/dotfiles/t3code",
        T3CODE_STATE_DIR: "/machine/t3code",
      },
      homeDirectory: "/home/alice",
      path,
    });

    expect(applyT3StorageDirectoryOverrides(linuxDefaults(), overrides)).toEqual({
      layout: "split",
      configDir: "/home/alice/dotfiles/t3code",
      dataDir: "/home/alice/.local/share/t3code",
      stateDir: "/machine/t3code",
      cacheDir: "/home/alice/.cache/t3code",
      runtimeDir: "/tmp/t3code-1000",
    });
  });

  it("models the legacy tree without pretending it has five independent roots", () => {
    const roots = resolveLegacyT3StorageRoots({
      baseDir: "/home/alice/.t3",
      stateDirectoryName: "userdata",
      path,
    });
    expect(roots).toEqual({
      layout: "legacy",
      configDir: "/home/alice/.t3/userdata",
      dataDir: "/home/alice/.t3",
      stateDir: "/home/alice/.t3/userdata",
      cacheDir: "/home/alice/.t3/caches",
      runtimeDir: "/home/alice/.t3/userdata",
      legacyBaseDir: "/home/alice/.t3",
    });
    expect(t3StorageEnvironment(roots)).toEqual({ T3CODE_HOME: "/home/alice/.t3" });
  });

  it("keeps initialized legacy storage unless a layout is explicitly selected", () => {
    const split = linuxDefaults();
    const legacy = resolveLegacyT3StorageRoots({
      baseDir: "/home/alice/.t3",
      stateDirectoryName: "userdata",
      path,
    });
    expect(
      selectT3StorageRoots({
        defaultSplitRoots: split,
        legacyRoots: legacy,
        legacyStorageInitialized: true,
      }),
    ).toBe(legacy);
    expect(
      selectT3StorageRoots({
        explicitSplitRoots: split,
        defaultSplitRoots: split,
        legacyRoots: legacy,
        legacyStorageInitialized: true,
      }),
    ).toBe(split);
  });
});
