import { assert, describe, it } from "@effect/vitest";

import {
  decodeChannelFrameBody,
  encodeChannelFrame,
  makeChannelFramer,
} from "./zcodeServeProtocol.ts";

const HEADER_BYTES = 13;

/** A server→client frame the client would receive, built the same way the daemon builds it. */
const incomingFrame = (kind: number, body: Uint8Array): Uint8Array => {
  const frame = new Uint8Array(HEADER_BYTES + body.byteLength);
  frame[0] = kind;
  new DataView(frame.buffer).setUint32(9, body.byteLength);
  frame.set(body, HEADER_BYTES);
  return frame;
};

const messageBody = (header: ReadonlyArray<unknown>, arg: unknown): Uint8Array => {
  const frame = encodeChannelFrame(header, arg);
  return frame.slice(HEADER_BYTES);
};

describe("channel frame codec", () => {
  it("round-trips a call's header and argument", () => {
    const arg = [{ workspacePath: "/w", includeDeleted: false }];
    const frame = encodeChannelFrame([100, 3, "zcode-session", "createSession"], arg);
    assert.equal(frame[0], 1);
    assert.equal(new DataView(frame.buffer).getUint32(9), frame.byteLength - HEADER_BYTES);
    assert.deepEqual(decodeChannelFrameBody(frame.slice(HEADER_BYTES)), {
      type: 100,
      id: 3,
      data: arg,
    });
  });

  it("round-trips every serialized value type", () => {
    const arg = {
      text: "héllo",
      count: 300,
      list: [1, "two", null],
      nested: { deep: [null, { ok: true }] },
    };
    const decoded = decodeChannelFrameBody(messageBody([204, 7], arg));
    assert.deepEqual(decoded, { type: 204, id: 7, data: arg });

    const buffer = new Uint8Array([1, 2, 3]);
    const withBuffer = decodeChannelFrameBody(messageBody([201, 1], buffer));
    assert.ok(withBuffer !== undefined);
    assert.deepEqual([...(withBuffer.data as Uint8Array)], [1, 2, 3]);

    const withUndefined = decodeChannelFrameBody(messageBody([201, 2], undefined));
    assert.deepEqual(withUndefined, { type: 201, id: 2, data: undefined });
  });

  it("reads an init frame without an argument", () => {
    assert.deepEqual(decodeChannelFrameBody(messageBody([200, 0], undefined)), {
      type: 200,
      id: 0,
      data: undefined,
    });
  });

  it("rejects an unknown tag or a truncated body", () => {
    assert.throws(() => decodeChannelFrameBody(Uint8Array.of(9)), /unknown tag 9/);
    assert.throws(() => decodeChannelFrameBody(Uint8Array.of(1, 5, 65)), /truncated/);
  });
});

describe("channel framer", () => {
  it("reassembles frames split across arbitrary chunks", () => {
    const first = encodeChannelFrame([201, 1], ["first"]);
    const second = encodeChannelFrame([204, 2], { delta: "second" });
    const joined = new Uint8Array(first.byteLength + second.byteLength);
    joined.set(first, 0);
    joined.set(second, first.byteLength);

    const framer = makeChannelFramer();
    const bodies = [
      ...framer(joined.slice(0, 5)),
      ...framer(joined.slice(5, HEADER_BYTES + 2)),
      ...framer(joined.slice(HEADER_BYTES + 2, joined.byteLength - 1)),
      ...framer(joined.slice(joined.byteLength - 1)),
    ];
    assert.equal(bodies.length, 2);
    assert.deepEqual(decodeChannelFrameBody(bodies[0]!), { type: 201, id: 1, data: ["first"] });
    assert.deepEqual(decodeChannelFrameBody(bodies[1]!), {
      type: 204,
      id: 2,
      data: { delta: "second" },
    });
  });

  it("emits every complete frame carried by one chunk", () => {
    const first = encodeChannelFrame([204, 1], "a");
    const second = encodeChannelFrame([204, 2], "b");
    const joined = new Uint8Array(first.byteLength + second.byteLength);
    joined.set(first, 0);
    joined.set(second, first.byteLength);
    assert.equal(makeChannelFramer()(joined).length, 2);
  });

  it("drops frames whose kind is not a message and resumes at the next header", () => {
    const other = incomingFrame(7, new Uint8Array([0]));
    const message = encodeChannelFrame([204, 4], "payload");
    const joined = new Uint8Array(other.byteLength + message.byteLength);
    joined.set(other, 0);
    joined.set(message, other.byteLength);

    const bodies = makeChannelFramer()(joined);
    assert.equal(bodies.length, 1);
    assert.deepEqual(decodeChannelFrameBody(bodies[0]!), {
      type: 204,
      id: 4,
      data: "payload",
    });
  });

  it("keeps a partial frame buffered", () => {
    const framer = makeChannelFramer();
    const frame = encodeChannelFrame([204, 5], "later");
    assert.deepEqual(framer(frame.slice(0, HEADER_BYTES - 1)), []);
    assert.equal(framer(frame.slice(HEADER_BYTES - 1)).length, 1);
  });
});
