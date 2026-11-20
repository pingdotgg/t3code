import { describe, expect, it } from "vite-plus/test";

import { modelViewerEvent } from "./model-viewer-document";
import {
  createModelByteSink,
  ModelTooLargeError,
  modelTransferChunks,
} from "./model-viewer-protocol";

function streamOf(...parts: number[]) {
  let next = 0;
  const pieces = parts.map((length) =>
    Uint8Array.from({ length }, () => (next++ * 37 + 11) & 0xff),
  );
  const all = Uint8Array.from(pieces.flatMap((piece) => [...piece]));
  return {
    all,
    reader: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) controller.enqueue(piece);
        controller.close();
      },
    }).getReader(),
  };
}

describe("model byte transfer to the viewer page", () => {
  it("delivers every byte in order across uneven reads", async () => {
    const { all, reader } = streamOf(7, 300, 1, 64, 129);
    const sink = createModelByteSink(1024);
    const messages: string[] = [];
    for await (const message of modelTransferChunks(reader, 1024, 64)) {
      messages.push(message);
      sink.push(message);
    }
    expect(messages).toHaveLength(Math.ceil(all.length / 64));
    expect(new Uint8Array(sink.bytes())).toEqual(all);
  });

  it("stops reading a stream once it passes the limit", async () => {
    const { reader } = streamOf(60, 60);
    const read = async () => {
      for await (const _message of modelTransferChunks(reader, 100, 64)) {
        // Draining is the test.
      }
    };
    await expect(read()).rejects.toBeInstanceOf(ModelTooLargeError);
  });

  it("refuses more bytes on the page than the limit", () => {
    const sink = createModelByteSink(4);
    expect(() => sink.push(btoa("12345"))).toThrow(ModelTooLargeError);
  });
});

describe("viewer page messages", () => {
  it("accepts what the page sends", () => {
    const view = { position: [1, 2, 3], target: [0, 0, 0] };
    expect(modelViewerEvent(JSON.stringify({ type: "view", view, moved: true }))).toEqual({
      type: "view",
      view,
      moved: true,
    });
  });

  it.each([
    "not json",
    "null",
    '{"type":"unknown"}',
    '{"type":"ack"}',
    '{"type":"pin","id":4}',
    '{"type":"failed","id":1,"code":"model-on-fire"}',
    '{"type":"view","view":{"position":[1,2],"target":[0,0,0]},"moved":true}',
  ])("ignores %s", (data) => {
    expect(modelViewerEvent(data)).toBeNull();
  });
});
