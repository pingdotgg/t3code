import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { WsSubscribeServerConfigRpc } from "./rpc.ts";

describe("subscribeServerConfig payload compatibility", () => {
  it("stays optional, so a client that never sends it still subscribes", () => {
    const decoded = Schema.decodeSync(WsSubscribeServerConfigRpc.payloadSchema)({});
    expect(decoded).toEqual({});
  });
});
