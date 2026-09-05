import { sha256 } from "@noble/hashes/sha2";
import JSZip from "jszip";
import { parse, type ParseError } from "jsonc-parser";

import type { ThemeCollection, ThemeDefinition } from "./themePalette";
import {
  humanizeThemeName,
  isVsCodeThemeFile,
  pairVsCodeThemes,
  parseVsCodeThemeFile,
  resolveThemeLabelCollisions,
} from "./vscodeThemeImport";

export const MAX_VSIX_BYTES = 20 * 1024 * 1024;
const MAX_THEME_BYTES = 256 * 1024;
const MAX_ZIP_ENTRIES = 5_000;
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;
export const MAX_THEMES_PER_EXTENSION = 40;
const MAX_INCLUDE_DEPTH = 8;
const MAX_PACKAGE_PATH_LENGTH = 1_024;
const MAX_COLOR_VALUE_LENGTH = 128;
const MAX_RESOLVED_THEME_FILES = MAX_THEMES_PER_EXTENSION * MAX_INCLUDE_DEPTH;
const USED_WORKBENCH_COLORS = new Set([
  "activityBar.background",
  "activityBarBadge.background",
  "badge.background",
  "button.background",
  "button.foreground",
  "contrastBorder",
  "descriptionForeground",
  "disabledForeground",
  "dropdown.background",
  "dropdown.border",
  "editor.background",
  "editor.foreground",
  "editor.selectionBackground",
  "editorCursor.foreground",
  "editorError.foreground",
  "editorGroup.border",
  "editorPane.background",
  "editorWarning.foreground",
  "editorWidget.background",
  "errorForeground",
  "focusBorder",
  "foreground",
  "input.border",
  "input.placeholderForeground",
  "list.activeSelectionBackground",
  "list.hoverBackground",
  "list.inactiveSelectionBackground",
  "menu.background",
  "panel.background",
  "panel.border",
  "progressBar.background",
  "quickInput.background",
  "scrollbarSlider.background",
  "sideBar.background",
  "sideBar.border",
  "sideBar.foreground",
  "terminal.background",
  "terminal.foreground",
  "terminal.selectionBackground",
  "terminalCursor.foreground",
  "textCodeBlock.background",
  "textLink.foreground",
]);

type ThemeContribution = { label?: unknown; uiTheme?: unknown; path?: unknown };

/** Where a package came from, so ids stay stable per source and two installs
 *  of the same extension from different sources cannot collide. */
export type ThemePackageIdentity = {
  /** Prefix for generated theme ids, one per import source. */
  idPrefix: string;
  /** Stable key the ids hash from, usually `publisher.name`. */
  key: string;
  /** Fallback label for contributions that ship without one. */
  name: string;
  collection: ThemeCollection;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function shortHash(value: string): string {
  return [...sha256(new TextEncoder().encode(value))]
    .slice(0, 6)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function parseJsoncObject(source: string, description: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value: unknown = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isRecord(value)) throw new Error(`${description} is not valid JSON.`);
  return value;
}

export function themeContributions(manifest: Record<string, unknown>): ThemeContribution[] {
  const contributes = isRecord(manifest.contributes) ? manifest.contributes : null;
  return Array.isArray(contributes?.themes)
    ? (contributes.themes.filter(isRecord) as ThemeContribution[])
    : [];
}

function sanitizeThemeObject(value: Record<string, unknown>): Record<string, unknown> {
  const colors: Record<string, string> = {};
  if (isRecord(value.colors)) {
    for (const [key, color] of Object.entries(value.colors)) {
      if (
        USED_WORKBENCH_COLORS.has(key) &&
        typeof color === "string" &&
        color.length <= MAX_COLOR_VALUE_LENGTH
      ) {
        colors[key] = color;
      }
    }
  }
  return {
    ...(typeof value.include === "string" ? { include: value.include } : {}),
    colors,
  };
}

function normalizePackagePath(path: string, relativeTo = "extension/"): string {
  if (
    path.length > MAX_PACKAGE_PATH_LENGTH ||
    path.includes("\0") ||
    path.startsWith("/") ||
    /^[a-zA-Z]:/.test(path)
  ) {
    throw new Error("Theme path is not a safe relative package path.");
  }
  const normalizedInput = path.replaceAll("\\", "/");
  const baseSegments = relativeTo.split("/").slice(0, -1);
  const segments = baseSegments;
  for (const segment of normalizedInput.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length <= 1) throw new Error("Theme path escapes the extension package.");
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments[0] !== "extension") segments.unshift("extension");
  return segments.join("/");
}

function contributionType(uiTheme: unknown): string | null {
  if (uiTheme === "vs") return "light";
  if (uiTheme === "vs-dark") return "dark";
  if (uiTheme === "hc-black" || uiTheme === "hc-light") return uiTheme;
  return null;
}

type ZipEntrySizes = {
  uncompressedSize?: unknown;
};

type InspectableZipObject = JSZip.JSZipObject & {
  _data?: ZipEntrySizes;
  unsafeOriginalName?: string;
  internalStream?: (type: "uint8array") => JSZip.JSZipStreamHelper<Uint8Array>;
};

function inspectZipDirectory(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumOffset = Math.max(0, bytes.byteLength - 65_557);
  let endOffset = bytes.byteLength - 22;
  while (
    endOffset >= minimumOffset &&
    (view.getUint32(endOffset, true) !== 0x06054b50 ||
      endOffset + 22 + view.getUint16(endOffset + 20, true) !== bytes.byteLength)
  ) {
    endOffset -= 1;
  }
  if (endOffset < minimumOffset) throw new Error("That extension package has no ZIP directory.");

  const directorySize = view.getUint32(endOffset + 12, true);
  const directoryOffset = view.getUint32(endOffset + 16, true);
  const directoryEnd = directoryOffset + directorySize;
  if (directoryEnd !== endOffset || directoryEnd > bytes.byteLength) {
    throw new Error("That extension package has an invalid ZIP directory.");
  }

  let entryCount = 0;
  let totalUncompressed = 0;
  let offset = directoryOffset;
  while (offset < directoryEnd) {
    if (offset + 46 > directoryEnd || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("That extension package has an invalid ZIP directory.");
    }
    entryCount += 1;
    if (entryCount > MAX_ZIP_ENTRIES) {
      throw new Error("That extension package has too many files.");
    }
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) {
      throw new Error("That extension package has unsupported ZIP64 metadata.");
    }
    totalUncompressed += uncompressed;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
      throw new Error("That extension package expands beyond the safe import limit.");
    }
    if (
      uncompressed > 0 &&
      (compressed === 0 || uncompressed / compressed > MAX_COMPRESSION_RATIO)
    ) {
      throw new Error("That extension package has an unsafe compression ratio.");
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== directoryEnd)
    throw new Error("That extension package has an invalid ZIP directory.");

  const commentLength = view.getUint16(endOffset + 20, true);
  if (commentLength === 0) return bytes;

  // JSZip mistakes EOCD-like bytes inside an archive comment for the real EOCD.
  // The comment is not needed for theme import, so remove it before parsing.
  const withoutComment = bytes.slice(0, endOffset + 22);
  withoutComment[endOffset + 20] = 0;
  withoutComment[endOffset + 21] = 0;
  return withoutComment;
}

function inspectZip(zip: JSZip): void {
  const entries = Object.values(zip.files) as InspectableZipObject[];
  if (entries.length > MAX_ZIP_ENTRIES)
    throw new Error("That extension package has too many files.");

  for (const entry of entries) {
    if (entry.unsafeOriginalName) normalizePackagePath(entry.unsafeOriginalName);
  }
}

async function readZipText(
  zip: JSZip,
  path: string,
  description: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const file = zip.file(path) as InspectableZipObject | null;
  if (!file) throw new Error(`${description} is missing from the extension package.`);
  if (typeof file._data?.uncompressedSize !== "number" || !file.internalStream) {
    throw new Error(`${description} has unreadable size metadata.`);
  }
  if (file._data.uncompressedSize > MAX_THEME_BYTES) {
    throw new Error(`${description} is too large.`);
  }

  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    let settled = false;
    const stream = file.internalStream!("uint8array");
    const cleanup = () => signal?.removeEventListener("abort", handleAbort);
    const handleAbort = () => {
      if (settled) return;
      settled = true;
      stream.pause();
      cleanup();
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
    stream
      .on("data", (chunk) => {
        if (settled) return;
        byteLength += chunk.byteLength;
        if (byteLength > MAX_THEME_BYTES) {
          settled = true;
          stream.pause();
          cleanup();
          reject(new Error(`${description} is too large.`));
          return;
        }
        chunks.push(chunk);
      })
      .on("error", (cause) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(cause);
      })
      .on("end", () => {
        if (settled) return;
        settled = true;
        cleanup();
        const bytes = new Uint8Array(byteLength);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        resolve(new TextDecoder().decode(bytes));
      })
      .resume();
  });
}

async function loadThemeObject(
  zip: JSZip,
  path: string,
  cache: Map<string, Record<string, unknown>>,
  budget: { files: number },
  ancestors: ReadonlySet<string> = new Set(),
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  if (ancestors.size >= MAX_INCLUDE_DEPTH) throw new Error("Theme includes are nested too deeply.");
  if (ancestors.has(path)) throw new Error("Theme includes contain a cycle.");
  const cached = cache.get(path);
  if (cached) return cached;
  budget.files += 1;
  if (budget.files > MAX_RESOLVED_THEME_FILES) {
    throw new Error("That extension references too many theme files.");
  }

  const value = sanitizeThemeObject(
    parseJsoncObject(await readZipText(zip, path, path, signal), path),
  );
  if (typeof value.include !== "string") {
    cache.set(path, value);
    return value;
  }

  const includePath = normalizePackagePath(value.include, path);
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(path);
  const base = await loadThemeObject(zip, includePath, cache, budget, nextAncestors, signal);
  const resolved = {
    ...base,
    ...value,
    colors: {
      ...(isRecord(base.colors) ? base.colors : {}),
      ...(isRecord(value.colors) ? value.colors : {}),
    },
  };
  cache.set(path, resolved);
  return resolved;
}

/** Opens VSIX bytes after the ZIP metadata has been checked for the shapes
 *  that make an archive unsafe to expand. */
export async function openThemePackage(
  packageBytes: Uint8Array,
  signal?: AbortSignal,
): Promise<JSZip> {
  try {
    const inspectedPackageBytes = inspectZipDirectory(packageBytes);
    const zip = await JSZip.loadAsync(inspectedPackageBytes);
    signal?.throwIfAborted();
    inspectZip(zip);
    return zip;
  } catch (cause) {
    if (signal?.aborted) signal.throwIfAborted();
    if (cause instanceof Error && cause.message.startsWith("That extension package")) throw cause;
    throw new Error("That extension package could not be opened.", { cause });
  }
}

export async function readPackagedManifest(
  zip: JSZip,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return parseJsoncObject(
    await readZipText(zip, "extension/package.json", "Extension manifest", signal),
    "Extension manifest",
  );
}

/** Converts every color theme a package contributes into a theme collection. */
export async function themesFromPackage(
  zip: JSZip,
  packagedManifest: Record<string, unknown>,
  identity: ThemePackageIdentity,
  signal?: AbortSignal,
): Promise<ReadonlyArray<ThemeDefinition>> {
  const contributions = themeContributions(packagedManifest);
  if (contributions.length === 0) throw new Error("That extension does not contain color themes.");
  if (contributions.length > MAX_THEMES_PER_EXTENSION) {
    throw new Error("That extension contains too many color themes to import safely.");
  }

  const parsed: Array<{ theme: ThemeDefinition; sourceName: string; sourcePath: string }> = [];
  const failures: string[] = [];
  const themeCache = new Map<string, Record<string, unknown>>();
  const themeBudget = { files: 0 };
  for (const contribution of contributions) {
    signal?.throwIfAborted();
    if (typeof contribution.path !== "string") {
      failures.push("theme path is missing");
      continue;
    }
    try {
      const path = normalizePackagePath(contribution.path);
      const themeValue = await loadThemeObject(
        zip,
        path,
        themeCache,
        themeBudget,
        new Set(),
        signal,
      );
      const type = contributionType(contribution.uiTheme);
      const label =
        typeof contribution.label === "string" && contribution.label.trim()
          ? contribution.label.trim()
          : identity.name;
      const decorated = {
        ...themeValue,
        displayName: label,
        ...(type ? { type } : {}),
      };
      if (!isVsCodeThemeFile(decorated)) throw new Error("not a VS Code color theme");
      parsed.push({
        theme: parseVsCodeThemeFile(decorated),
        sourceName: path.split("/").at(-1)!,
        sourcePath: path,
      });
    } catch (cause) {
      signal?.throwIfAborted();
      failures.push(cause instanceof Error ? cause.message : "theme could not be read");
    }
  }
  if (failures.length > 0) {
    throw new Error("One or more color themes in that extension could not be imported safely.");
  }
  if (parsed.length === 0) {
    throw new Error("That extension has no compatible color themes.");
  }

  const themeId = (source: string) =>
    `${identity.idPrefix}-${shortHash(`${identity.key}:${source}`)}`;
  const sourcePathCounts = new Map<string, number>();
  for (const { sourcePath } of parsed) {
    sourcePathCounts.set(sourcePath, (sourcePathCounts.get(sourcePath) ?? 0) + 1);
  }
  const sourcePathOccurrences = new Map<string, number>();
  const sourceIdentities = parsed.map(({ sourcePath }) => {
    if (sourcePathCounts.get(sourcePath) === 1) return sourcePath;
    const occurrence = sourcePathOccurrences.get(sourcePath) ?? 0;
    sourcePathOccurrences.set(sourcePath, occurrence + 1);
    return occurrence === 0 ? sourcePath : `${sourcePath}\0${occurrence}`;
  });
  const resolved = resolveThemeLabelCollisions(parsed).map((theme, index) => ({
    ...theme,
    id: themeId(sourceIdentities[index]!),
  }));
  const paired = pairVsCodeThemes(resolved, {
    pairedId: (light, dark) => themeId([light.id, dark.id].sort().join(":")),
  });
  const themes = resolveThemeLabelCollisions(paired.map((theme) => ({ theme })));
  return themes.map((theme) => ({ ...theme, collection: identity.collection }));
}

function collectionId(prefix: string, key: string): string {
  const normalized = `${prefix}:${key}`;
  return /^[a-z0-9][a-z0-9.:-]{0,127}$/.test(normalized)
    ? normalized
    : `${prefix}:${shortHash(key)}`;
}

/** Identity for a package the user picked off their own disk. The manifest is
 *  the only source of truth here, so a manifest without a publisher falls back
 *  to the file name. */
function localPackageIdentity(
  packagedManifest: Record<string, unknown>,
  fileName: string,
): ThemePackageIdentity {
  const publisher =
    typeof packagedManifest.publisher === "string" ? packagedManifest.publisher.trim() : "";
  const name = typeof packagedManifest.name === "string" ? packagedManifest.name.trim() : "";
  const displayName =
    typeof packagedManifest.displayName === "string" ? packagedManifest.displayName.trim() : "";
  const baseName = fileName.replace(/\.vsix$/i, "") || "extension";
  const key = (publisher && name ? `${publisher}.${name}` : baseName).toLowerCase();
  const label =
    [displayName, name, baseName]
      .map((candidate) => humanizeThemeName(candidate).slice(0, 48))
      .find((candidate) => candidate.length > 0) ?? "Extension themes";
  return {
    idPrefix: "vsix-theme",
    key,
    name: label,
    collection: { id: collectionId("local-vsix", key), label },
  };
}

export type VsixThemeFile = { name: string; bytes: Uint8Array };

/** Imports a .vsix the user picked locally. Unlike an Open VSX install there
 *  is no registry metadata to check it against, so the packaged manifest is
 *  trusted for identity and the license gate does not apply: the user already
 *  has the file. */
export async function importVsixThemeFile(
  file: VsixThemeFile,
  signal?: AbortSignal,
): Promise<ReadonlyArray<ThemeDefinition>> {
  if (file.bytes.byteLength > MAX_VSIX_BYTES) {
    throw new Error("That extension package is too large to import safely.");
  }
  const zip = await openThemePackage(file.bytes, signal);
  const packagedManifest = await readPackagedManifest(zip, signal);
  return themesFromPackage(
    zip,
    packagedManifest,
    localPackageIdentity(packagedManifest, file.name),
    signal,
  );
}
