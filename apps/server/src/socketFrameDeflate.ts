// @effect-diagnostics nodeBuiltinImport:off -- zlib deflates 6-8x faster than a JS deflate on the event loop.
import * as NodeZlib from "node:zlib";

export const deflateSocketFrame = (frame: string): Uint8Array =>
  NodeZlib.deflateRawSync(frame, { level: 1 });
