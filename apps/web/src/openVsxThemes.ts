import { sha256 } from "@noble/hashes/sha2";
import JSZip from "jszip";
import { parse, type ParseError } from "jsonc-parser";

import type { ThemeDefinition } from "./themePalette";
import {
  isVsCodeThemeFile,
  pairVsCodeThemes,
  parseVsCodeThemeFile,
  resolveThemeLabelCollisions,
} from "./vscodeThemeImport";

const OPEN_VSX_SEARCH_URL = "https://open-vsx.org/api/-/search";
const MAX_VSIX_BYTES = 20 * 1024 * 1024;
const MAX_SEARCH_BYTES = 512 * 1024;
const MAX_DETAIL_BYTES = 256 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const SEARCH_REQUEST_TIMEOUT_MS = 10_000;
const MAX_THEME_BYTES = 256 * 1024;
const MAX_ZIP_ENTRIES = 2_000;
const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;
const MAX_THEMES_PER_EXTENSION = 40;
const MAX_INCLUDE_DEPTH = 8;
const MAX_PACKAGE_PATH_LENGTH = 1_024;
const MAX_COLOR_VALUE_LENGTH = 128;
const MAX_RESOLVED_THEME_FILES = MAX_THEMES_PER_EXTENSION * MAX_INCLUDE_DEPTH;
const SUPPORTED_LICENSES = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MPL-2.0",
  "Unlicense",
]);
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

export type OpenVsxThemeExtension = {
  id: string;
  name: string;
  publisher: string;
  description: string;
  downloadCount: number;
  manifestUrl: string;
  sha256Url: string;
  vsixUrl: string;
  version: string;
  license: string;
};

type ThemeContribution = { label?: unknown; uiTheme?: unknown; path?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trustedOpenVsxUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "open-vsx.org"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function themeContributions(manifest: Record<string, unknown>): ThemeContribution[] {
  const contributes = isRecord(manifest.contributes) ? manifest.contributes : null;
  return Array.isArray(contributes?.themes)
    ? (contributes.themes.filter(isRecord) as ThemeContribution[])
    : [];
}

function extensionFromDetail(value: unknown): OpenVsxThemeExtension | null {
  if (!isRecord(value) || !isRecord(value.files)) {
    throw new Error("Open VSX returned malformed theme details.");
  }
  const namespace = typeof value.namespace === "string" ? value.namespace.trim() : "";
  const extensionName = typeof value.name === "string" ? value.name.trim() : "";
  const displayName =
    (typeof value.displayName === "string" ? value.displayName.trim() : "") || extensionName;
  const version = typeof value.version === "string" ? value.version.trim() : "";
  const license = typeof value.license === "string" ? value.license.trim() : "";
  const manifestUrl = trustedOpenVsxUrl(value.files.manifest);
  const sha256Url = trustedOpenVsxUrl(value.files.sha256);
  const vsixUrl = trustedOpenVsxUrl(value.files.download);
  if (!namespace || !extensionName || !version || !manifestUrl || !sha256Url || !vsixUrl) {
    throw new Error("Open VSX returned malformed theme details.");
  }
  if (!SUPPORTED_LICENSES.has(license)) return null;
  return {
    id: `${namespace}.${extensionName}`,
    name: displayName,
    publisher: namespace,
    description: typeof value.description === "string" ? value.description : "",
    downloadCount:
      typeof value.downloadCount === "number" && Number.isFinite(value.downloadCount)
        ? value.downloadCount
        : 0,
    manifestUrl,
    sha256Url,
    vsixUrl,
    version,
    license,
  };
}

async function withSearchTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parentSignal?.aborted) abort();
  else parentSignal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, SEARCH_REQUEST_TIMEOUT_MS);
  try {
    return await operation(controller.signal);
  } catch (cause) {
    if (controller.signal.aborted && !parentSignal?.aborted) {
      throw new Error("Open VSX took too long to respond.", { cause });
    }
    throw cause;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abort);
  }
}

export async function searchOpenVsxThemes(
  query: string,
  signal?: AbortSignal,
): Promise<OpenVsxThemeExtension[]> {
  const searchText = query.trim();
  if (!searchText) return [];
  const url = new URL(OPEN_VSX_SEARCH_URL);
  url.searchParams.set("query", searchText);
  url.searchParams.set("category", "Themes");
  // Ask for a few extras because results without a supported SPDX license
  // are intentionally omitted.
  url.searchParams.set("size", "16");
  const value = await withSearchTimeout(async (requestSignal) => {
    const response = await fetch(url, { signal: requestSignal });
    if (!response.ok) throw new Error("Open VSX search is unavailable right now.");
    const searchBytes = await readCappedResponse(
      response,
      MAX_SEARCH_BYTES,
      "Open VSX returned an unexpectedly large response.",
    );
    try {
      return JSON.parse(new TextDecoder().decode(searchBytes)) as unknown;
    } catch {
      throw new Error("Open VSX returned an unreadable response.");
    }
  }, signal);
  const candidates = isRecord(value) && Array.isArray(value.extensions) ? value.extensions : [];
  const identities = candidates.flatMap((candidate): Array<[string, string]> => {
    if (!isRecord(candidate)) return [];
    const namespace = typeof candidate.namespace === "string" ? candidate.namespace : "";
    const name = typeof candidate.name === "string" ? candidate.name : "";
    return namespace && name ? [[namespace, name]] : [];
  });
  const details = await Promise.allSettled(
    identities.slice(0, 16).map(([namespace, name]) =>
      withSearchTimeout(async (requestSignal) => {
        const detailUrl = `https://open-vsx.org/api/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
        const detailResponse = await fetch(detailUrl, { signal: requestSignal });
        if (!detailResponse.ok) throw new Error("Open VSX theme details are unavailable.");
        const detailBytes = await readCappedResponse(
          detailResponse,
          MAX_DETAIL_BYTES,
          "Open VSX returned an unexpectedly large detail response.",
        );
        try {
          const extension = extensionFromDetail(JSON.parse(new TextDecoder().decode(detailBytes)));
          if (!extension) return null;
          const [manifestResponse, packageResponse] = await Promise.all([
            fetch(extension.manifestUrl, { signal: requestSignal }),
            fetch(extension.vsixUrl, { method: "HEAD", signal: requestSignal }),
          ]);
          if (!manifestResponse.ok) throw new Error("manifest unavailable");
          const packageLength = Number(packageResponse.headers.get("content-length"));
          if (
            packageResponse.ok &&
            Number.isFinite(packageLength) &&
            packageLength > MAX_VSIX_BYTES
          ) {
            return null;
          }
          const manifestBytes = await readCappedResponse(
            manifestResponse,
            MAX_MANIFEST_BYTES,
            "Open VSX returned an unexpectedly large manifest.",
          );
          const manifest = parseJsoncObject(
            new TextDecoder().decode(manifestBytes),
            "Extension manifest",
          );
          return themeContributions(manifest).length > 0 ? extension : null;
        } catch {
          throw new Error("Open VSX returned unreadable theme details.");
        }
      }, signal),
    ),
  );
  if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
  const completedDetails = details.filter((result) => result.status === "fulfilled");
  if (identities.length > 0 && completedDetails.length === 0) {
    throw new Error("Open VSX theme details are unavailable right now.");
  }
  return completedDetails.flatMap((result) => (result.value ? [result.value] : [])).slice(0, 8);
}

function parseJsoncObject(source: string, description: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value: unknown = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isRecord(value)) throw new Error(`${description} is not valid JSON.`);
  return value;
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
  compressedSize?: unknown;
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
  if (directoryEnd > endOffset || directoryEnd > bytes.byteLength) {
    throw new Error("That extension package has an invalid ZIP directory.");
  }

  let entryCount = 0;
  let offset = directoryOffset;
  while (offset < directoryEnd) {
    if (offset + 46 > directoryEnd || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("That extension package has an invalid ZIP directory.");
    }
    entryCount += 1;
    if (entryCount > MAX_ZIP_ENTRIES) {
      throw new Error("That extension package has too many files.");
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

  let totalUncompressed = 0;
  for (const entry of entries) {
    if (entry.unsafeOriginalName) normalizePackagePath(entry.unsafeOriginalName);
    if (entry.dir) continue;
    const compressed = entry._data?.compressedSize;
    const uncompressed = entry._data?.uncompressedSize;
    if (typeof compressed !== "number" || typeof uncompressed !== "number") {
      throw new Error("That extension package has unreadable file metadata.");
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

async function readCappedResponse(
  response: Response,
  limit: number,
  tooLargeMessage: string,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > limit) throw new Error(tooLargeMessage);
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) throw new Error(tooLargeMessage);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > limit) {
        await reader.cancel();
        throw new Error(tooLargeMessage);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function fetchPackage(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, signal ? { signal } : {});
  if (!response.ok) throw new Error("That Open VSX theme could not be downloaded.");
  return readCappedResponse(
    response,
    MAX_VSIX_BYTES,
    "That theme extension is too large to import safely.",
  );
}

export async function importOpenVsxThemeExtension(
  extension: OpenVsxThemeExtension,
  signal?: AbortSignal,
): Promise<ReadonlyArray<ThemeDefinition>> {
  const manifestResponse = await fetch(extension.manifestUrl, signal ? { signal } : {});
  if (!manifestResponse.ok) throw new Error("That Open VSX extension has no readable manifest.");
  const manifestBytes = await readCappedResponse(
    manifestResponse,
    MAX_MANIFEST_BYTES,
    "That Open VSX extension manifest is too large.",
  );
  const manifest = parseJsoncObject(new TextDecoder().decode(manifestBytes), "Extension manifest");
  const advertisedContributions = themeContributions(manifest);
  if (advertisedContributions.length === 0) {
    throw new Error("That extension does not contain color themes.");
  }
  if (advertisedContributions.length > MAX_THEMES_PER_EXTENSION) {
    throw new Error("That extension contains too many color themes to import safely.");
  }

  const packageBytes = await fetchPackage(extension.vsixUrl, signal);
  signal?.throwIfAborted();
  const checksumResponse = await fetch(extension.sha256Url, signal ? { signal } : {});
  if (!checksumResponse.ok) throw new Error("That Open VSX theme has no readable checksum.");
  const expectedChecksum = new TextDecoder()
    .decode(
      await readCappedResponse(
        checksumResponse,
        256,
        "That Open VSX checksum response is invalid.",
      ),
    )
    .trim()
    .split(/\s+/)[0];
  if (!expectedChecksum || !/^[a-f\d]{64}$/i.test(expectedChecksum)) {
    throw new Error("That Open VSX theme has an invalid checksum.");
  }
  signal?.throwIfAborted();
  const actualChecksum = [...sha256(packageBytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (actualChecksum.toLowerCase() !== expectedChecksum.toLowerCase()) {
    throw new Error("That Open VSX theme failed its integrity check.");
  }
  signal?.throwIfAborted();
  let zip: JSZip;
  try {
    const inspectedPackageBytes = inspectZipDirectory(packageBytes);
    zip = await JSZip.loadAsync(inspectedPackageBytes);
    signal?.throwIfAborted();
    inspectZip(zip);
  } catch (cause) {
    if (signal?.aborted) signal.throwIfAborted();
    if (cause instanceof Error && cause.message.startsWith("That extension package")) throw cause;
    throw new Error("That Open VSX extension package could not be opened.", { cause });
  }

  const packagedManifest = parseJsoncObject(
    await readZipText(zip, "extension/package.json", "Extension manifest", signal),
    "Extension manifest",
  );
  if (
    typeof packagedManifest.publisher !== "string" ||
    packagedManifest.publisher.toLowerCase() !== extension.publisher.toLowerCase() ||
    typeof packagedManifest.name !== "string" ||
    `${packagedManifest.publisher}.${packagedManifest.name}`.toLowerCase() !==
      extension.id.toLowerCase() ||
    packagedManifest.version !== extension.version
  ) {
    throw new Error("That extension package does not match the selected Open VSX theme.");
  }
  const contributions = themeContributions(packagedManifest);
  if (contributions.length === 0) throw new Error("That extension does not contain color themes.");
  if (contributions.length > MAX_THEMES_PER_EXTENSION) {
    throw new Error("That extension contains too many color themes to import safely.");
  }

  const parsed: Array<{ theme: ThemeDefinition; sourceName: string }> = [];
  const failures: string[] = [];
  const themeCache = new Map<string, Record<string, unknown>>();
  const themeBudget = { files: 0 };
  for (const contribution of contributions) {
    signal?.throwIfAborted();
    if (typeof contribution.path !== "string") continue;
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
          : extension.name;
      const decorated = {
        ...themeValue,
        displayName: label,
        ...(type ? { type } : {}),
      };
      if (!isVsCodeThemeFile(decorated)) throw new Error("not a VS Code color theme");
      parsed.push({ theme: parseVsCodeThemeFile(decorated), sourceName: path.split("/").at(-1)! });
    } catch (cause) {
      signal?.throwIfAborted();
      failures.push(cause instanceof Error ? cause.message : "theme could not be read");
    }
  }
  if (parsed.length === 0) {
    throw new Error(failures[0] ?? "That extension has no compatible color themes.");
  }
  const paired = pairVsCodeThemes(resolveThemeLabelCollisions(parsed));
  const themes = resolveThemeLabelCollisions(paired.map((theme) => ({ theme })));
  const collection = {
    id: `open-vsx:${extension.id.toLowerCase()}`,
    label: extension.name.slice(0, 48),
  };
  return themes.map((theme) => ({ ...theme, collection }));
}
