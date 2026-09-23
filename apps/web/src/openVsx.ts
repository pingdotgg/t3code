const OPEN_VSX_SEARCH_URL = "https://open-vsx.org/api/-/search";
const MAX_SEARCH_BYTES = 512 * 1024;
const SEARCH_REQUEST_TIMEOUT_MS = 10_000;

export type OpenVsxSort = "downloadCount" | "rating" | "timestamp" | "relevance";

export type OpenVsxSearchOptions = {
  signal?: AbortSignal | undefined;
  sortBy?: OpenVsxSort;
};

export type OpenVsxExtensionSummary = {
  id: string;
  namespace: string;
  name: string;
  displayName: string;
  description: string;
  downloadCount: number;
  iconUrl: string | null;
  version: string;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function trustedOpenVsxUrl(value: unknown): string | null {
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

export function publicSourceUrl(value: unknown): string | null {
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

export async function withSearchTimeout<T>(
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

export async function readCappedResponse(
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

export async function searchOpenVsx(
  query: string,
  {
    signal,
    sortBy = "downloadCount",
    category,
    size,
  }: OpenVsxSearchOptions & { category?: string; size: number },
): Promise<ReadonlyArray<Record<string, unknown>>> {
  const url = new URL(OPEN_VSX_SEARCH_URL);
  url.searchParams.set("query", query);
  if (category) url.searchParams.set("category", category);
  url.searchParams.set("sortBy", sortBy);
  url.searchParams.set("sortOrder", "desc");
  url.searchParams.set("size", String(size));
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
  return value.extensions.filter(isRecord);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function searchOpenVsxExtensions(
  query: string,
  options: OpenVsxSearchOptions = {},
): Promise<OpenVsxExtensionSummary[]> {
  const searchText = query.trim();
  if (!searchText) return [];
  const entries = await searchOpenVsx(searchText, { ...options, size: 20 });
  return entries.flatMap((entry) => {
    const namespace = stringField(entry.namespace);
    const name = stringField(entry.name);
    const version = stringField(entry.version);
    if (!namespace || !name || !version) return [];
    return [
      {
        id: `${namespace}.${name}`,
        namespace,
        name,
        displayName: stringField(entry.displayName) || name,
        description: stringField(entry.description),
        downloadCount:
          typeof entry.downloadCount === "number" && Number.isFinite(entry.downloadCount)
            ? entry.downloadCount
            : 0,
        iconUrl: isRecord(entry.files) ? trustedOpenVsxUrl(entry.files.icon) : null,
        version,
      },
    ];
  });
}

export async function openVsxExtensionExists(namespace: string, name: string): Promise<boolean> {
  const url = `https://open-vsx.org/api/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
  const response = await withSearchTimeout((signal) => fetch(url, { method: "HEAD", signal }));
  if (response.status === 404) return false;
  if (!response.ok) throw new Error("Open VSX is unavailable right now.");
  return true;
}
