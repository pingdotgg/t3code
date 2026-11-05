import { describe, expect, it } from "@effect/vitest";
import * as NodeZlib from "node:zlib";

import { deflatedJson, wantsDeflatedFrames } from "./wsDeflatedFrames.ts";

describe("deflated RPC frames", () => {
  it("sends large frames as raw deflate and small ones as text", () => {
    const parser = deflatedJson.makeUnsafe();
    const large = { _tag: "Chunk", requestId: "1", values: ["x".repeat(4096)] };
    const encoded = parser.encode(large);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect((encoded as Uint8Array).length).toBeLessThan(200);
    expect(JSON.parse(NodeZlib.inflateRawSync(encoded as Uint8Array).toString())).toEqual(large);
    expect(parser.encode({ _tag: "Pong" })).toBe('{"_tag":"Pong"}');
    expect(parser.decode('{"_tag":"Ping"}')).toEqual([{ _tag: "Ping" }]);
  });

  it.each([
    ["ws://h/ws?deflatedFrames=1", {}, true],
    ["ws://h/ws", {}, false],
    [
      "ws://h/ws?deflatedFrames=1",
      { "sec-websocket-extensions": "permessage-deflate; client_max_window_bits" },
      false,
    ],
  ])("%s %o -> %s", (url, headers, expected) => {
    expect(wantsDeflatedFrames(new URL(url), headers)).toBe(expected);
  });
});
