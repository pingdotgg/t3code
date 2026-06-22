// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  collectThemesFromRoots,
  loadAndMergeTheme,
  mergeTheme,
  resolveNlsLabel,
  uiThemeToType,
} from "./VscodeThemeCatalog.ts";

async function makeTempDir(): Promise<string> {
  return NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "theme-catalog-test-"));
}

async function writeFile(filePath: string, contents: string): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(filePath), { recursive: true });
  await NodeFSP.writeFile(filePath, contents, "utf8");
}

describe("uiThemeToType", () => {
  it("maps light ui themes to light and everything else to dark", () => {
    expect(uiThemeToType("vs")).toBe("light");
    expect(uiThemeToType("hc-light")).toBe("light");
    expect(uiThemeToType("vs-dark")).toBe("dark");
    expect(uiThemeToType("hc-black")).toBe("dark");
    expect(uiThemeToType(undefined)).toBe("dark");
  });
});

describe("resolveNlsLabel", () => {
  it("resolves %key% placeholders against the nls map", () => {
    expect(resolveNlsLabel("%coolDark%", { coolDark: "Cool Dark" })).toBe("Cool Dark");
  });

  it("supports object-valued nls entries with a message", () => {
    expect(resolveNlsLabel("%k%", { k: { message: "Hi", comment: ["x"] } })).toBe("Hi");
  });

  it("returns non-placeholder labels unchanged and falls back to the key", () => {
    expect(resolveNlsLabel("Plain Light", null)).toBe("Plain Light");
    expect(resolveNlsLabel("%missing%", { other: "x" })).toBe("missing");
  });
});

describe("mergeTheme", () => {
  it("merges colors, appends child tokenColors after parent, and drops include", () => {
    const merged = mergeTheme(
      {
        include: "./parent.json",
        colors: { "editor.background": "#000", a: "#111" },
        tokenColors: [{ scope: "comment", settings: { foreground: "#aaa" } }],
      },
      {
        colors: { a: "#222", "editor.foreground": "#fff" },
        tokenColors: [{ scope: "keyword", settings: { foreground: "#f00" } }],
      },
    );

    expect(merged.colors).toEqual({
      "editor.background": "#000",
      a: "#222",
      "editor.foreground": "#fff",
    });
    expect(merged.tokenColors).toEqual([
      { scope: "comment", settings: { foreground: "#aaa" } },
      { scope: "keyword", settings: { foreground: "#f00" } },
    ]);
    expect("include" in merged).toBe(false);
  });
});

describe("loadAndMergeTheme", () => {
  it("resolves an include chain and parses JSONC (comments + trailing commas)", async () => {
    const dir = await makeTempDir();
    await writeFile(
      NodePath.join(dir, "dark_plus.json"),
      JSON.stringify({
        colors: { "editor.background": "#000000", shared: "#parent" },
        tokenColors: [{ scope: "comment", settings: { foreground: "#888" } }],
      }),
    );
    await writeFile(
      NodePath.join(dir, "dark_modern.json"),
      `{
        // inherits from dark_plus
        "include": "./dark_plus.json",
        "colors": { "shared": "#child", "editor.foreground": "#ffffff", },
        "tokenColors": [{ "scope": "keyword", "settings": { "foreground": "#ff0000" } },],
      }`,
    );

    const merged = await loadAndMergeTheme(NodePath.join(dir, "dark_modern.json"));

    expect(merged.colors).toEqual({
      "editor.background": "#000000",
      shared: "#child",
      "editor.foreground": "#ffffff",
    });
    expect((merged.tokenColors as unknown[]).length).toBe(2);

    await NodeFSP.rm(dir, { recursive: true, force: true });
  });

  it("rejects on an include cycle", async () => {
    const dir = await makeTempDir();
    await writeFile(NodePath.join(dir, "a.json"), JSON.stringify({ include: "./b.json" }));
    await writeFile(NodePath.join(dir, "b.json"), JSON.stringify({ include: "./a.json" }));

    await expect(loadAndMergeTheme(NodePath.join(dir, "a.json"))).rejects.toThrow(/cycle/);

    await NodeFSP.rm(dir, { recursive: true, force: true });
  });
});

describe("collectThemesFromRoots", () => {
  it("enumerates extension themes, resolves nls labels, and infers type from uiTheme", async () => {
    const root = await makeTempDir();
    const extDir = NodePath.join(root, "my-publisher.cool-theme-1.0.0");
    await writeFile(
      NodePath.join(extDir, "package.json"),
      JSON.stringify({
        contributes: {
          themes: [
            { label: "%coolDark%", uiTheme: "vs-dark", path: "./themes/cool-dark.json" },
            { label: "Plain Light", uiTheme: "vs", path: "./themes/cool-light.json" },
          ],
        },
      }),
    );
    await writeFile(NodePath.join(extDir, "package.nls.json"), JSON.stringify({ coolDark: "Cool Dark" }));
    await writeFile(NodePath.join(extDir, "themes/cool-dark.json"), JSON.stringify({ colors: {} }));
    await writeFile(NodePath.join(extDir, "themes/cool-light.json"), JSON.stringify({ colors: {} }));

    const records = await collectThemesFromRoots([{ dir: root, source: "extension" }]);

    expect(records).toHaveLength(2);
    const dark = records.find((record) => record.label === "Cool Dark");
    const light = records.find((record) => record.label === "Plain Light");
    expect(dark).toBeDefined();
    expect(dark?.type).toBe("dark");
    expect(dark?.source).toBe("extension");
    expect(dark?.id).toBe(
      "extension::my-publisher.cool-theme-1.0.0::./themes/cool-dark.json",
    );
    expect(light?.type).toBe("light");

    await NodeFSP.rm(root, { recursive: true, force: true });
  });

  it("skips extensions without theme contributions and missing roots", async () => {
    const root = await makeTempDir();
    const extDir = NodePath.join(root, "not-a-theme-1.0.0");
    await writeFile(NodePath.join(extDir, "package.json"), JSON.stringify({ contributes: {} }));

    const records = await collectThemesFromRoots([
      { dir: root, source: "extension" },
      { dir: NodePath.join(root, "does-not-exist"), source: "builtin" },
    ]);

    expect(records).toHaveLength(0);

    await NodeFSP.rm(root, { recursive: true, force: true });
  });
});
