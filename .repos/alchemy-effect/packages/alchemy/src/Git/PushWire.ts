/**
 * The Worker ↔ Repo DO push protocol (DESIGN §22.10): the pack never
 * enters the Durable Object. The Worker receives the body, spills it,
 * verifies it through the hasher fan-out, and ships the DO only *rows* —
 * staged-object batches (promoted rows are coordinates into the wire
 * pack, inline rows carry their zlib bytes) — plus the commit summary.
 *
 * Batches cross the RPC boundary as one binary buffer:
 * `u32 jsonLen | json | zdata…` where the JSON array lists each row's
 * metadata and the byte length of its zdata run, in order.
 */
import type { StagedObject } from "./Store/ObjectStore.ts";
import type { ObjectType } from "./Protocol/ObjectCodec.ts";

interface RowMeta {
  /** oid */
  readonly o: string;
  /** type */
  readonly t: ObjectType;
  /** size (inflated) */
  readonly s: number;
  /** zdata length in the blob section */
  readonly n: number;
  /** zsize (promoted rows: the span in the pack) */
  readonly z?: number | undefined;
  /** pack coordinates (promoted rows) */
  readonly p?: { readonly i: string; readonly f: number } | undefined;
}

/** Encodes staged rows for one `stagePush` call. */
export const encodeStagedBatch = (
  objects: ReadonlyArray<StagedObject>,
): Uint8Array => {
  const meta: Array<RowMeta> = [];
  let blobBytes = 0;
  for (const object of objects) {
    meta.push({
      o: object.oid,
      t: object.type,
      s: object.size,
      n: object.zdata.byteLength,
      z: object.zsize,
      p:
        object.pack === undefined
          ? undefined
          : { i: object.pack.packId, f: object.pack.offset },
    });
    blobBytes += object.zdata.byteLength;
  }
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const out = new Uint8Array(4 + json.length + blobBytes);
  new DataView(out.buffer).setUint32(0, json.length);
  out.set(json, 4);
  let at = 4 + json.length;
  for (const object of objects) {
    out.set(object.zdata, at);
    at += object.zdata.byteLength;
  }
  return out;
};

/** Decodes a `stagePush` batch back into staged rows (views into `bytes`). */
export const decodeStagedBatch = (
  bytes: Uint8Array,
): ReadonlyArray<StagedObject> => {
  const jsonLen = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(0);
  const meta = JSON.parse(
    new TextDecoder().decode(bytes.subarray(4, 4 + jsonLen)),
  ) as ReadonlyArray<RowMeta>;
  const out: Array<StagedObject> = [];
  let at = 4 + jsonLen;
  for (const row of meta) {
    const zdata = bytes.subarray(at, at + row.n);
    at += row.n;
    out.push({
      oid: row.o,
      type: row.t,
      size: row.s,
      zdata,
      zsize: row.z,
      pack:
        row.p === undefined ? undefined : { packId: row.p.i, offset: row.p.f },
    });
  }
  return out;
};
