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
const MAX_THEME_BYTES = 256 * 1024;
const MAX_ZIP_ENTRIES = 2_000;
const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;
const MAX_THEMES_PER_EXTENSION = 40;
const MAX_INCLUDE_DEPTH = 8;
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

function extensionFromDetail(value: unknown): OpenVsxThemeExtension | null {
  if (!isRecord(value) || !isRecord(value.files)) return null;
  const namespace = typeof value.namespace === "string" ? value.namespace.trim() : "";
  const extensionName = typeof value.name === "string" ? value.name.trim() : "";
  const displayName = typeof value.displayName === "string" ? value.displayName.trim() : "";
  const version = typeof value.version === "string" ? value.version.trim() : "";
  const license = typeof value.license === "string" ? value.license.trim() : "";
  const manifestUrl = trustedOpenVsxUrl(value.files.manifest);
  const sha256Url = trustedOpenVsxUrl(value.files.sha256);
  const vsixUrl = trustedOpenVsxUrl(value.files.download);
  if (
    !namespace ||
    !extensionName ||
    !displayName ||
    !version ||
    !SUPPORTED_LICENSES.has(license) ||
    !manifestUrl ||
    !sha256Url ||
    !vsixUrl
  ) {
    return null;
  }
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
  const response = await fetch(url, signal ? { signal } : {});
  if (!response.ok) throw new Error("Open VSX search is unavailable right now.");
  const searchBytes = await readCappedResponse(
    response,
    MAX_SEARCH_BYTES,
    "Open VSX returned an unexpectedly large response.",
  );
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(searchBytes));
  } catch {
    throw new Error("Open VSX returned an unreadable response.");
  }
  const candidates = isRecord(value) && Array.isArray(value.extensions) ? value.extensions : [];
  const identities = candidates.flatMap((candidate): Array<[string, string]> => {
    if (!isRecord(candidate)) return [];
    const namespace = typeof candidate.namespace === "string" ? candidate.namespace : "";
    const name = typeof candidate.name === "string" ? candidate.name : "";
    return namespace && name ? [[namespace, name]] : [];
  });
  const details = await Promise.allSettled(
    identities.slice(0, 16).map(async ([namespace, name]) => {
      const detailUrl = `https://open-vsx.org/api/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
      const detailResponse = await fetch(detailUrl, signal ? { signal } : {});
      if (!detailResponse.ok) throw new Error("Open VSX theme details are unavailable.");
      const detailBytes = await readCappedResponse(
        detailResponse,
        MAX_DETAIL_BYTES,
        "Open VSX returned an unexpectedly large detail response.",
      );
      try {
        return extensionFromDetail(JSON.parse(new TextDecoder().decode(detailBytes)));
      } catch {
        return null;
      }
    }),
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

function normalizePackagePath(path: string, relativeTo = "extension/"): string {
  if (path.includes("\0") || path.startsWith("/") || /^[a-zA-Z]:/.test(path)) {
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

async function readZipText(zip: JSZip, path: string, description: string): Promise<string> {
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
    stream
      .on("data", (chunk) => {
        if (settled) return;
        byteLength += chunk.byteLength;
        if (byteLength > MAX_THEME_BYTES) {
          settled = true;
          stream.pause();
          reject(new Error(`${description} is too large.`));
          return;
        }
        chunks.push(chunk);
      })
      .on("error", (cause) => {
        if (settled) return;
        settled = true;
        reject(cause);
      })
      .on("end", () => {
        if (settled) return;
        settled = true;
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
  ancestors: ReadonlySet<string> = new Set(),
): Promise<Record<string, unknown>> {
  if (ancestors.size >= MAX_INCLUDE_DEPTH) throw new Error("Theme includes are nested too deeply.");
  if (ancestors.has(path)) throw new Error("Theme includes contain a cycle.");
  const cached = cache.get(path);
  if (cached) return cached;

  const value = parseJsoncObject(await readZipText(zip, path, path), path);
  if (typeof value.include !== "string") {
    cache.set(path, value);
    return value;
  }

  const includePath = normalizePackagePath(value.include, path);
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(path);
  const base = await loadThemeObject(zip, includePath, cache, nextAncestors);
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
  const contributes = isRecord(manifest.contributes) ? manifest.contributes : null;
  const contributions = Array.isArray(contributes?.themes)
    ? contributes.themes.filter(isRecord)
    : [];
  if (contributions.length === 0) throw new Error("That extension does not contain color themes.");
  if (contributions.length > MAX_THEMES_PER_EXTENSION) {
    throw new Error("That extension contains too many color themes to import safely.");
  }

  const packageBytes = await fetchPackage(extension.vsixUrl, signal);
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
  const actualChecksum = [...sha256(packageBytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (actualChecksum.toLowerCase() !== expectedChecksum.toLowerCase()) {
    throw new Error("That Open VSX theme failed its integrity check.");
  }
  let zip: JSZip;
  try {
    const inspectedPackageBytes = inspectZipDirectory(packageBytes);
    zip = await JSZip.loadAsync(inspectedPackageBytes);
    inspectZip(zip);
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("That extension package")) throw cause;
    throw new Error("That Open VSX extension package could not be opened.", { cause });
  }

  const parsed: Array<{ theme: ThemeDefinition; sourceName: string }> = [];
  const failures: string[] = [];
  const themeCache = new Map<string, Record<string, unknown>>();
  for (const contribution of contributions as ThemeContribution[]) {
    if (typeof contribution.path !== "string") continue;
    try {
      const path = normalizePackagePath(contribution.path);
      const themeValue = await loadThemeObject(zip, path, themeCache);
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
      failures.push(cause instanceof Error ? cause.message : "theme could not be read");
    }
  }
  if (parsed.length === 0) {
    throw new Error(failures[0] ?? "That extension has no compatible color themes.");
  }
  const paired = pairVsCodeThemes(resolveThemeLabelCollisions(parsed));
  return resolveThemeLabelCollisions(paired.map((theme) => ({ theme })));
}
