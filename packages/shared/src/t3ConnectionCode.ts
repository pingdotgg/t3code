import { TailcatConnectionCodePayload } from "@t3tools/contracts";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * T3-owned connection codes. A code is `t3c://<kind>/<base64url(JSON payload)>`.
 * The payload is versioned per kind; parsers reject unknown kinds and versions
 * rather than guessing. Codes are copyable text and QR content, so they are kept
 * URL-safe and free of characters that break on paste.
 */
const T3_CONNECTION_CODE_SCHEME = "t3c:";

export const T3ConnectionCodeKind = Schema.Literals(["tailcat"]);
export type T3ConnectionCodeKind = typeof T3ConnectionCodeKind.Type;

export class T3ConnectionCodeInvalidError extends Schema.TaggedError<T3ConnectionCodeInvalidError>()(
  "T3ConnectionCodeInvalidError",
  {
    reason: Schema.Literals([
      "not-a-code",
      "unknown-kind",
      "malformed-payload",
      "unsupported-version",
    ]),
    kind: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-a-code":
        return "This is not a T3 connection code. Paste the full code, starting with t3c://.";
      case "unknown-kind":
        return `This T3 connection code kind (${this.kind ?? "unknown"}) is not supported by this app.`;
      case "malformed-payload":
        return "This T3 connection code is incomplete or damaged. Copy it again from the other machine.";
      case "unsupported-version":
        return "This T3 connection code was made by a newer version of T3 Code. Update this app to use it.";
    }
  }
}

/**
 * What a pasted Tailcat code is, for live form feedback: nothing yet, not
 * readable (with guidance), or a decoded payload plus its expiry as epoch
 * milliseconds.
 */
export type TailcatConnectionCodePreview =
  | { readonly kind: "empty" }
  | { readonly kind: "invalid"; readonly message: string }
  | {
      readonly kind: "valid";
      readonly payload: TailcatConnectionCodePayload;
      readonly expiresAtMs: number;
    };

const isConnectionCodeInvalidError = Schema.is(T3ConnectionCodeInvalidError);

export function describeTailcatConnectionCode(raw: string): TailcatConnectionCodePreview {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { kind: "empty" };
  }
  if (!isT3ConnectionCode(trimmed)) {
    return {
      kind: "invalid",
      message: "Paste the full connection code. It starts with t3c://tailcat/.",
    };
  }
  try {
    const payload = decodeTailcatConnectionCode(trimmed);
    return { kind: "valid", payload, expiresAtMs: Date.parse(payload.expiresAt) };
  } catch (cause) {
    return {
      kind: "invalid",
      message: isConnectionCodeInvalidError(cause)
        ? cause.message
        : "This Tailcat connection code could not be read.",
    };
  }
}

const TailcatCodeJson = Schema.fromJsonString(TailcatConnectionCodePayload);
const encodeTailcatCodeJson = Schema.encodeSync(TailcatCodeJson);
const decodeTailcatCodeJson = Schema.decodeResult(TailcatCodeJson);
const isCodeKind = Schema.is(T3ConnectionCodeKind);

const VersionProbeJson = Schema.fromJsonString(Schema.Struct({ v: Schema.Unknown }));
const decodeVersionProbe = Schema.decodeResult(VersionProbeJson);

interface SplitCode {
  readonly kind: T3ConnectionCodeKind;
  readonly payloadJson: string;
}

function splitCode(raw: string): SplitCode {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith(T3_CONNECTION_CODE_SCHEME)) {
    throw new T3ConnectionCodeInvalidError({ reason: "not-a-code" });
  }
  const rest = trimmed.slice(T3_CONNECTION_CODE_SCHEME.length).replace(/^\/\//u, "");
  const slash = rest.indexOf("/");
  if (slash <= 0) {
    throw new T3ConnectionCodeInvalidError({ reason: "not-a-code" });
  }
  const kind = rest.slice(0, slash).toLowerCase();
  const encodedPayload = rest.slice(slash + 1).replace(/[\s/]+$/u, "");
  if (!isCodeKind(kind)) {
    throw new T3ConnectionCodeInvalidError({ reason: "unknown-kind", kind });
  }
  const decoded = Encoding.decodeBase64UrlString(encodedPayload);
  if (Result.isFailure(decoded)) {
    throw new T3ConnectionCodeInvalidError({
      reason: "malformed-payload",
      kind,
      cause: decoded.failure,
    });
  }
  return { kind, payloadJson: decoded.success };
}

function failVersionOrPayload(
  kind: T3ConnectionCodeKind,
  payloadJson: string,
  cause: unknown,
): never {
  const probe = decodeVersionProbe(payloadJson);
  if (Result.isSuccess(probe) && typeof probe.success.v === "number" && probe.success.v > 1) {
    throw new T3ConnectionCodeInvalidError({ reason: "unsupported-version", kind, cause });
  }
  throw new T3ConnectionCodeInvalidError({ reason: "malformed-payload", kind, cause });
}

export function isT3ConnectionCode(raw: string): boolean {
  return raw.trim().toLowerCase().startsWith(T3_CONNECTION_CODE_SCHEME);
}

/** Reads the code kind without validating the payload. Null for non-codes. */
export function peekT3ConnectionCodeKind(raw: string): T3ConnectionCodeKind | null {
  try {
    return splitCode(raw).kind;
  } catch {
    return null;
  }
}

export function encodeTailcatConnectionCode(payload: TailcatConnectionCodePayload): string {
  return `${T3_CONNECTION_CODE_SCHEME}//tailcat/${Encoding.encodeBase64Url(encodeTailcatCodeJson(payload))}`;
}

export function decodeTailcatConnectionCode(raw: string): TailcatConnectionCodePayload {
  const { kind, payloadJson } = splitCode(raw);
  const decoded = decodeTailcatCodeJson(payloadJson);
  if (Result.isFailure(decoded)) {
    return failVersionOrPayload(kind, payloadJson, decoded.failure);
  }
  return decoded.success;
}

/**
 * Connection codes carry a one-time pairing credential. Logs, diagnostics and
 * error messages must never include that part, so this renders a code with the
 * secret stripped and the middle elided.
 */
export function redactT3ConnectionCode(raw: string): string {
  const trimmed = raw.trim();
  if (!isT3ConnectionCode(trimmed)) {
    return "<not a t3 connection code>";
  }
  const kind = peekT3ConnectionCodeKind(trimmed) ?? "unknown";
  return `${T3_CONNECTION_CODE_SCHEME}//${kind}/…${trimmed.slice(-6)}`;
}
