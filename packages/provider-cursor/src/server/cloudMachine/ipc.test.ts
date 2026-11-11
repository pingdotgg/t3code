import { describe, expect, it } from "@effect/vitest";

import { encodeFrame, FrameReader, MessageType, serialize, ValueReader } from "./ipc.ts";

const readAll = (bytes: Uint8Array) => {
  const reader = new ValueReader(bytes);
  const values: unknown[] = [];
  while (!reader.done) values.push(reader.read());
  return values;
};

describe("VS Code remote IPC encoding", () => {
  it("round-trips request headers and arguments", () => {
    const contents = new Uint8Array(300).fill(7);
    const values = [
      [100, 12, "remoteFilesystem", "writeFile"],
      [
        { scheme: "vscode-remote", authority: "background-composer+bc-1", path: "/workspace/a" },
        contents,
        { create: true, overwrite: true },
      ],
      undefined,
      "x".repeat(200),
    ];

    expect(readAll(serialize(...values))).toEqual(values);
  });

  it("encodes integers past one VQL byte as unsigned varints", () => {
    expect(Array.from(serialize(300))).toEqual([6, 0xac, 0x02]);
    expect(readAll(serialize(2 ** 30 + 5))).toEqual([2 ** 30 + 5]);
  });

  it("reassembles frames split across socket chunks", () => {
    const first = encodeFrame({ type: MessageType.Regular, id: 1, ack: 0, body: serialize("a") });
    const second = encodeFrame({ type: MessageType.Ack, id: 0, ack: 4, body: new Uint8Array() });
    const stream = new Uint8Array([...first, ...second]);
    const reader = new FrameReader();

    const frames = [
      ...reader.push(stream.slice(0, 5)),
      ...reader.push(stream.slice(5, first.length + 3)),
      ...reader.push(stream.slice(first.length + 3)),
    ];

    expect(frames.map(({ type, id, ack }) => ({ type, id, ack }))).toEqual([
      { type: MessageType.Regular, id: 1, ack: 0 },
      { type: MessageType.Ack, id: 0, ack: 4 },
    ]);
    expect(readAll(frames[0]!.body)).toEqual(["a"]);
  });
});
