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

/** Builds a ZIP by hand so central-directory fields can hold values JSZip
 *  would never write, such as a fake uncompressed size or a ZIP64 marker. */
function rawZip(
  entries: ReadonlyArray<{
    name: string;
    data?: Uint8Array;
    uncompressedSize?: number;
    compressedSize?: number;
  }>,
  comment = "",
): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = entry.data ?? new Uint8Array(0);
    const local = new Uint8Array(30 + name.byteLength + data.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint32(18, data.byteLength, true);
    localView.setUint32(22, data.byteLength, true);
    localView.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    local.set(data, 30 + name.byteLength);
    localParts.push(local);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint32(20, entry.compressedSize ?? data.byteLength, true);
    centralView.setUint32(24, entry.uncompressedSize ?? data.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centralParts.push(central);
    offset += local.byteLength;
  }
  const directorySize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
  const commentBytes = encoder.encode(comment);
  const end = new Uint8Array(22 + commentBytes.byteLength);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, directorySize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, commentBytes.byteLength, true);
  end.set(commentBytes, 22);

  const parts = [...localParts, ...centralParts, end];
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let position = 0;
  for (const part of parts) {
    bytes.set(part, position);
    position += part.byteLength;
  }
  return bytes;
}

describe("extension package safety limits", () => {
  const manifestEntry = {
    name: "extension/package.json",
    data: new TextEncoder().encode(JSON.stringify(draculaProManifest())),
  };

  it("rejects an archive that claims to expand past the uncompressed cap", async () => {
    const bytes = rawZip([
      manifestEntry,
      { name: "extension/huge.bin", uncompressedSize: 101 * 1024 * 1024, compressedSize: 1 },
    ]);

    await expect(importVsixThemeFile({ name: "bomb.vsix", bytes })).rejects.toThrow(
      "expands beyond the safe import limit",
    );
  });

  it("rejects an entry with an unsafe compression ratio", async () => {
    const bytes = rawZip([
      manifestEntry,
      { name: "extension/dense.bin", uncompressedSize: 1024 * 1024, compressedSize: 16 },
    ]);

    await expect(importVsixThemeFile({ name: "bomb.vsix", bytes })).rejects.toThrow(
      "unsafe compression ratio",
    );
  });

  it("rejects ZIP64 size markers", async () => {
    const bytes = rawZip([
      manifestEntry,
      { name: "extension/big.bin", uncompressedSize: 0xffffffff },
    ]);

    await expect(importVsixThemeFile({ name: "zip64.vsix", bytes })).rejects.toThrow(
      "unsupported ZIP64 metadata",
    );
  });

  it("rejects an archive with too many entries", async () => {
    const entries = Array.from({ length: 5_001 }, (_, index) => ({
      name: `extension/node_modules/file-${index}.js`,
    }));
    const bytes = rawZip([manifestEntry, ...entries]);

    await expect(importVsixThemeFile({ name: "many.vsix", bytes })).rejects.toThrow(
      "too many files",
    );
  });

  it("rejects an entry whose path escapes the package", async () => {
    const bytes = rawZip([manifestEntry, { name: "../../etc/passwd" }]);

    await expect(importVsixThemeFile({ name: "traversal.vsix", bytes })).rejects.toThrow(
      "could not be opened",
    );
  });

  it("rejects a theme contribution whose path escapes the package", async () => {
    const bytes = await vsixBytes(
      draculaProManifest({
        contributes: { themes: [{ label: "Escape", path: "../../outside.json" }] },
      }),
    );

    await expect(importVsixThemeFile({ name: "traversal.vsix", bytes })).rejects.toThrow(
      "could not be imported safely",
    );
  });

  it("reads an archive whose comment contains end-of-directory bytes", async () => {
    const encoder = new TextEncoder();
    // JSZip scans backwards for the EOCD signature and would stop on this
    // look-alike inside the comment. Its comment-length field does not match
    // the bytes that follow, so the directory inspection skips it.
    const decoyRecord = "PK\u0005\u0006" + "\u0000".repeat(16) + "\u0007\u0000";
    const bytes = rawZip(
      [
        manifestEntry,
        { name: "extension/theme/dracula-pro.json", data: encoder.encode(DARK_THEME) },
        { name: "extension/theme/dracula-pro-alucard.json", data: encoder.encode(LIGHT_THEME) },
      ],
      decoyRecord,
    );

    const themes = await importVsixThemeFile({ name: "commented.vsix", bytes });

    expect(themes).toHaveLength(2);
  });

  it("rejects a theme file past the per-file cap", async () => {
    const zip = new JSZip();
    zip.file("extension/package.json", JSON.stringify(draculaProManifest()));
    zip.file(
      "extension/theme/dracula-pro.json",
      JSON.stringify({ colors: { "editor.background": "#" + "1".repeat(300 * 1024) } }),
    );
    zip.file("extension/theme/dracula-pro-alucard.json", LIGHT_THEME);
    const bytes = new Uint8Array(await zip.generateAsync({ type: "uint8array" }));

    await expect(importVsixThemeFile({ name: "large-theme.vsix", bytes })).rejects.toThrow(
      "could not be imported safely",
    );
  });

  it("rejects an include cycle", async () => {
    const zip = new JSZip();
    zip.file("extension/package.json", JSON.stringify(draculaProManifest()));
    zip.file(
      "extension/theme/dracula-pro.json",
      JSON.stringify({ include: "./dracula-pro-alucard.json" }),
    );
    zip.file(
      "extension/theme/dracula-pro-alucard.json",
      JSON.stringify({ include: "./dracula-pro.json" }),
    );
    const bytes = new Uint8Array(await zip.generateAsync({ type: "uint8array" }));

    await expect(importVsixThemeFile({ name: "cycle.vsix", bytes })).rejects.toThrow(
      "could not be imported safely",
    );
  });
});
