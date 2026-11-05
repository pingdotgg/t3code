import * as NodeZlib from "node:zlib";
import { DEFLATED_RPC_FRAMES_QUERY_PARAM } from "@t3tools/contracts";
import { RpcSerialization } from "effect/rpc";

// A standalone deflate stream gains little on small frames; large snapshots shrink 4-8x.
const MIN_DEFLATED_FRAME_LENGTH = 1024;

/** JSON RPC whose large server frames go out as raw-deflate binary frames. */
export const deflatedJson = RpcSerialization.RpcSerialization.of({
  ...RpcSerialization.json,
  makeUnsafe: () => {
    const parser = RpcSerialization.json.makeUnsafe();
    return {
      decode: parser.decode,
      encode: (response) => {
        const encoded = parser.encode(response);
        return typeof encoded === "string" && encoded.length >= MIN_DEFLATED_FRAME_LENGTH
          ? NodeZlib.deflateRawSync(encoded)
          : encoded;
      },
    };
  },
});

/** Whether the client asked for deflated frames; never on top of permessage-deflate. */
export const wantsDeflatedFrames = (
  url: URL,
  headers: Readonly<Record<string, string | undefined>>,
): boolean =>
  url.searchParams.get(DEFLATED_RPC_FRAMES_QUERY_PARAM) === "1" &&
  !(headers["sec-websocket-extensions"] ?? "").includes("permessage-deflate");
