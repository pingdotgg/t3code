import { describe, expect, it } from "vite-plus/test";

import { createP2pWorkletReplyDecoder, encodeP2pWorkletCommand } from "./protocol";

describe("encodeP2pWorkletCommand", () => {
  it("encodes a dial command as one newline-terminated JSON line", () => {
    const encoded = encodeP2pWorkletCommand({
      type: "dial",
      id: "dial-1",
      publicKeyZ32: "key",
      bootstrap: ["10.0.0.5:49737"],
    });
    expect(encoded.endsWith("\n")).toBe(true);
    expect(JSON.parse(encoded)).toEqual({
      type: "dial",
      id: "dial-1",
      publicKeyZ32: "key",
      bootstrap: ["10.0.0.5:49737"],
    });
  });
});

describe("createP2pWorkletReplyDecoder", () => {
  it("buffers partial lines until the newline arrives", () => {
    const decode = createP2pWorkletReplyDecoder();
    expect(decode('{"type":"listening","id":"dial-1","publicKey')).toEqual([]);
    expect(decode('Z32":"key","port":59071}\n')).toEqual([
      { type: "listening", id: "dial-1", publicKeyZ32: "key", port: 59071 },
    ]);
  });

  it("yields every complete reply in a chunk and drops malformed lines", () => {
    const decode = createP2pWorkletReplyDecoder();
    const replies = decode(
      [
        '{"type":"dial-error","id":"dial-2","publicKeyZ32":"key","message":"invalid public key"}',
        "not-json",
        '{"type":"unknown-kind","id":"x"}',
        '{"type":"closed","id":"close-1","publicKeyZ32":"key","closed":true}',
        "",
      ].join("\n") + "\n",
    );
    expect(replies).toEqual([
      {
        type: "dial-error",
        id: "dial-2",
        publicKeyZ32: "key",
        message: "invalid public key",
      },
      { type: "closed", id: "close-1", publicKeyZ32: "key", closed: true },
    ]);
  });
});
