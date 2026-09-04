import { FederationPeerCodePayload, TailcatConnectionCodePayload } from "@t3tools/contracts";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * T3-owned connection codes. A code is `t3c://<kind>/<base64url(JSON payload)>`.
 * The payload is versioned per kind; parsers reject unknown versions rather
 * than guessing. Codes are copyable text and QR content, so they are kept
 * URL-safe and free of characters that break on paste.
 */
export const T3_CONNECTION_CODE_SCHEME = "t3c:";

export const T3ConnectionCodeKind = Schema.Literals(["tailcat", "peer"]);
export type T3ConnectionCodeKind = typeof T3ConnectionCodeKind.Type;

export class T3ConnectionCodeInvalidError extends Schema.TaggedErrorClass<T3ConnectionCodeInvalidError>()(
  "T3ConnectionCodeInvalidError",
  {
    reason: Schema.Literals([
      "not-a-code",
      "unknown-kind",
      "malformed-payload",
      "unsupported-version",
      "kind-mismatch",
    ]),
    kind: Schema.optionalKey(Schema.String),
    /** For kind mismatches: the kind the code actually is. */
    actual: Schema.optionalKey(Schema.String),
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
      case "kind-mismatch":
        if (this.kind === "tailcat" && this.actual === "peer") {
          return "This is a federation peer code, not a Tailcat connection code. Add it under Settings → Connections → Federation → Add peer.";
        }
        if (this.kind === "peer" && this.actual === "tailcat") {
          return "This is a Tailcat connection code, not a federation peer code. Paste it under Add environment → Tailcat.";
        }
        return `This is a ${this.actual ?? "different kind of"} code, not a ${this.kind ?? "matching"} code.`;
    }
  }
}

type PayloadForKind<Kind extends T3ConnectionCodeKind> = Kind extends "tailcat"
  ? TailcatConnectionCodePayload
  : FederationPeerCodePayload;

/**
 * What a pasted code is, for live form feedback: nothing yet, not a code,
 * a code of another kind (with the guidance from the kind-mismatch error),
 * or a decoded payload plus its expiry as epoch milliseconds.
 */
export type T3ConnectionCodePreview<Kind extends T3ConnectionCodeKind> =
  | { readonly kind: "empty" }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "other-kind"; readonly actual: T3ConnectionCodeKind; readonly message: string }
  | {
      readonly kind: "valid";
      readonly payload: PayloadForKind<Kind>;
      readonly expiresAtMs: number | null;
    };

const isConnectionCodeInvalidError = Schema.is(T3ConnectionCodeInvalidError);

export function describeT3ConnectionCode<Kind extends T3ConnectionCodeKind>(
  raw: string,
  expected: Kind,
): T3ConnectionCodePreview<Kind> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { kind: "empty" };
  }
  if (!isT3ConnectionCode(trimmed)) {
    const noun = expected === "tailcat" ? "connection" : "peer";
    return {
      kind: "invalid",
      message: `Paste the full ${noun} code. It starts with t3c://${expected}/.`,
    };
  }
  const actual = peekT3ConnectionCodeKind(trimmed);
  if (actual !== null && actual !== expected) {
    return {
      kind: "other-kind",
      actual,
      message: new T3ConnectionCodeInvalidError({ reason: "kind-mismatch", kind: expected, actual })
        .message,
    };
  }
  try {
    const payload = (
      expected === "tailcat"
        ? decodeTailcatConnectionCode(trimmed)
        : decodeFederationPeerCode(trimmed)
    ) as PayloadForKind<Kind>;
    const expiresAt = payload.expiresAt;
    return {
      kind: "valid",
      payload,
      expiresAtMs: expiresAt === undefined ? null : Date.parse(expiresAt),
    };
  } catch (cause) {
    return {
      kind: "invalid",
      message: isConnectionCodeInvalidError(cause)
        ? cause.message
        : `This ${expected === "tailcat" ? "Tailcat connection" : "peer"} code could not be read.`,
    };
  }
}

const TailcatCodeJson = Schema.fromJsonString(TailcatConnectionCodePayload);
const PeerCodeJson = Schema.fromJsonString(FederationPeerCodePayload);
const encodeTailcatCodeJson = Schema.encodeSync(TailcatCodeJson);
const encodePeerCodeJson = Schema.encodeSync(PeerCodeJson);
const decodeTailcatCodeJson = Schema.decodeResult(TailcatCodeJson);
const decodePeerCodeJson = Schema.decodeResult(PeerCodeJson);
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
  if (kind !== "tailcat") {
    throw new T3ConnectionCodeInvalidError({
      reason: "kind-mismatch",
      kind: "tailcat",
      actual: kind,
    });
  }
  const decoded = decodeTailcatCodeJson(payloadJson);
  if (Result.isFailure(decoded)) {
    return failVersionOrPayload(kind, payloadJson, decoded.failure);
  }
  return decoded.success;
}

export function encodeFederationPeerCode(payload: FederationPeerCodePayload): string {
  return `${T3_CONNECTION_CODE_SCHEME}//peer/${Encoding.encodeBase64Url(encodePeerCodeJson(payload))}`;
}

export function decodeFederationPeerCode(raw: string): FederationPeerCodePayload {
  const { kind, payloadJson } = splitCode(raw);
  if (kind !== "peer") {
    throw new T3ConnectionCodeInvalidError({ reason: "kind-mismatch", kind: "peer", actual: kind });
  }
  const decoded = decodePeerCodeJson(payloadJson);
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
