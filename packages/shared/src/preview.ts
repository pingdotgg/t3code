import * as Schema from "effect/Schema";

const TAB_ID_PREFIX = "tab_";
let nextPreviewTabSequence = 0;

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

const SEARCH_URL = "https://duckduckgo.com/?q=";
const ADDRESS_HOST_PATTERN = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:.]+\])$/i;
const BARE_HOST_PORT_PATTERN = /^[^/?#:@]+:\d+(?:[/?#]|$)/;
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

export function resolveAddressBarInput(rawInput: string): string {
  const trimmed = rawInput.trim();
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) || trimmed.length === 0)
    return normalizePreviewUrl(trimmed);
  if (!/\s/.test(trimmed)) {
    // `mailto:x` or `data:...` is an explicit scheme; `example.com:8080` or
    // `devbox:8080` is a bare host and port. `normalizePreviewUrl` would read
    // `mailto:alice@example.com` as credentials on a bare host, so reject here.
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
  return `${SEARCH_URL}${encodeURIComponent(trimmed)}`;
}

export function normalizePreviewUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    throw new PreviewUrlNormalizationError({ inputLength: rawUrl.length, reason: "empty" });
  }
  const useHttp = LOOPBACK_PREFIX_PATTERN.test(trimmed);
  const candidate = trimmed.includes("://")
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
