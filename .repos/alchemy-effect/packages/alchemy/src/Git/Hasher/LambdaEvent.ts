/**
 * The hash event a {@link HasherFunction} answers (DESIGN §22.11): one pack
 * chunk, base64 in a JSON invoke payload (Lambda invokes are JSON; a 4 MiB
 * chunk encodes to ~5.6 MB, under the 6 MB payload limit), answered with
 * the encoded scan — bounded to the same limit by demoting the largest
 * delta-resolved entries back to `unresolved` (the receiver resolves those
 * itself from its retained bytes) and by omitting non-blob content (the
 * receiver inflates it).
 */
import * as Effect from "effect/Effect";
import {
  decodeScanResult,
  encodeScanResult,
  HashError,
  type HashPartOptions,
} from "./Hasher.ts";
import {
  scanPart,
  type ScanResult,
  type UnresolvedDelta,
} from "../Protocol/PartialScan.ts";

/** Chunk size the Lambda hasher asks the pump for (4 MiB → ~5.6 MB base64). */
export const LAMBDA_CHUNK_BYTES = 4 * 1024 * 1024;
/** Raw bytes the encoded scan may carry before demotion (base64 adds a third). */
export const RESPONSE_BUDGET_BYTES = 4 * 1024 * 1024;

export interface HashEvent {
  readonly alchemyGitHash: 1;
  readonly base: number;
  readonly remaining: number;
  readonly max: number;
  readonly resync: boolean;
  readonly skip: number;
  /** The chunk, base64. */
  readonly payload: string;
}

export type HashResponse =
  | { readonly scan: string }
  | { readonly error: string };

export const isHashEvent = (event: unknown): event is HashEvent =>
  typeof event === "object" &&
  event !== null &&
  (event as { alchemyGitHash?: unknown }).alchemyGitHash === 1 &&
  typeof (event as { payload?: unknown }).payload === "string";

export const encodeHashEvent = (
  payload: Uint8Array,
  options: HashPartOptions,
): HashEvent => ({
  alchemyGitHash: 1,
  base: options.base,
  remaining: options.remaining,
  max: options.maxObjectSize,
  resync: options.resync === true,
  skip: options.skip ?? 0,
  payload: toBase64(payload),
});

const toBase64 = (bytes: Uint8Array): string =>
  typeof Buffer !== "undefined"
    ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
        "base64",
      )
    : btoa(String.fromCharCode(...bytes));

export const fromBase64 = (text: string): Uint8Array =>
  typeof Buffer !== "undefined"
    ? new Uint8Array(Buffer.from(text, "base64"))
    : Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/**
 * Bounds a scan to `budget` raw bytes: strips non-blob content, then
 * demotes delta-resolved entries — largest first — to `unresolved` until
 * the fresh zdata fits. Every demoted entry keeps its base reference.
 */
export const boundScan = (scan: ScanResult, budget: number): ScanResult => {
  const entries = scan.entries.map((e) =>
    e.content === undefined ? e : { ...e, content: undefined },
  );
  let bytes = entries.length * 120;
  for (const e of entries) bytes += e.zdata?.byteLength ?? 0;
  if (bytes <= budget) {
    return { ...scan, entries };
  }
  const order = entries
    .map((e, i) => ({ i, z: e.zdata?.byteLength ?? 0 }))
    .filter((x) => x.z > 0)
    .sort((a, b) => b.z - a.z);
  const demoted = new Set<number>();
  const unresolved: Array<UnresolvedDelta> = [...scan.unresolved];
  for (const { i, z } of order) {
    if (bytes <= budget) break;
    const e = entries[i]!;
    demoted.add(i);
    bytes -= z;
    unresolved.push({
      offset: e.offset,
      dataOffset: e.dataOffset,
      span: e.span,
      baseOffset: e.baseOffset,
      baseOid: e.baseOid,
      size: e.size,
    });
  }
  return {
    ...scan,
    entries: entries.filter((_, i) => !demoted.has(i)),
    unresolved,
  };
};

/** Answers one hash event: scan, bound, encode. Pure — the Lambda's body. */
export const handleHashEvent = (
  event: HashEvent,
): Effect.Effect<HashResponse> =>
  Effect.gen(function* () {
    const payload = fromBase64(event.payload);
    const result = yield* scanPart(
      event.skip > 0 ? payload.subarray(event.skip) : payload,
      {
        base: event.base,
        remaining: event.remaining,
        maxObjectSize: event.max,
        resync: event.resync,
      },
    ).pipe(Effect.result);
    if (result._tag === "Failure") {
      const failure = result.failure;
      return {
        error: `${failure._tag}${"reason" in failure ? `: ${failure.reason}` : ""}`,
      };
    }
    return {
      scan: toBase64(
        encodeScanResult(boundScan(result.success, RESPONSE_BUDGET_BYTES)),
      ),
    };
  });

/** Decodes a response into the pump's scan result (or a typed error). */
export const decodeHashResponse = (
  response: HashResponse,
): Effect.Effect<ScanResult, HashError> =>
  "error" in response
    ? Effect.fail(new HashError({ reason: `lambda hasher: ${response.error}` }))
    : Effect.succeed(decodeScanResult(fromBase64(response.scan)));
