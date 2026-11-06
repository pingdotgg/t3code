import { inflateSync } from "fflate";
import * as RpcSerialization from "effect/rpc/RpcSerialization";

import type { makeConnectionDiagnostics } from "../connection/diagnostics.ts";

/** JSON RPC that inflates the raw-deflate binary frames a server sends on request. */
export const inflatingJson = (diagnostics?: ReturnType<typeof makeConnectionDiagnostics>) =>
  RpcSerialization.RpcSerialization.of({
    ...RpcSerialization.json,
    makeUnsafe: () => {
      const parser = RpcSerialization.json.makeUnsafe();
      return {
        encode: parser.encode,
        decode: (data) => {
          let decoded = data;
          if (typeof data !== "string") {
            diagnostics?.count("binary");
            try {
              decoded = inflateSync(data);
            } catch (error) {
              diagnostics?.fail("inflate");
              throw error;
            }
          }
          try {
            return parser.decode(decoded);
          } catch (error) {
            diagnostics?.fail("json");
            throw error;
          }
        },
      };
    },
  });
