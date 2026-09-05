import { sha256 } from "@noble/hashes/sha2";

import type { ThemeDefinition } from "./themePalette";
import {
  isRecord,
  MAX_THEMES_PER_EXTENSION,
  MAX_VSIX_BYTES,
  openThemePackage,
  parseJsoncObject,
  readPackagedManifest,
  shortHash,
  themeContributions,
  themesFromPackage,
  type ThemePackageIdentity,
} from "./vsixThemePackage";

const OPEN_VSX_SEARCH_URL = "https://open-vsx.org/api/-/search";
const MAX_SEARCH_BYTES = 512 * 1024;
const MAX_DETAIL_BYTES = 256 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const SEARCH_REQUEST_TIMEOUT_MS = 10_000;
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

export type OpenVsxThemeSort = "downloadCount" | "rating" | "timestamp" | "relevance";

export type OpenVsxThemeExtension = {
  id: string;
  collectionId: string;
  name: string;
  publisher: string;
  description: string;
  downloadCount: number;
  iconUrl: string | null;
  sourceUrl: string | null;
  manifestUrl: string;
  sha256Url: string;
  vsixUrl: string;
  version: string;
  license: string;
};

export type OpenVsxThemeSearchOptions = {
  signal?: AbortSignal;
  sortBy?: OpenVsxThemeSort;
};

function openVsxCollectionId(extensionId: string): string {
  const normalized = `open-vsx:${extensionId.toLowerCase()}`;
  return /^[a-z0-9][a-z0-9.:-]{0,127}$/.test(normalized)
    ? normalized
    : `open-vsx:${shortHash(extensionId)}`;
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

function publicSourceUrl(value: unknown): string | null {
  const rawValue =
    typeof value === "string"
      ? value
      : isRecord(value) && typeof value.url === "string"
        ? value.url
        : null;
  if (!rawValue) return null;
  try {
    const url = new URL(rawValue);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function manifestLicenseMatches(manifest: Record<string, unknown>, license: string): boolean {
  return (
    typeof manifest.license === "string" &&
    manifest.license.trim().toLowerCase() === license.toLowerCase()
  );
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
  const id = `${namespace}.${extensionName}`;
  return {
    id,
    collectionId: openVsxCollectionId(id),
    name: displayName,
    publisher: namespace,
    description: typeof value.description === "string" ? value.description : "",
    downloadCount:
      typeof value.downloadCount === "number" && Number.isFinite(value.downloadCount)
        ? value.downloadCount
        : 0,
    iconUrl: trustedOpenVsxUrl(value.files.icon),
    sourceUrl:
      publicSourceUrl(value.repository) ??
      publicSourceUrl(value.homepage) ??
      publicSourceUrl(value.url),
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
  { signal, sortBy = "downloadCount" }: OpenVsxThemeSearchOptions = {},
): Promise<OpenVsxThemeExtension[]> {
  const searchText = query.trim();
  if (!searchText) return [];
  const url = new URL(OPEN_VSX_SEARCH_URL);
  url.searchParams.set("query", searchText);
  url.searchParams.set("category", "Themes");
  url.searchParams.set("sortBy", sortBy);
  url.searchParams.set("sortOrder", "desc");
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
  if (!isRecord(value) || !Array.isArray(value.extensions)) {
    throw new Error("Open VSX returned an unreadable search response.");
  }
  const identities = value.extensions.flatMap((candidate): Array<[string, string]> => {
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
          if (!packageResponse.ok) return null;
          const packageLength = Number(packageResponse.headers.get("content-length"));
          if (Number.isFinite(packageLength) && packageLength > MAX_VSIX_BYTES) {
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
          return themeContributions(manifest).length > 0 &&
            manifestLicenseMatches(manifest, extension.license)
            ? extension
            : null;
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
  const zip = await openThemePackage(packageBytes, signal);

  const packagedManifest = await readPackagedManifest(zip, signal);
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
  if (!manifestLicenseMatches(packagedManifest, extension.license)) {
    throw new Error("That extension package does not match its advertised license.");
  }

  const identity: ThemePackageIdentity = {
    idPrefix: "ovx-theme",
    key: extension.id.toLowerCase(),
    name: extension.name,
    collection: { id: extension.collectionId, label: extension.name.slice(0, 48) },
  };
  return themesFromPackage(zip, packagedManifest, identity, signal);
}
