import { describe, expect, it, vi } from "vite-plus/test";

import { modelViewerEvent } from "./model-viewer-document";
import {
  createModelByteSink,
  createModelViewerRequests,
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

it("settles outstanding work when a page is replaced and ignores its late replies", async () => {
  vi.useFakeTimers();
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  const first = createModelViewerRequests(1, () => true);
  const ack = first.sendChunk("YQ==");
  const capture = first.capture([]);
  first.close();
  await expect(ack).rejects.toMatchObject({ name: "AbortError" });
  await expect(capture).resolves.toBeNull();
  expect(vi.getTimerCount()).toBe(0);

  const second = createModelViewerRequests(2, () => true);
  const nextAck = second.sendChunk("Yg==");
  const nextCapture = second.capture([]);
  const result = {
    screenshot: { dataUrl: "data:image/png;base64,AA==", width: 5, height: 6 },
    view: { position: [1, 2, 3], target: [0, 0, 0] },
  } as const;
  second.receive({ type: "ack", id: 1 });
  second.receive({ type: "captured", id: 1, requestId: 1, result });
  second.receive({ type: "ack", id: 2 });
  second.receive({ type: "captured", id: 2, requestId: 1, result: null });
  await expect(nextAck).resolves.toBeUndefined();
  await expect(nextCapture).resolves.toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it("settles lost replies and accepts a new capture after the deadline", async () => {
  vi.useFakeTimers();
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  const viewer = createModelViewerRequests(1, () => true);
  const outcomes: { ack?: unknown; capture?: unknown } = {};
  void viewer.sendChunk("YQ==").catch((cause: unknown) => (outcomes.ack = cause));
  void viewer.capture([]).then((result) => (outcomes.capture = result));
  await vi.runOnlyPendingTimersAsync();
  expect(outcomes).toEqual({
    ack: expect.objectContaining({ message: expect.stringMatching(/timed out/i) }),
    capture: null,
  });
  await expect(viewer.sendChunk("Yg==")).rejects.toThrow(/timed out/i);

  const nextCapture = viewer.capture([]);
  const result = {
    screenshot: { dataUrl: "data:image/png;base64,AA==", width: 5, height: 6 },
    view: { position: [1, 2, 3], target: [0, 0, 0] },
  } as const;
  viewer.receive({ type: "captured", id: 1, requestId: 1, result: null });
  viewer.receive({ type: "captured", id: 1, requestId: 2, result });
  await expect(nextCapture).resolves.toEqual(result);
  expect(vi.getTimerCount()).toBe(0);
});

it("waits for the current model to load, with a deadline and teardown", async () => {
  vi.useFakeTimers();
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  const view = { position: [1, 2, 3], target: [0, 0, 0] } as const;
  const summary = { format: "stl", triangles: 1, size: [1, 1, 1], fingerprint: "abc" } as const;
  const viewer = createModelViewerRequests(1, () => true);
  const outcome = viewer.finish("stl", view);
  viewer.receive({ type: "loaded", id: 2, view, summary });
  const timeout = expect(outcome).rejects.toThrow(/timed out/i);
  await vi.runOnlyPendingTimersAsync();
  await timeout;
  const retry = createModelViewerRequests(2, () => true);
  const loaded = retry.finish("stl", view);
  retry.receive({ type: "loaded", id: 2, view, summary });
  await loaded;
  const cancelled = retry.finish("stl", view);
  retry.close();
  await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  expect(vi.getTimerCount()).toBe(0);
});
