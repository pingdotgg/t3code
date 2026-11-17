import { assert, describe, it } from "@effect/vitest";

import {
  ProtoReader,
  encode,
  frame,
  message,
  parseGrpcWebBody,
  statusFromHeaders,
} from "./boxdCloudProto.ts";

const concat = (...parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const trailer = (text: string) => {
  const framed = frame(new TextEncoder().encode(text));
  framed[0] = 0x80;
  return framed;
};

describe("boxd protobuf", () => {
  it("round-trips the field kinds boxd's requests and replies use", () => {
    const bytes = encode(
      message(
        [1, "vm-1"],
        [2, 300],
        [3, true],
        [5, { t3code: "boxd-cloud" }],
        [6, message([1, "nested"])],
        // proto3 leaves defaults off the wire.
        [7, ""],
        [8, 0],
        [9, false],
      ),
    );
    const reader = new ProtoReader(bytes);
    assert.strictEqual(reader.string(1), "vm-1");
    assert.strictEqual(reader.number(2), 300);
    assert.isTrue(reader.bool(3));
    assert.deepStrictEqual(reader.map(5), { t3code: "boxd-cloud" });
    assert.strictEqual(reader.message(6)?.string(1), "nested");
    assert.isFalse(new ProtoReader(encode(message([7, ""], [8, 0], [9, false]))).bool(9));
    assert.strictEqual(encode(message([7, ""], [8, 0], [9, false])).length, 0);
  });

  it("writes a repeated string as one field per entry", () => {
    assert.deepStrictEqual(
      [...encode(message([3, ["a", "bc"]]))],
      [0x1a, 1, 0x61, 0x1a, 2, 0x62, 0x63],
    );
  });

  it("decodes varints past 32 bits, as boxd's millisecond timestamps are", () => {
    const at = 1_763_300_000_000;
    assert.strictEqual(new ProtoReader(encode(message([8, at]))).number(8), at);
  });

  it("splits a grpc-web body into its messages and the trailer's status", () => {
    const body = concat(
      frame(encode(message([1, "out"]))),
      frame(encode(message([6, 3]))),
      trailer("grpc-status: 5\r\ngrpc-message: vm%20not%20found\r\n"),
    );
    const parsed = parseGrpcWebBody(body);
    assert.strictEqual(parsed.messages.length, 2);
    assert.strictEqual(new ProtoReader(parsed.messages[0]!).string(1), "out");
    assert.strictEqual(new ProtoReader(parsed.messages[1]!).number(6), 3);
    assert.strictEqual(parsed.status, 5);
    assert.strictEqual(parsed.message, "vm not found");
  });

  it("reads a trailers-only reply's status from the headers", () => {
    assert.deepStrictEqual(parseGrpcWebBody(new Uint8Array()), {
      messages: [],
      status: null,
      message: "",
    });
    assert.deepStrictEqual(
      statusFromHeaders({ "grpc-status": "16", "grpc-message": "token%20expired" }),
      { status: 16, message: "token expired" },
    );
    assert.isNull(statusFromHeaders({}));
  });

  it("rejects a truncated message instead of reading past it", () => {
    const bytes = encode(message([1, "machine"]));
    assert.throws(() => new ProtoReader(bytes.subarray(0, bytes.length - 2)));
  });
});
