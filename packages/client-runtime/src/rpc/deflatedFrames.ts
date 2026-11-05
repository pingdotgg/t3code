import { inflateSync } from "fflate";
import * as RpcSerialization from "effect/rpc/RpcSerialization";

/** JSON RPC that inflates the raw-deflate binary frames a server sends on request. */
export const inflatingJson = RpcSerialization.RpcSerialization.of({
  ...RpcSerialization.json,
  makeUnsafe: () => {
    const parser = RpcSerialization.json.makeUnsafe();
    return {
      encode: parser.encode,
      decode: (data) => parser.decode(typeof data === "string" ? data : inflateSync(data)),
    };
  },
});
