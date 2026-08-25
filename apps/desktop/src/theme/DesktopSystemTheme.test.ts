// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  app: { focus: () => {} },
}));

import {
  desktopSystemThemePaths,
  normalizeSystemThemePalette,
  parseFlatColorsToml,
  readDesktopSystemTheme,
} from "./DesktopSystemTheme.ts";

const temporaryDirectories: string[] = [];

function makeThemeHome(colors: string): string {
  const homeDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-system-theme-"));
  temporaryDirectories.push(homeDirectory);
  const paths = desktopSystemThemePaths(homeDirectory);
  NodeFS.mkdirSync(NodePath.dirname(paths.colorsFile), { recursive: true });
  NodeFS.writeFileSync(paths.colorsFile, colors);
  return homeDirectory;
}

const DARK_COLORS = `
mode = "dark"
background = "#070707"
foreground = "#F9DEBE"
accent = "#b36673"
selection = "#F9DEBE"
red = "#c5836b"
green = "#f1b672"
yellow = "#ffde94"
blue = "#b36673"
magenta = "#ee8d86"
cyan = "#ffd163"
`;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("desktop system theme", () => {
  it("parses Omarchy's flat colors file and canonicalizes its palette", () => {
    const values = parseFlatColorsToml(DARK_COLORS);
    expect(values).not.toBeNull();
    expect(normalizeSystemThemePalette(values!)).toEqual({
      background: "#070707",
      foreground: "#f9debe",
      accent: "#b36673",
      selection: "#f9debe",
      red: "#c5836b",
      green: "#f1b672",
      yellow: "#ffde94",
      blue: "#b36673",
      magenta: "#ee8d86",
      cyan: "#ffd163",
    });
  });

  it("reads a valid Linux palette from the desktop user's local state", () => {
    const homeDirectory = makeThemeHome(DARK_COLORS);
    expect(readDesktopSystemTheme({ platform: "linux", homeDirectory })).toMatchObject({
      appearance: "dark",
      colors: { background: "#070707", foreground: "#f9debe" },
    });
  });

  it("is unavailable on non-Linux platforms even when the files exist", () => {
    const homeDirectory = makeThemeHome(DARK_COLORS);
    expect(readDesktopSystemTheme({ platform: "darwin", homeDirectory })).toBeNull();
    expect(readDesktopSystemTheme({ platform: "win32", homeDirectory })).toBeNull();
  });

  it("rejects partial or malformed palettes", () => {
    expect(
      readDesktopSystemTheme({
        platform: "linux",
        homeDirectory: makeThemeHome('mode = "dark"\nbackground = "#070707"\n'),
      }),
    ).toBeNull();
    expect(parseFlatColorsToml('background = "#000000"\nbackground = "#ffffff"\n')).toBeNull();
  });
});
