import { DelegationAuditEvidenceStatus } from "@t3tools/contracts";

const MAX_AUDIT_PAYLOAD_BYTES = 64 * 1024;
const REDACTED_VALUE = "[REDACTED]";
const SECRET_KEY =
  /(?:authorization|bearer|credential|password|passwd|secret|api[_-]?key|private[_-]?key)/iu;
const SECRET_TOKEN_KEY =
  /^(?:(?:access|refresh|auth|id|session|github|provider|client|bearer)_)?token(?:_(?:value|secret|credential))?$/u;
const SECRET_ASSIGNMENT_PATTERN =
  /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|credential|authorization)\b(?:\\*["'])?\s*[:=]\s*)(\\*["']?)((?:\\(?!["'])|[^,\s"';&\\])+)(\\*["']?)/giu;
const COOKIE_HEADER_PATTERN = /(\b(?:set-cookie|cookie)\s*:\s*)([^"'\r\n`]+)/giu;
const COOKIE_PAIR_PATTERN =
  /(^|[;,\s]+)([A-Za-z0-9_.-]+)(=)(?:"([^"]*)"|'([^']*)'|([^\s;,"']+))/giu;
const SECRET_COOKIE_NAME = /(?:session|auth|token|csrf|xsrf|sid|secret|credential|api[_-]?key)/iu;
const URL_USERINFO_PATTERN = /\b(https?:\/\/)[^/\s@]+@/giu;
const GIT_HTTP_EXTRAHEADER_PATTERN = /(\bhttp\.extraheader(?:=|\s+))[\s\S]*$/giu;
const INLINE_SECRET_PATTERNS = [
  URL_USERINFO_PATTERN,
  GIT_HTTP_EXTRAHEADER_PATTERN,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/giu,
  SECRET_ASSIGNMENT_PATTERN,
  /--(?:api-key|access-token|refresh-token|client-secret|password|passwd|secret|token)(?:=|\s+)[^\s]+/giu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
];

function redactCookieCredentials(value: string): {
  readonly value: string;
  readonly redacted: boolean;
} {
  let redacted = false;
  const result = value.replace(COOKIE_HEADER_PATTERN, (header, prefix: string, cookies: string) => {
    COOKIE_PAIR_PATTERN.lastIndex = 0;
    const safeCookies = cookies.replace(
      COOKIE_PAIR_PATTERN,
      (
        pair,
        separator: string,
        name: string,
        assignment: string,
        doubleQuoted: string | undefined,
        singleQuoted: string | undefined,
      ) => {
        if (!SECRET_COOKIE_NAME.test(name)) return pair;
        redacted = true;
        const quote = doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : "";
        return `${separator}${name}${assignment}${quote}${REDACTED_VALUE}${quote}`;
      },
    );
    return `${prefix}${safeCookies}`;
  });
  return { value: result, redacted };
}

interface RedactedValue {
  readonly value: unknown;
  readonly redacted: boolean;
}

function redactValue(value: unknown, parentKey?: string): RedactedValue {
  if (parentKey !== undefined) {
    const normalizedKey = parentKey.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
    if (SECRET_KEY.test(normalizedKey) || SECRET_TOKEN_KEY.test(normalizedKey)) {
      return { value: REDACTED_VALUE, redacted: true };
    }
  }
  if (typeof value === "string") {
    let result = value;
    let redacted = false;
    for (const pattern of INLINE_SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      result = result.replace(pattern, (...matches: Array<string | number | undefined>) => {
        redacted = true;
        if (pattern === URL_USERINFO_PATTERN) {
          return `${matches[1] ?? ""}[REDACTED]@`;
        }
        if (pattern === GIT_HTTP_EXTRAHEADER_PATTERN) {
          return `${matches[1] ?? ""}${REDACTED_VALUE}`;
        }
        if (pattern === SECRET_ASSIGNMENT_PATTERN) {
          return `${matches[1] ?? ""}${matches[2] ?? ""}${REDACTED_VALUE}${matches[4] ?? ""}`;
        }
        return REDACTED_VALUE;
      });
    }
    const safeCookies = redactCookieCredentials(result);
    result = safeCookies.value;
    redacted ||= safeCookies.redacted;
    return { value: result, redacted };
  }
  if (Array.isArray(value)) {
    let redacted = false;
    const items = value.map((item) => {
      const next = redactValue(item);
      redacted ||= next.redacted;
      return next.value;
    });
    return { value: items, redacted };
  }
  if (value !== null && typeof value === "object") {
    let redacted = false;
    const entries = Object.entries(value).map(([key, entry]) => {
      const next = redactValue(entry, key);
      redacted ||= next.redacted;
      return [key, next.value] as const;
    });
    return { value: Object.fromEntries(entries), redacted };
  }
  return { value, redacted: false };
}

export function redactSensitiveValues(value: unknown): {
  readonly payload: unknown;
  readonly redacted: boolean;
} {
  const result = redactValue(value);
  return { payload: result.value, redacted: result.redacted };
}

export function redactAuditPayload(value: unknown): {
  readonly payload: unknown;
  readonly evidenceStatus: typeof DelegationAuditEvidenceStatus.Type;
  readonly redacted: boolean;
} {
  const redactedValue = redactSensitiveValues(value);
  const serialized = JSON.stringify(redactedValue.payload);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_AUDIT_PAYLOAD_BYTES) {
    let previewBytes = 0;
    let previewEnd = 0;
    for (const character of serialized) {
      const characterBytes = Buffer.byteLength(character, "utf8");
      if (previewBytes + characterBytes > MAX_AUDIT_PAYLOAD_BYTES) break;
      previewBytes += characterBytes;
      previewEnd += character.length;
    }
    return {
      payload: {
        preview: serialized.slice(0, previewEnd),
        originalBytes: bytes,
        truncated: true,
      },
      evidenceStatus: "truncated",
      redacted: redactedValue.redacted,
    };
  }

  return {
    payload: redactedValue.payload,
    evidenceStatus: redactedValue.redacted ? "redacted" : "complete",
    redacted: redactedValue.redacted,
  };
}

export function redactAuditText(value: string): string {
  const { payload } = redactAuditPayload(value);
  if (typeof payload === "string") return payload;
  if (
    payload !== null &&
    typeof payload === "object" &&
    "preview" in payload &&
    typeof payload.preview === "string"
  ) {
    return payload.preview;
  }
  throw new Error("Audit text redaction returned a non-text payload.");
}
