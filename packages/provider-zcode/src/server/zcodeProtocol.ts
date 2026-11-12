// Shared wire-shape types and errors for the ZCode provider. The transport itself lives in
// `zcodeServeProtocol.ts` (channel frames over the daemon's WebSocket) and
// `zcodeServeConnection.ts` (daemon requests mapped onto this connection surface).
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as Queue from "effect/Queue";
import type * as Effect from "effect/Effect";

export class ZcodeProtocolError extends Schema.TaggedError<ZcodeProtocolError>()(
  "ZcodeProtocolError",
  {
    operation: Schema.String,
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `ZCode protocol ${this.operation} failed${this.detail === undefined ? "" : `: ${this.detail}`}.`;
  }
}

export class ZcodeProtocolTimeoutError extends Schema.TaggedError<ZcodeProtocolTimeoutError>()(
  "ZcodeProtocolTimeoutError",
  {
    operation: Schema.String,
    timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  },
) {
  override get message(): string {
    return `ZCode protocol ${this.operation} failed: timed out after ${this.timeoutMs}ms.`;
  }
}

export type ZcodeRecord = Record<string, unknown>;

export function zcodeRecordField(input: unknown, key: string): unknown {
  return Predicate.isObject(input) ? input[key] : undefined;
}

export function zcodeRecordString(input: unknown, key: string): string | undefined {
  const value = zcodeRecordField(input, key);
  return Predicate.isString(value) ? value : undefined;
}

export function zcodeRecordNumber(input: unknown, key: string): number | undefined {
  const value = zcodeRecordField(input, key);
  return Predicate.isNumber(value) && Number.isFinite(value) ? value : undefined;
}

export function zcodeRecordArray(input: unknown, key: string): ReadonlyArray<unknown> | undefined {
  const value = zcodeRecordField(input, key);
  return Array.isArray(value) ? value : undefined;
}

export const isServerRequest = (record: ZcodeRecord): boolean =>
  record["id"] !== undefined && Predicate.isString(record["method"]);

export interface ZcodeConnection {
  readonly request: (
    method: string,
    params: ZcodeRecord,
    timeoutMs?: number,
  ) => Effect.Effect<unknown, ZcodeProtocolError | ZcodeProtocolTimeoutError>;
  readonly respond: (
    id: string,
    result: unknown,
  ) => Effect.Effect<void, ZcodeProtocolError | ZcodeProtocolTimeoutError>;
  readonly events: Queue.Queue<ZcodeRecord, ZcodeProtocolError>;
  readonly exited: Effect.Effect<number, ZcodeProtocolError>;
  readonly terminate: Effect.Effect<void>;
}

const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const encodeJsonLine = Schema.encodeSync(UnknownFromJsonString);

/** JSON text for wire params/diagnostics; pure, so it may fall back to an empty string. */
export function zcodeJsonStringify(value: unknown): string {
  try {
    return encodeJsonLine(value);
  } catch {
    return "";
  }
}
