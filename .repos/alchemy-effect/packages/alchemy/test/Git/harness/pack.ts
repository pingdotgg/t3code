/**
 * Parses an upload-pack result (pkt-line NAK/ACK head, then the pack either
 * raw or in band-1 sideband frames) and verifies the pack: `PACK` magic,
 * version 2, and the trailing SHA-1 over everything before it. Shared by
 * the bench and the unit tests so "bytes received" never stands in for
 * "a whole pack" (DESIGN §22.4).
 */
import { makeSha1 } from "@/Git/Protocol/ObjectCodec.ts";

export const verifyPackResponse = (
  raw: Uint8Array,
  sideband: boolean,
): { readonly objects: number; readonly error?: string } => {
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  let pos = 0;
  const pieces: Array<Uint8Array> = [];
  for (;;) {
    if (pos + 4 > raw.length) break;
    const four = text(raw.subarray(pos, pos + 4));
    if (four === "PACK" && !sideband) break; // raw mode: the pack starts here
    const len = Number.parseInt(four, 16);
    if (Number.isNaN(len))
      return { objects: 0, error: `bad pkt length at ${pos}` };
    if (len === 0) {
      pos += 4;
      if (sideband) break; // trailing flush after the last frame
      continue;
    }
    const payload = raw.subarray(pos + 4, pos + len);
    pos += len;
    if (sideband) {
      if (payload[0] === 1) pieces.push(payload.subarray(1));
      continue; // band 2/3 progress, or a NAK/ACK line before framing
    }
    const line = text(payload);
    if (line.startsWith("NAK") || line.startsWith("ACK")) continue;
    return {
      objects: 0,
      error: `unexpected pkt-line before pack: ${line.slice(0, 40)}`,
    };
  }
  if (!sideband) pieces.push(raw.subarray(pos));
  return verifyPack(concat(pieces));
};

/** Verifies a bare pack: magic, version, count, SHA-1 trailer. */
export const verifyPack = (
  pack: Uint8Array,
): { readonly objects: number; readonly error?: string } => {
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  if (pack.length < 32)
    return { objects: 0, error: `pack too short (${pack.length} bytes)` };
  if (text(pack.subarray(0, 4)) !== "PACK")
    return { objects: 0, error: "missing PACK magic" };
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  if (view.getUint32(4) !== 2)
    return { objects: 0, error: `pack version ${view.getUint32(4)}` };
  const objects = view.getUint32(8);
  const hash = makeSha1();
  hash.update(pack.subarray(0, pack.length - 20));
  const digest = hash.digest();
  const trailer = pack.subarray(pack.length - 20);
  for (let i = 0; i < 20; i++) {
    if (digest[i] !== trailer[i]) {
      return {
        objects,
        error: `trailer SHA-1 mismatch (${pack.length} bytes, ${objects} objects)`,
      };
    }
  }
  return { objects };
};

export const concat = (pieces: ReadonlyArray<Uint8Array>): Uint8Array => {
  if (pieces.length === 1) return pieces[0]!;
  const total = pieces.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of pieces) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
