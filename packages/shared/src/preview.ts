import type { BrowserSearchEngine } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { isLocalLoopbackHost } from "./hostClassification.ts";

const TAB_ID_PREFIX = "tab_";
let nextPreviewTabSequence = 0;

export function previewPdfAssetUrl(rawUrl: string, httpBaseUrl: string | null): string | null {
  if (httpBaseUrl === null) return null;
  try {
    const url = new URL(rawUrl);
    const baseUrl = new URL(httpBaseUrl);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !url.pathname.startsWith("/api/assets/") ||
      !/\.pdf$/i.test(url.pathname)
    ) {
      return null;
    }
    if (
      url.origin !== baseUrl.origin &&
      !isLocalLoopbackHost(url.hostname) &&
      url.hostname !== "0.0.0.0"
    ) {
      return url.href;
    }
    // The browser may run on the host's loopback address. Fetch signed bytes
    // through this client's environment connection, including remote routes.
    return new URL(`${url.pathname}${url.search}${url.hash}`, baseUrl).href;
  } catch {
    return null;
  }
}

export function newPreviewTabId(): string {
  nextPreviewTabSequence += 1;
  return `${TAB_ID_PREFIX}${nextPreviewTabSequence.toString(36)}`;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

export const LSOF_LOCAL_HOST_TOKENS: ReadonlySet<string> = new Set([
  ...LOOPBACK_HOSTS,
  "*",
  "[::]",
  "[::1]",
]);

const LOOPBACK_PREFIX_PATTERN = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::|\/|$)/i;

export function isLoopbackHost(host: string): boolean {
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (host === "[::1]") return true;
  return false;
}

export class PreviewUrlNormalizationError extends Schema.TaggedError<PreviewUrlNormalizationError>()(
  "PreviewUrlNormalizationError",
  {
    inputLength: Schema.Number,
    reason: Schema.Literals(["empty", "parse", "unsupported-protocol"]),
    protocol: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const protocol = this.protocol === undefined ? "" : `: ${this.protocol}`;
    return `Invalid preview URL (${this.reason}${protocol}; input length ${this.inputLength}).`;
  }
}

export const isPreviewUrlNormalizationError = Schema.is(PreviewUrlNormalizationError);

function previewUrlProtocol(rawUrl: string): string | undefined {
  return /^([A-Za-z][A-Za-z\d+.-]*):/.exec(rawUrl)?.[1]?.toLowerCase().concat(":");
}

const ADDRESS_HOST_PATTERN = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:.]+\])$/i;
const BARE_HOST_PORT_PATTERN = /^[^/?#:@]+:\d+(?:[/?#]|$)/;
const URL_SCHEME_WITH_AUTHORITY_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i;
const KNOWN_NON_WEB_SCHEMES: ReadonlySet<string> = new Set([
  "about:",
  "blob:",
  "chrome:",
  "data:",
  "file:",
  "ftp:",
  "javascript:",
  "mailto:",
  "sms:",
  "ssh:",
  "tel:",
  "view-source:",
  "ws:",
  "wss:",
]);

/** Address bar search URL templates; `%s` is replaced with the encoded query. */
const BROWSER_SEARCH_URL_TEMPLATES = {
  duckduckgo: "https://duckduckgo.com/?q=%s",
  google: "https://www.google.com/search?q=%s",
  bing: "https://www.bing.com/search?q=%s",
  brave: "https://search.brave.com/search?q=%s",
  kagi: "https://kagi.com/search?q=%s",
  ecosia: "https://www.ecosia.org/search?q=%s",
} satisfies Record<Exclude<BrowserSearchEngine, "custom">, string>;

function fillSearchUrlTemplate(template: string, query: string): string {
  return template.replaceAll("%s", encodeURIComponent(query));
}

/**
 * Whether a custom search URL is an http(s) URL with `%s` where the query goes.
 * `%s` in the host or credentials is rejected: the query would never reach a
 * search page, and a query with spaces would make the host unreachable.
 */
export function isValidSearchUrlTemplate(template: string): boolean {
  if (!template.includes("%s")) return false;
  try {
    // Two queries land on different authorities only when `%s` sits before the path.
    const authority = (url: URL) => `${url.username}:${url.password}@${url.host}`;
    const url = new URL(fillSearchUrlTemplate(template, "a"));
    const other = new URL(fillSearchUrlTemplate(template, "b"));
    return (
      (url.protocol === "http:" || url.protocol === "https:") && authority(url) === authority(other)
    );
  } catch {
    return false;
  }
}

/**
 * The search URL template for the chosen engine. An unusable custom template
 * falls back to DuckDuckGo so a query typed in the address bar always searches.
 */
export function resolveSearchUrlTemplate(settings: {
  readonly browserSearchEngine: BrowserSearchEngine;
  readonly browserCustomSearchUrl: string;
}): string {
  if (settings.browserSearchEngine !== "custom") {
    return BROWSER_SEARCH_URL_TEMPLATES[settings.browserSearchEngine];
  }
  const custom = settings.browserCustomSearchUrl.trim();
  return isValidSearchUrlTemplate(custom) ? custom : BROWSER_SEARCH_URL_TEMPLATES.duckduckgo;
}

export function resolveAddressBarInput(
  rawInput: string,
  searchUrlTemplate: string = BROWSER_SEARCH_URL_TEMPLATES.duckduckgo,
): string {
  const trimmed = rawInput.trim();
  if (URL_SCHEME_WITH_AUTHORITY_PATTERN.test(trimmed) || trimmed.length === 0)
    return normalizePreviewUrl(trimmed);
  if (!/\s/.test(trimmed)) {
    // Reject explicit schemes before URL normalization can misread mailto as bare-host credentials.
    const protocol = previewUrlProtocol(trimmed);
    if (
      protocol !== undefined &&
      (KNOWN_NON_WEB_SCHEMES.has(protocol) || !BARE_HOST_PORT_PATTERN.test(trimmed))
    ) {
      if (protocol !== "http:" && protocol !== "https:") {
        throw new PreviewUrlNormalizationError({
          inputLength: rawInput.length,
          reason: "unsupported-protocol",
          protocol,
        });
      }
      return normalizePreviewUrl(trimmed);
    }
    const authority = trimmed.split(/[/?#]/, 1)[0] ?? "";
    const host = authority.replace(/^[^@]*@/, "").replace(/:\d+$/, "");
    const hasPort = host.length < authority.replace(/^[^@]*@/, "").length;
    if (hasPort || ADDRESS_HOST_PATTERN.test(host) || /^[^.]+(?:\.[^.]+)+\.?$/.test(host)) {
      try {
        return normalizePreviewUrl(trimmed);
      } catch {}
    }
  }
  return fillSearchUrlTemplate(searchUrlTemplate, trimmed);
}

export function normalizePreviewUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    throw new PreviewUrlNormalizationError({ inputLength: rawUrl.length, reason: "empty" });
  }
  const useHttp = LOOPBACK_PREFIX_PATTERN.test(trimmed);
  const candidate = URL_SCHEME_WITH_AUTHORITY_PATTERN.test(trimmed)
    ? trimmed
    : `${useHttp ? "http" : "https"}://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch (cause) {
    throw new PreviewUrlNormalizationError({
      inputLength: rawUrl.length,
      reason: "parse",
      protocol: previewUrlProtocol(candidate),
      cause,
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new PreviewUrlNormalizationError({
      inputLength: rawUrl.length,
      reason: "unsupported-protocol",
      protocol: parsed.protocol,
    });
  }
  return parsed.href;
}
