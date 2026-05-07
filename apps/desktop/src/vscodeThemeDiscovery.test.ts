import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverEditorColorThemes,
  getEditorThemePreferences,
  loadEditorColorTheme,
  resolveEditorRoots,
} from "./vscodeThemeDiscovery.ts";

let tempDir = "";

function writeJson(filePath: string, value: unknown) {
  FS.mkdirSync(Path.dirname(filePath), { recursive: true });
  FS.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

describe("vscodeThemeDiscovery", () => {
  beforeEach(() => {
    tempDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3-vscode-themes-"));
  });

  afterEach(() => {
    FS.rmSync(tempDir, { recursive: true, force: true });
  });

  it("discovers contributed themes and ignores unsafe paths", () => {
    const roots = resolveEditorRoots({ platform: "darwin", homedir: tempDir });
    const vscodeRoot = roots.find((root) => root.source === "vscode");
    expect(vscodeRoot).toBeDefined();
    if (!vscodeRoot) return;

    const extensionDir = Path.join(vscodeRoot.extensionsPath, "github.github-vscode-theme");
    writeJson(Path.join(extensionDir, "package.json"), {
      publisher: "GitHub",
      displayName: "GitHub Theme",
      contributes: {
        themes: [
          { label: "GitHub Dark Default", uiTheme: "vs-dark", path: "./themes/dark.json" },
          { label: "Escaped", uiTheme: "vs", path: "../escaped.json" },
        ],
      },
    });
    writeJson(Path.join(extensionDir, "themes", "dark.json"), {
      colors: { "editor.background": "#0d1117" },
    });

    expect(discoverEditorColorThemes(roots)).toMatchObject([
      {
        source: "vscode",
        label: "GitHub Dark Default",
        kind: "dark",
        publisher: "GitHub",
      },
    ]);
  });

  it("loads JSONC settings overrides into the resolved app theme", () => {
    const roots = resolveEditorRoots({ platform: "darwin", homedir: tempDir });
    const vscodeRoot = roots.find((root) => root.source === "vscode");
    expect(vscodeRoot).toBeDefined();
    if (!vscodeRoot) return;

    const extensionDir = Path.join(vscodeRoot.extensionsPath, "github.github-vscode-theme");
    writeJson(Path.join(extensionDir, "package.json"), {
      contributes: {
        themes: [{ label: "GitHub Dark Default", uiTheme: "vs-dark", path: "./themes/dark.json" }],
      },
    });
    writeJson(Path.join(extensionDir, "themes", "dark.json"), {
      semanticHighlighting: true,
      colors: {
        "editor.background": "#0d1117",
        "editor.foreground": "#e6edf3",
      },
      tokenColors: [],
    });
    FS.mkdirSync(Path.dirname(vscodeRoot.settingsPath), { recursive: true });
    FS.writeFileSync(
      vscodeRoot.settingsPath,
      `{
        "workbench.colorTheme": "GitHub Dark Default",
        "workbench.colorCustomizations": {
          "button.background": "#238636",
          "[GitHub Dark Default]": {
            "sideBar.background": "#010409"
          }
        }
      }`,
    );

    const preferences = getEditorThemePreferences(roots);
    expect(preferences[0]?.colorTheme).toBe("GitHub Dark Default");

    const themeId = discoverEditorColorThemes(roots)[0]?.id;
    expect(themeId).toBeTruthy();
    const resolved = themeId ? loadEditorColorTheme(themeId, roots) : null;

    expect(resolved?.colors["button.background"]).toBe("#238636");
    expect(resolved?.colors["sideBar.background"]).toBe("#010409");
    expect(resolved?.appVariables["--primary"]).toBe("#238636");
  });
});
