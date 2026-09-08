import * as Duration from "effect/Duration";
import * as Redacted from "effect/Redacted";
import { isResource } from "../Resource.ts";

/**
 * JSON marker used to tag a `Redacted<T>` value when writing state.
 * The reviver recognises objects with exactly this key and rebuilds
 * the `Redacted` wrapper on read.
 */
export const REDACTED_MARKER = "__redacted__";

/**
 * JSON marker used to tag a `Duration` value when writing state.
 * The reviver recognises objects with exactly this key and rebuilds
 * a real `Duration` instance on read so that downstream code can call
 * `Duration.toSeconds`, `Duration.toMillis`, etc. without first
 * decoding `Duration.toJSON`'s `{_id,_tag,...}` shape.
 */
export const DURATION_MARKER = "__duration__";

/**
 * JSON marker used to tag a `Date` value when writing state. The reviver
 * recognises objects with exactly this key and rebuilds a real `Date`
 * instance on read, so a Date-typed prop read back out of persisted state
 * (`olds` in provider `diff`/`delete`/`read`) is a `Date` again — not the
 * bare ISO string `JSON.stringify` would otherwise leave behind.
 */
export const DATE_MARKER = "__date__";

const decodeDate = (encoded: unknown): Date | undefined => {
  if (typeof encoded !== "string") return undefined;
  const date = new Date(encoded);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

/**
 * Rebuild a {@link Duration.Duration} from `Duration.toJSON`'s
 * `{_id,_tag,millis?,nanos?}` shape. Shared by state persistence and the
 * RPC sidecar — that JSON is not a valid `Duration.Input`.
 */
export const decodeDuration = (
  encoded: unknown,
): Duration.Duration | undefined => {
  if (encoded === null || typeof encoded !== "object") return undefined;
  const json = encoded as {
    _tag?: "Millis" | "Nanos" | "Infinity" | "NegativeInfinity";
    millis?: number;
    nanos?: string;
  };
  switch (json._tag) {
    case "Millis":
      return json.millis !== undefined
        ? Duration.millis(json.millis)
        : undefined;
    case "Nanos":
      return json.nanos !== undefined
        ? Duration.nanos(BigInt(json.nanos))
        : undefined;
    case "Infinity":
      return Duration.infinity;
    case "NegativeInfinity":
      return Duration.negativeInfinity;
    default:
      return undefined;
  }
};

/**
 * Recursively encode a state value for JSON serialisation.
 *
 * - `Redacted<T>` values are wrapped as `{ [REDACTED_MARKER]: <inner> }`
 *   so the actual string is persisted rather than the `<redacted>`
 *   placeholder produced by the default `toJSON`.
 * - `Resource` instances are flattened to `{ id, type, props, attr }`
 *   so persisted state matches the schema used by the loader.
 * - Plain objects and arrays are walked structurally.
 */
export const encodeState = (value: unknown): unknown => {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  if (Redacted.isRedacted(value)) {
    return {
      [REDACTED_MARKER]: encodeState(Redacted.value(value)),
    };
  }
  if (Duration.isDuration(value)) {
    // `JSON.stringify(Duration.seconds(N))` already invokes Duration.toJSON,
    // but encodeState is also called for code paths that don't go through
    // `JSON.stringify` (e.g. the HTTP state-store). Tag with our marker so
    // the reviver can unambiguously rebuild a real Duration instance —
    // Duration.toJSON's `{_id,_tag,...}` shape is NOT a valid Duration.Input.
    return {
      [DURATION_MARKER]: value.toJSON(),
    };
  }
  // Dates are serializable leaves and must round-trip: walking one
  // structurally would persist `{}` (`Object.entries(new Date())` is empty)
  // — and every later plan would then diff the empty object against the
  // program's Date and churn a phantom update forever. Tag with our marker
  // so the reviver rebuilds a real Date instance; rows written before the
  // marker carry a bare ISO string, which `canonicalize` in Diff.ts still
  // compares as equal to a live Date, so legacy rows never churn either.
  if (value instanceof Date) {
    return { [DATE_MARKER]: value.toJSON() };
  }
  if (isResource(value)) {
    return {
      id: value.LogicalId,
      type: value.Type,
      props: encodeState(value.Props),
      attr: encodeState(value.Attributes),
    };
  }
  if (Array.isArray(value)) return value.map(encodeState);
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = encodeState(v);
    }
    return result;
  }
  return value;
};

/**
 * JSON reviver that rebuilds `Redacted<T>` values that were written
 * through {@link encodeState}. Intended for use with `JSON.parse`.
 */
export const reviveState = (_key: string, value: unknown): unknown => {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (REDACTED_MARKER in obj) {
      return Redacted.make(obj[REDACTED_MARKER]);
    }
    if (DURATION_MARKER in obj) {
      const decoded = decodeDuration(obj[DURATION_MARKER]);
      if (decoded !== undefined) return decoded;
    }
    // Exact single-key match only — unlike the legacy REDACTED/DURATION
    // markers there is no pre-marker data to tolerate, so a user object
    // that merely CONTAINS the key alongside other fields is never
    // collapsed into a Date (mirrors reviveStateRecursive's strictness).
    if (DATE_MARKER in obj && Object.keys(obj).length === 1) {
      const decoded = decodeDate(obj[DATE_MARKER]);
      if (decoded !== undefined) return decoded;
    }
  }
  return value;
};

/**
 * Recursively walk an already-decoded value and rebuild `Redacted<T>`
 * instances from `{ [REDACTED_MARKER]: <inner> }` envelopes. Mirror
 * image of {@link encodeState} for callers that hold a parsed JS
 * value rather than a JSON string (e.g. the HTTP state-store client,
 * which receives values pre-parsed by `HttpApiClient`).
 */
export const reviveStateRecursive = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(reviveStateRecursive);
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1 && keys[0] === REDACTED_MARKER) {
    return Redacted.make(reviveStateRecursive(obj[REDACTED_MARKER]));
  }
  if (keys.length === 1 && keys[0] === DURATION_MARKER) {
    const decoded = decodeDuration(obj[DURATION_MARKER]);
    if (decoded !== undefined) return decoded;
  }
  if (keys.length === 1 && keys[0] === DATE_MARKER) {
    const decoded = decodeDate(obj[DATE_MARKER]);
    if (decoded !== undefined) return decoded;
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = reviveStateRecursive(v);
  }
  return result;
};
