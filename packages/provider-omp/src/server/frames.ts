import * as Schema from "effect/Schema";

export type OmpFrame = Record<string, unknown>;

const lineLimit = 1024 * 1024;
const chunkSize = 256 * 1024;
const frameLimit = 64 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
const decodeJson = Schema.decodeOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

export function encodeOmpRequest(frame: OmpFrame) {
  const json = JSON.stringify(frame);
  return Buffer.byteLength(json) < frameLimit ? Buffer.from(`${json}\n`) : undefined;
}

export function makeOmpFrameDecoder() {
  let pending:
    | { id: string; bytes: Buffer; offset: number; index: number; count: number }
    | undefined;
  return (line: string): OmpFrame | undefined => {
    if (Buffer.byteLength(line) >= lineLimit) throw new Error("Oh My Pi RPC line exceeds 1 MiB");
    const decoded = decodeJson(line);
    if (decoded._tag === "None") {
      if (pending) throw new Error("Oh My Pi RPC chunk sequence interrupted");
      return undefined;
    }
    const frame = decoded.value;
    if (frame.type !== "rpc_chunk") {
      if (pending) throw new Error("Oh My Pi RPC chunk sequence interrupted");
      return frame;
    }
    const { chunkId, index, count, byteLength, data } = frame;
    if (
      typeof chunkId !== "string" ||
      !chunkId ||
      chunkId.length > 128 ||
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      typeof count !== "number" ||
      !Number.isInteger(count) ||
      count < 2 ||
      count > frameLimit / chunkSize ||
      index >= count ||
      typeof byteLength !== "number" ||
      !Number.isInteger(byteLength) ||
      byteLength < lineLimit ||
      byteLength > frameLimit ||
      typeof data !== "string" ||
      !data ||
      data.length > Math.ceil(chunkSize / 3) * 4
    )
      throw new Error("Invalid Oh My Pi RPC chunk metadata");
    const bytes = Buffer.from(data, "base64");
    if (bytes.length === 0 || bytes.length > chunkSize || bytes.toString("base64") !== data) {
      throw new Error("Invalid Oh My Pi RPC chunk data");
    }
    if (!pending && index === 0) {
      pending = { id: chunkId, bytes: Buffer.allocUnsafe(byteLength), offset: 0, index: 0, count };
    }
    if (
      !pending ||
      pending.id !== chunkId ||
      pending.index !== index ||
      pending.count !== count ||
      pending.bytes.length !== byteLength ||
      pending.offset + bytes.length > byteLength
    ) {
      throw new Error("Invalid Oh My Pi RPC chunk sequence");
    }
    bytes.copy(pending.bytes, pending.offset);
    pending.offset += bytes.length;
    pending.index++;
    if (pending.index < count) return undefined;
    const complete = pending;
    pending = undefined;
    if (complete.offset !== byteLength) throw new Error("Incomplete Oh My Pi RPC frame");
    const result = decodeJson(decoder.decode(complete.bytes));
    if (result._tag === "None") throw new Error("Invalid Oh My Pi RPC frame");
    return result.value;
  };
}
