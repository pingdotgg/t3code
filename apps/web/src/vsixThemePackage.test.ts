import JSZip from "jszip";
import { describe, expect, it } from "vite-plus/test";

import { getThemeColorsForMode, themeColorToHex } from "./themePalette";
import { importVsixThemeFile, MAX_VSIX_BYTES } from "./vsixThemePackage";

const DARK_THEME = JSON.stringify({
  colors: { "editor.background": "#111111", "editor.foreground": "#eeeeee" },
});
const LIGHT_THEME = JSON.stringify({
  colors: { "editor.background": "#fafafa", "editor.foreground": "#222222" },
});

function draculaProManifest(overrides: Record<string, unknown> = {}) {
  return {
    name: "theme-dracula-pro",
    displayName: "Dracula Pro",
    version: "2.2.2",
    publisher: "dracula-theme-pro",
    // Paid themes are not open source. A local file is the user's own copy,
    // so the license gate that applies to Open VSX must not apply here.
    license: "proprietary",
    contributes: {
      themes: [
        { label: "Dracula Pro", uiTheme: "vs-dark", path: "./theme/dracula-pro.json" },
        {
          label: "Dracula Pro (Alucard)",
          uiTheme: "vs",
          path: "./theme/dracula-pro-alucard.json",
        },
      ],
    },
    ...overrides,
  };
}

async function vsixBytes(manifest: Record<string, unknown>): Promise<Uint8Array> {
  const zip = new JSZip();
  // A real .vsix carries OPC metadata outside `extension/` plus assets the
  // import ignores.
  zip.file("extension.vsixmanifest", "<PackageManifest />");
  zip.file("[Content_Types].xml", "<Types />");
  zip.file("extension/README.md", "# Dracula Pro");
  zip.file("extension/package.json", JSON.stringify(manifest));
  zip.file("extension/theme/dracula-pro.json", DARK_THEME);
  zip.file("extension/theme/dracula-pro-alucard.json", LIGHT_THEME);
  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
}

describe("local .vsix theme import", () => {
  it("imports a proprietary package as one collection with stable ids", async () => {
    const bytes = await vsixBytes(draculaProManifest());

    const themes = await importVsixThemeFile({ name: "dracula-pro.vsix", bytes });

    expect(themes).toHaveLength(2);
    expect(themes.map((theme) => theme.label)).toEqual(["Dracula Pro", "Dracula Pro (Alucard)"]);
    expect(
      themes.every(
        (theme) => theme.collection?.id === "local-vsix:dracula-theme-pro.theme-dracula-pro",
      ),
    ).toBe(true);
    expect(themes.every((theme) => theme.collection?.label === "Dracula Pro")).toBe(true);
    // A local install must never collide with the same extension installed
    // from Open VSX, so it carries its own id prefix.
    expect(themes.every((theme) => /^vsix-theme-[0-9a-f]{12}$/.test(theme.id))).toBe(true);
    expect(new Set(themes.map((theme) => theme.id)).size).toBe(2);
    expect(themeColorToHex(themes[0]!.colors.canvas)).toBe("#111111");
    expect(themes[1]!.appearance).toBe("light");

    // Re-importing the same package under a different file name reuses the
    // manifest identity, so an update replaces rather than duplicates.
    const reimported = await importVsixThemeFile({ name: "dracula-pro-2.2.2.vsix", bytes });
    expect(reimported.map((theme) => theme.id)).toEqual(themes.map((theme) => theme.id));
  });

  it("pairs light and dark variants that share a name", async () => {
    const bytes = await vsixBytes(
      draculaProManifest({
        displayName: "Demo",
        contributes: {
          themes: [
            { label: "Demo Dark", uiTheme: "vs-dark", path: "./theme/dracula-pro.json" },
            { label: "Demo Light", uiTheme: "vs", path: "./theme/dracula-pro-alucard.json" },
          ],
        },
      }),
    );

    const themes = await importVsixThemeFile({ name: "demo.vsix", bytes });

    expect(themes).toHaveLength(1);
    expect(themeColorToHex(getThemeColorsForMode(themes[0]!, "light")!.canvas)).toBe("#fafafa");
    expect(themeColorToHex(getThemeColorsForMode(themes[0]!, "dark")!.canvas)).toBe("#111111");
  });

  it("falls back to the file name when the manifest has no identity", async () => {
    const manifest = draculaProManifest();
    Reflect.deleteProperty(manifest, "publisher");
    Reflect.deleteProperty(manifest, "name");
    Reflect.deleteProperty(manifest, "displayName");
    const bytes = await vsixBytes(manifest);

    const themes = await importVsixThemeFile({ name: "my-theme-pack.vsix", bytes });

    expect(themes[0]!.collection?.id).toBe("local-vsix:my-theme-pack");
    expect(themes[0]!.collection?.label).toBe("My Theme Pack");
  });

  it("rejects packages without color themes", async () => {
    const manifest = draculaProManifest({ contributes: { commands: [] } });
    const bytes = await vsixBytes(manifest);

    await expect(importVsixThemeFile({ name: "empty.vsix", bytes })).rejects.toThrow(
      "does not contain color themes",
    );
  });

  it("rejects a contribution whose theme file is missing", async () => {
    const bytes = await vsixBytes(
      draculaProManifest({
        contributes: { themes: [{ label: "Gone", path: "./theme/missing.json" }] },
      }),
    );

    await expect(importVsixThemeFile({ name: "broken.vsix", bytes })).rejects.toThrow(
      "could not be imported safely",
    );
  });

  it("rejects a file that is not a ZIP archive", async () => {
    await expect(
      importVsixThemeFile({ name: "notes.vsix", bytes: new Uint8Array([1, 2, 3]) }),
    ).rejects.toThrow("extension package");
  });

  it("rejects an oversized package before opening it", async () => {
    await expect(
      importVsixThemeFile({
        name: "huge.vsix",
        bytes: new Uint8Array(MAX_VSIX_BYTES + 1),
      }),
    ).rejects.toThrow("too large to import safely");
  });
});
