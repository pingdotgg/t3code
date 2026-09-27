import { DelegationAuditEvidenceStatus } from "@t3tools/contracts";

const MAX_AUDIT_PAYLOAD_BYTES = 64 * 1024;
const REDACTED_VALUE = "[REDACTED]";
const SECRET_KEY =
  /(?:authorization|bearer|credential|password|passwd|secret|api[_-]?key|private[_-]?key)/iu;
const SECRET_TOKEN_KEY =
  /^(?:(?:access|refresh|auth|id|session|github|provider|client|bearer)_)?token(?:_(?:value|secret|credential))?$/u;
const INLINE_SECRET_PATTERNS = [
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/giu,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|credential|authorization)\b\s*[:=]\s*["']?[^,\s"';&]+/giu,
  /--(?:api-key|access-token|refresh-token|client-secret|password|passwd|secret|token)(?:=|\s+)[^\s]+/giu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
];

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
      result = result.replace(pattern, () => {
        redacted = true;
        return REDACTED_VALUE;
      });
    }
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
    return {
      payload: {
        preview: serialized.slice(0, MAX_AUDIT_PAYLOAD_BYTES),
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
