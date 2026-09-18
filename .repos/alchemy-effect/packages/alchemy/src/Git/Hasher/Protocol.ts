/**
 * The hasher wire protocol (DESIGN §22.7, §22.9) — the part of `Hasher.ts`
 * a hasher isolate needs and nothing more: no Cloudflare provider imports,
 * so a dynamic worker bundling it stays small.
 *
 * Request: the raw part bytes, coordinates in the query string. Response:
 * `u32 len | frame` repeated — the scan first (`encodeScanResult`: `u32
 * jsonLength | json | blob area`, entries referencing content/zdata as
 * `[offset, length]` into the blob area), then, when a spill was
 * requested, the uploaded part as JSON.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Oid, ObjectType } from "../Protocol/ObjectCodec.ts";
import type {
  DeltaBase,
  DeltaJob,
  DeltaResolved,
  EntryBounds,
  ScanResult,
} from "../Protocol/PartialScan.ts";

export class HashError extends Schema.TaggedError<HashError>()("HashError", {
  reason: Schema.String,
}) {}

export const encodeBoundsRequest = (
  payload: Uint8Array,
  bounds: ReadonlyArray<EntryBounds>,
): Uint8Array => {
  const json = new TextEncoder().encode(JSON.stringify(bounds));
  const out = new Uint8Array(4 + json.length + payload.length);
  new DataView(out.buffer).setUint32(0, json.length);
  out.set(json, 4);
  out.set(payload, 4 + json.length);
  return out;
};

export const decodeBoundsRequest = (
  body: Uint8Array,
): {
  readonly bounds: ReadonlyArray<EntryBounds>;
  readonly payload: Uint8Array;
} => {
  const jsonLength = new DataView(body.buffer, body.byteOffset).getUint32(0);
  const bounds = JSON.parse(
    new TextDecoder().decode(body.subarray(4, 4 + jsonLength)),
  ) as ReadonlyArray<EntryBounds>;
  return { bounds, payload: body.subarray(4 + jsonLength) };
};

/** The internal route the self-binding layer posts to. */
export const HASH_ROUTE = "/_alchemy/git/hash";

// ── protocol ────────────────────────────────────────────────────────────────

interface WireEntry {
  readonly o: string; // oid
  readonly t: number; // type
  readonly h: number; // header offset
  readonly s: number; // size
  readonly d: number; // dataOffset
  readonly n: number; // span
  readonly z?: [number, number]; // zdata [offset, length] in the blob area
  readonly c?: [number, number]; // content [offset, length]
  readonly b?: number; // baseOffset (delta-resolved)
  readonly r?: string; // baseOid (delta-resolved)
}
interface WireResult {
  readonly firstOffset: number;
  readonly entries: ReadonlyArray<WireEntry>;
  readonly unresolved: ScanResult["unresolved"];
  readonly consumedTo: number;
  readonly count: number;
}

export const encodeScanResult = (result: ScanResult): Uint8Array => {
  const blobs: Array<Uint8Array> = [];
  let at = 0;
  const put = (bytes: Uint8Array): [number, number] => {
    blobs.push(bytes);
    const ref: [number, number] = [at, bytes.length];
    at += bytes.length;
    return ref;
  };
  const wire: WireResult = {
    firstOffset: result.firstOffset,
    entries: result.entries.map((e) => ({
      o: e.oid,
      t: e.type,
      h: e.offset,
      s: e.size,
      d: e.dataOffset,
      n: e.span,
      ...(e.zdata === undefined ? {} : { z: put(e.zdata) }),
      ...(e.content === undefined ? {} : { c: put(e.content) }),
      ...(e.baseOffset === undefined ? {} : { b: e.baseOffset }),
      ...(e.baseOid === undefined ? {} : { r: e.baseOid }),
    })),
    unresolved: result.unresolved,
    consumedTo: result.consumedTo,
    count: result.count,
  };
  const json = new TextEncoder().encode(JSON.stringify(wire));
  const out = new Uint8Array(4 + json.length + at);
  new DataView(out.buffer).setUint32(0, json.length);
  out.set(json, 4);
  let cursor = 4 + json.length;
  for (const b of blobs) {
    out.set(b, cursor);
    cursor += b.length;
  }
  return out;
};

export const decodeScanResult = (bytes: Uint8Array): ScanResult => {
  const jsonLength = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
  const wire = JSON.parse(
    new TextDecoder().decode(bytes.subarray(4, 4 + jsonLength)),
  ) as WireResult;
  const blobs = bytes.subarray(4 + jsonLength);
  const slice = (ref: [number, number] | undefined) =>
    ref === undefined ? undefined : blobs.subarray(ref[0], ref[0] + ref[1]);
  return {
    firstOffset: wire.firstOffset,
    entries: wire.entries.map((e) => ({
      oid: e.o as Oid,
      type: e.t as ObjectType,
      offset: e.h,
      size: e.s,
      dataOffset: e.d,
      span: e.n,
      zdata: slice(e.z),
      content: slice(e.c),
      baseOffset: e.b,
      baseOid: e.r as Oid | undefined,
    })),
    unresolved: wire.unresolved,
    consumedTo: wire.consumedTo,
    count: wire.count,
  };
};

/**
 * Response framing of the hash route: `u32 len | frame` repeated — the
 * scan first, then (spill only) the uploaded part as JSON once its upload
 * has finished. The client acts on the scan without waiting for the part.
 */
export const frame = (bytes: Uint8Array): Uint8Array => {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
};

/** Reads length-prefixed frames off a response body, one at a time. */
export const makeFrameReader = (body: ReadableStream<Uint8Array>) => {
  const reader = body.getReader();
  const pending: Array<Uint8Array> = [];
  let pendingBytes = 0;
  const take = (n: number): Uint8Array => {
    const out = new Uint8Array(n);
    let written = 0;
    while (written < n) {
      const head = pending[0]!;
      const use = Math.min(head.length, n - written);
      out.set(head.subarray(0, use), written);
      written += use;
      if (use === head.length) pending.shift();
      else pending[0] = head.subarray(use);
    }
    pendingBytes -= n;
    return out;
  };
  const peekLength = (): number | undefined => {
    if (pendingBytes < 4) return undefined;
    const head = take(4);
    const len = new DataView(head.buffer).getUint32(0);
    pending.unshift(head);
    pendingBytes += 4;
    return len;
  };
  return (): Effect.Effect<Uint8Array | undefined, HashError> =>
    Effect.tryPromise({
      try: async () => {
        while (true) {
          const len = peekLength();
          if (len !== undefined && pendingBytes >= 4 + len) {
            take(4);
            return take(len);
          }
          const { value, done } = await reader.read();
          if (done) return undefined;
          pending.push(value);
          pendingBytes += value.length;
        }
      },
      catch: (error) =>
        new HashError({ reason: `hash part body: ${String(error)}` }),
    });
};

// ── delta batches (DESIGN §22.13) ──────────────────────────────────────────

/** `u32 jsonLen | json | blobs` with bases and deltas referenced as [offset, length]. */
export const encodeDeltaBatch = (
  bases: ReadonlyArray<DeltaBase>,
  jobs: ReadonlyArray<DeltaJob>,
): Uint8Array => {
  const blobs: Array<Uint8Array> = [];
  let at = 0;
  const put = (bytes: Uint8Array): [number, number] => {
    blobs.push(bytes);
    const ref: [number, number] = [at, bytes.length];
    at += bytes.length;
    return ref;
  };
  const wire = {
    bases: bases.map((b) => ({ r: put(b.bytes), c: b.isContent ? 1 : 0 })),
    jobs: jobs.map((j) => ({ i: j.id, t: j.type, b: j.base, d: put(j.delta) })),
  };
  const json = new TextEncoder().encode(JSON.stringify(wire));
  const out = new Uint8Array(4 + json.length + at);
  new DataView(out.buffer).setUint32(0, json.length);
  out.set(json, 4);
  let cursor = 4 + json.length;
  for (const b of blobs) {
    out.set(b, cursor);
    cursor += b.length;
  }
  return out;
};

export const decodeDeltaBatch = (
  bytes: Uint8Array,
): { readonly bases: Array<DeltaBase>; readonly jobs: Array<DeltaJob> } => {
  const jsonLength = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
  const wire = JSON.parse(
    new TextDecoder().decode(bytes.subarray(4, 4 + jsonLength)),
  ) as {
    bases: Array<{ r: [number, number]; c: number }>;
    jobs: Array<{ i: number; t: ObjectType; b: number; d: [number, number] }>;
  };
  const blobs = bytes.subarray(4 + jsonLength);
  const slice = (ref: [number, number]) =>
    blobs.subarray(ref[0], ref[0] + ref[1]);
  return {
    bases: wire.bases.map((b) => ({ bytes: slice(b.r), isContent: b.c === 1 })),
    jobs: wire.jobs.map((j) => ({
      id: j.i,
      type: j.t,
      base: j.b,
      delta: slice(j.d),
    })),
  };
};

export const encodeDeltaResults = (
  results: ReadonlyArray<DeltaResolved>,
): Uint8Array => {
  const blobs: Array<Uint8Array> = [];
  let at = 0;
  const put = (bytes: Uint8Array): [number, number] => {
    blobs.push(bytes);
    const ref: [number, number] = [at, bytes.length];
    at += bytes.length;
    return ref;
  };
  const wire = results.map((r) => ({
    i: r.id,
    o: r.oid,
    s: r.size,
    z: put(r.zdata),
    ...(r.content === undefined ? {} : { c: put(r.content) }),
  }));
  const json = new TextEncoder().encode(JSON.stringify(wire));
  const out = new Uint8Array(4 + json.length + at);
  new DataView(out.buffer).setUint32(0, json.length);
  out.set(json, 4);
  let cursor = 4 + json.length;
  for (const b of blobs) {
    out.set(b, cursor);
    cursor += b.length;
  }
  return out;
};

export const decodeDeltaResults = (bytes: Uint8Array): Array<DeltaResolved> => {
  const jsonLength = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
  const wire = JSON.parse(
    new TextDecoder().decode(bytes.subarray(4, 4 + jsonLength)),
  ) as Array<{
    i: number;
    o: string;
    s: number;
    z: [number, number];
    c?: [number, number];
  }>;
  const blobs = bytes.subarray(4 + jsonLength);
  const slice = (ref: [number, number]) =>
    blobs.subarray(ref[0], ref[0] + ref[1]);
  return wire.map((r) => ({
    id: r.i,
    oid: r.o as Oid,
    size: r.s,
    zdata: slice(r.z),
    content: r.c === undefined ? undefined : slice(r.c),
  }));
};
