// @effect-diagnostics globalDate:off globalTimers:off - Fake lease mints carry epoch-ms expiries; the read-only path check waits a real beat to prove no socket opens.
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { BrowserFrameAccess } from "./access.ts";
import { createBrowserFrameClient, MjpegDemuxer, type BrowserFrameSessionRef } from "./stream.ts";

const encoder = new TextEncoder();

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function mjpegPart(headers: Record<string, string>, jpeg: Uint8Array): Uint8Array {
  const lines = Object.entries({ "Content-Type": "image/jpeg", ...headers })
    .map(([name, value]) => `${name}: ${value}`)
    .join("\r\n");
  return concatBytes(
    encoder.encode(`--t3frame\r\n${lines}\r\nContent-Length: ${jpeg.byteLength}\r\n\r\n`),
    jpeg,
    encoder.encode("\r\n"),
  );
}

describe("MjpegDemuxer", () => {
  const jpeg = (seed: number, length: number) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = (seed + i) % 251;
    return out;
  };

  it("emits a complete part with parsed headers", () => {
    const demuxer = new MjpegDemuxer();
    const parts = demuxer.push(
      mjpegPart({ "X-Frame-Seq": "7", "X-Geometry-Seq": "3" }, jpeg(1, 128)),
    );
    expect(parts).toHaveLength(1);
    expect(parts[0]?.headers["x-frame-seq"]).toBe("7");
    expect(parts[0]?.headers["x-geometry-seq"]).toBe("3");
    expect(parts[0]?.jpeg).toEqual(jpeg(1, 128));
  });

  it("reassembles a part split across arbitrary chunk boundaries", () => {
    const demuxer = new MjpegDemuxer();
    const whole = mjpegPart({ "X-Frame-Seq": "1" }, jpeg(2, 4096));
    const emitted = [];
    let offset = 0;
    for (const size of [7, 1024, 33]) {
      emitted.push(...demuxer.push(whole.subarray(offset, offset + size)));
      expect(emitted).toHaveLength(0);
      offset += size;
    }
    emitted.push(...demuxer.push(whole.subarray(offset)));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.jpeg).toEqual(jpeg(2, 4096));
  });

  it("emits multiple parts from one push", () => {
    const demuxer = new MjpegDemuxer();
    const first = mjpegPart({ "X-Frame-Seq": "4" }, jpeg(3, 64));
    const second = mjpegPart({ "X-Frame-Seq": "5" }, jpeg(4, 64));
    const parts = demuxer.push(concatBytes(first, second));
    expect(parts).toHaveLength(2);
    expect(parts.map((part) => part.headers["x-frame-seq"])).toEqual(["4", "5"]);
  });

  it("uses Content-Length so boundary-like bytes inside a JPEG do not split it", () => {
    const demuxer = new MjpegDemuxer();
    const payload = concatBytes(encoder.encode("--t3frame\r\n"), jpeg(9, 96));
    const parts = demuxer.push(mjpegPart({ "X-Frame-Seq": "2" }, payload));
    expect(parts).toHaveLength(1);
    expect(parts[0]?.jpeg).toEqual(payload);
  });

  it("caps a part that never completes instead of growing without bound", () => {
    const demuxer = new MjpegDemuxer();
    // A part header announcing a huge payload that never completes.
    demuxer.push(
      encoder.encode("--t3frame\r\nContent-Type: image/jpeg\r\nContent-Length: 536870912\r\n\r\n"),
    );
    const chunk = new Uint8Array(1024 * 1024);
    for (let index = 0; index < 40; index++) demuxer.push(chunk);
    const internals = demuxer as unknown as { buffer: Uint8Array; length: number };
    expect(internals.buffer.length).toBeLessThanOrEqual(MjpegDemuxer.MAX_BUFFER_BYTES);
  });

  it("caps a header that never terminates", () => {
    const demuxer = new MjpegDemuxer();
    demuxer.push(encoder.encode("--t3frame\r\n"));
    const chunk = new Uint8Array(1024 * 1024).fill(0x61);
    for (let index = 0; index < 40; index++) demuxer.push(chunk);
    const internals = demuxer as unknown as { buffer: Uint8Array; length: number };
    expect(internals.buffer.length).toBeLessThanOrEqual(MjpegDemuxer.MAX_BUFFER_BYTES);
  });

  it("drops an un-consumed tail past the bound rather than retaining it", () => {
    const demuxer = new MjpegDemuxer();
    const chunk = new Uint8Array(1024 * 1024).fill(0x78);
    for (let index = 0; index < 16; index++) demuxer.push(chunk);
    const internals = demuxer as unknown as { length: number };
    expect(internals.length).toBeLessThanOrEqual(MjpegDemuxer.MAX_TAIL_BYTES);
  });
});

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  readonly url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  emit(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const session: BrowserFrameSessionRef = {
  environmentId: "env-1",
  threadId: "thread-1",
  serverEpoch: "epoch-1",
  tabId: "tab-1",
};

const access: BrowserFrameAccess = {
  httpBase: "http://env.test/api/browser-frames",
  wsBase: "ws://env.test/api/browser-frames",
  query: {},
  credentials: false,
};

function makeEvents() {
  return {
    onStatus: vi.fn(),
    onConfig: vi.fn(),
    onDropped: vi.fn(),
    onUnauthorized: vi.fn(),
    onInputConnected: vi.fn(),
    onInputRejected: vi.fn(),
  };
}

const fakeCanvas = () =>
  ({
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => {} }),
  }) as unknown as HTMLCanvasElement;

const configResponse = () =>
  Response.json({
    ...session,
    engineGeneration: "gen-1",
    viewport: { cssWidth: 100, cssHeight: 100 },
    zoomFactor: 1,
    geometrySeq: 0,
  });

/** Push a paintable MJPEG part so `firstFrame` clears the input barrier. */
const paintFrame = (controller: ReadableStreamDefaultController<Uint8Array>) => {
  const sessionKey = encodeURIComponent(
    JSON.stringify([session.environmentId, session.threadId, session.serverEpoch, session.tabId]),
  );
  controller.enqueue(
    mjpegPart(
      {
        "X-Frame-Seq": "1",
        "X-Engine-Generation": "gen-1",
        "X-Session-Key": sessionKey,
        "X-Geometry-Seq": "4",
        "X-Frame-Width": "100",
        "X-Frame-Height": "100",
      },
      encoder.encode("jpeg-bytes"),
    ),
  );
};

describe("createBrowserFrameClient input lane", () => {
  let streamControllers: Array<ReadableStreamDefaultController<Uint8Array>>;
  beforeEach(() => {
    streamControllers = [];
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("createImageBitmap", async () => ({ width: 100, height: 100, close: () => {} }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("stream.mjpeg")) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start: (controller) => streamControllers.push(controller),
            }),
            { status: 200 },
          );
        }
        if (url.includes("/config")) return configResponse();
        return new Response("{}", { status: 404 });
      }),
    );
    return () => {
      vi.unstubAllGlobals();
    };
  });

  it("sends seq/geometrySeq-fenced packets only after bound and first paint", async () => {
    const openInput = vi.fn(async () => ({
      leaseId: "bfli.1",
      inputTicket: "bfv1.in.t",
      expiresAt: Date.now() + 60_000,
    }));
    const events = makeEvents();
    const client = createBrowserFrameClient(
      { access, session, openInput },
      { canvas: fakeCanvas() },
      events,
    );
    client.start();

    client.sendPointer("down", 0.5, 0.5);
    await vi.waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });
    const socket = FakeWebSocket.instances[0]!;
    await vi.waitFor(() => {
      expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    });
    // Nothing goes out before the hub's bound notice fixes geometrySeq.
    client.sendPointer("down", 0.5, 0.5);
    expect(socket.sent).toHaveLength(0);
    socket.emit({
      type: "bound",
      leaseId: "bfli.1",
      geometrySeq: 4,
      expiresAt: Date.now() + 60_000,
    });
    // Bound but unpainted: input still waits on the first painted frame.
    client.sendPointer("down", 0.5, 0.5);
    expect(socket.sent).toHaveLength(0);
    await vi.waitFor(() => expect(streamControllers).toHaveLength(1));
    paintFrame(streamControllers[0]!);
    await vi.waitFor(() => {
      client.sendPointer("down", 0.25, 0.75, "right");
      expect(socket.sent).toHaveLength(1);
    });
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      seq: 1,
      geometrySeq: 4,
      event: { type: "pointer", phase: "down", x: 0.25, y: 0.75, button: "right" },
    });
    // A geometry notice alone cannot advance packet geometry: only a painted
    // frame stamped with the new seq may authorize input against it.
    socket.emit({ type: "geometry", geometrySeq: 5 });
    client.sendWheel(10, -20, 0.5, 0.5);
    expect(JSON.parse(socket.sent[1]!)).toMatchObject({ seq: 2, geometrySeq: 4 });

    const sessionKey = encodeURIComponent(
      JSON.stringify([session.environmentId, session.threadId, session.serverEpoch, session.tabId]),
    );
    streamControllers[0]!.enqueue(
      mjpegPart(
        {
          "X-Frame-Seq": "2",
          "X-Engine-Generation": "gen-1",
          "X-Session-Key": sessionKey,
          "X-Geometry-Seq": "5",
          "X-Frame-Width": "100",
          "X-Frame-Height": "100",
        },
        encoder.encode("jpeg-bytes-2"),
      ),
    );
    // Wait for the paint to commit before sending — each send consumes a seq.
    await vi.waitFor(() => expect(client.state().geometrySeq).toBe(5));
    client.sendWheel(10, -20, 0.5, 0.5);
    expect(JSON.parse(socket.sent[2]!)).toMatchObject({ seq: 3, geometrySeq: 5 });
    client.stop();
  });

  it("blocks input until a replacement frame paints after a generation mismatch", async () => {
    let configReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("stream.mjpeg")) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start: (controller) => streamControllers.push(controller),
            }),
            { status: 200 },
          );
        }
        if (url.includes("/config")) {
          configReads += 1;
          return Response.json({
            ...session,
            engineGeneration: configReads === 1 ? "gen-1" : "gen-2",
            viewport: { cssWidth: 100, cssHeight: 100 },
            zoomFactor: 1,
            geometrySeq: 0,
          });
        }
        return new Response("{}", { status: 404 });
      }),
    );
    const openInput = vi.fn(async () => ({
      leaseId: "bfli.1",
      inputTicket: "bfv1.in.t",
      expiresAt: Date.now() + 60_000,
    }));
    const events = makeEvents();
    const client = createBrowserFrameClient(
      { access, session, openInput },
      { canvas: fakeCanvas() },
      events,
    );
    client.start();
    client.sendPointer("down", 0.5, 0.5);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const first = FakeWebSocket.instances[0]!;
    await vi.waitFor(() => expect(first.readyState).toBe(FakeWebSocket.OPEN));
    first.emit({ type: "bound", leaseId: "bfli.1", geometrySeq: 0 });
    await vi.waitFor(() => expect(streamControllers).toHaveLength(1));
    paintFrame(streamControllers[0]!);
    await vi.waitFor(() => {
      client.sendText("a");
      expect(first.sent).toHaveLength(1);
    });

    // A gen-2 part mid-stream means the guest was replaced: first-paint
    // eligibility and status must reset like end-of-body does.
    const sessionKey = encodeURIComponent(
      JSON.stringify([session.environmentId, session.threadId, session.serverEpoch, session.tabId]),
    );
    streamControllers[0]!.enqueue(
      mjpegPart(
        {
          "X-Frame-Seq": "2",
          "X-Engine-Generation": "gen-2",
          "X-Session-Key": sessionKey,
          "X-Geometry-Seq": "5",
        },
        encoder.encode("jpeg-gen2"),
      ),
    );
    await vi.waitFor(() => expect(client.state().status).toBe("connecting"));

    // The replacement input socket binds before any replacement paint — the
    // old generation's first paint must not authorize a send.
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(1), {
      timeout: 5_000,
      interval: 50,
    });
    const second = FakeWebSocket.instances[1]!;
    await vi.waitFor(() => expect(second.readyState).toBe(FakeWebSocket.OPEN));
    second.emit({ type: "bound", leaseId: "bfli.1", geometrySeq: 0 });
    client.sendText("b");
    expect(second.sent).toHaveLength(0);

    // Only once the replacement stream paints does input flow again — and it
    // carries the new generation's committed geometry.
    await vi.waitFor(() => expect(streamControllers.length).toBeGreaterThan(1), {
      timeout: 5_000,
      interval: 50,
    });
    streamControllers[1]!.enqueue(
      mjpegPart(
        {
          "X-Frame-Seq": "1",
          "X-Engine-Generation": "gen-2",
          "X-Session-Key": sessionKey,
          "X-Geometry-Seq": "5",
          "X-Frame-Width": "100",
          "X-Frame-Height": "100",
        },
        encoder.encode("jpeg-gen2-painted"),
      ),
    );
    await vi.waitFor(() => {
      client.sendText("c");
      expect(second.sent).toHaveLength(1);
    });
    expect(JSON.parse(second.sent[0]!)).toMatchObject({ seq: 1, geometrySeq: 5 });
    client.stop();
  });

  it("never opens the input socket on the read-only <img> path", async () => {
    vi.stubGlobal("createImageBitmap", undefined);
    const openInput = vi.fn(async () => ({
      leaseId: "bfli.1",
      inputTicket: "bfv1.in.t",
      expiresAt: Date.now() + 60_000,
    }));
    const events = makeEvents();
    const client = createBrowserFrameClient({ access, session, openInput }, {}, events);
    client.start();
    client.sendPointer("down", 0.5, 0.5);
    client.sendWheel(10, -20, 0.5, 0.5);
    client.sendKey("down", { key: "a", code: "KeyA" });
    client.sendText("hello");
    // Give the input lane a chance to connect if it were going to.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(openInput).not.toHaveBeenCalled();
    client.stop();
  });

  it("reconnects the stream after end-of-body via a fresh config read", async () => {
    const events = makeEvents();
    const client = createBrowserFrameClient({ access, session }, { canvas: fakeCanvas() }, events);
    client.start();
    await vi.waitFor(() => expect(streamControllers).toHaveLength(1));
    // The hub ends the response — the client must re-read config and retry.
    streamControllers[0]!.close();
    await vi.waitFor(() => expect(streamControllers.length).toBeGreaterThan(1), {
      timeout: 5_000,
      interval: 50,
    });
    client.stop();
  });

  it("does not commit geometry before the part is painted", async () => {
    let releaseDecode: ((bitmap: unknown) => void) | undefined;
    vi.stubGlobal("createImageBitmap", () => new Promise((resolve) => (releaseDecode = resolve)));
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
    } as unknown as HTMLCanvasElement;
    const events = makeEvents();
    const client = createBrowserFrameClient({ access, session }, { canvas }, events);
    client.start();
    await vi.waitFor(() => expect(streamControllers).toHaveLength(1));
    const sessionKey = encodeURIComponent(
      JSON.stringify([session.environmentId, session.threadId, session.serverEpoch, session.tabId]),
    );
    streamControllers[0]!.enqueue(
      mjpegPart(
        {
          "X-Frame-Seq": "1",
          "X-Engine-Generation": "gen-1",
          "X-Session-Key": sessionKey,
          "X-Geometry-Seq": "7",
        },
        encoder.encode("jpeg"),
      ),
    );
    // Received but not yet decoded/painted: geometry must not advance.
    await vi.waitFor(() => expect(releaseDecode).toBeDefined());
    expect(client.state().geometrySeq).not.toBe(7);
    expect(drawImage).not.toHaveBeenCalled();
    releaseDecode?.({ width: 100, height: 100, close: () => {} });
    await vi.waitFor(() => expect(client.state().geometrySeq).toBe(7));
    expect(drawImage).toHaveBeenCalled();
    client.stop();
  });

  it("ignores a config completion from before stop when a new lifetime started", async () => {
    let resolveStale: ((response: Response) => void) | undefined;
    let configReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/config")) {
          configReads += 1;
          if (configReads === 1) {
            return new Promise<Response>((resolve) => {
              resolveStale = resolve;
            });
          }
          return Response.json({
            ...session,
            engineGeneration: "gen-1",
            viewport: { cssWidth: 100, cssHeight: 100 },
            zoomFactor: 1,
            geometrySeq: 2,
          });
        }
        if (url.includes("stream.mjpeg")) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start: (controller) => streamControllers.push(controller),
            }),
            { status: 200 },
          );
        }
        return new Response("{}", { status: 404 });
      }),
    );
    const events = makeEvents();
    const client = createBrowserFrameClient({ access, session }, { canvas: fakeCanvas() }, events);
    client.start();
    await vi.waitFor(() => expect(configReads).toBe(1));
    // The first lifetime's config read is still in flight when the client is
    // stopped and restarted.
    client.stop();
    client.start();
    await vi.waitFor(() => expect(client.state().geometrySeq).toBe(2));
    // The stale completion must not mutate the restarted client's state.
    resolveStale?.(
      Response.json({
        ...session,
        engineGeneration: "gen-1",
        viewport: { cssWidth: 100, cssHeight: 100 },
        zoomFactor: 1,
        geometrySeq: 99,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.state().geometrySeq).toBe(2);
    client.stop();
  });

  it("resumes input seq above the lease high-water reported on bound after a stream reset", async () => {
    const openInput = vi.fn(async () => ({
      leaseId: "bfli.1",
      inputTicket: "bfv1.in.t",
      expiresAt: Date.now() + 60_000,
    }));
    const events = makeEvents();
    const client = createBrowserFrameClient(
      { access, session, openInput },
      { canvas: fakeCanvas() },
      events,
    );
    client.start();
    client.sendPointer("move", 0.1, 0.1);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const first = FakeWebSocket.instances[0]!;
    await vi.waitFor(() => expect(first.readyState).toBe(FakeWebSocket.OPEN));
    first.emit({
      type: "bound",
      leaseId: "bfli.1",
      geometrySeq: 4,
      expiresAt: Date.now() + 60_000,
    });
    await vi.waitFor(() => expect(streamControllers).toHaveLength(1));
    paintFrame(streamControllers[0]!);
    await vi.waitFor(() => {
      client.sendPointer("move", 0.2, 0.2);
      client.sendPointer("move", 0.3, 0.3);
      expect(first.sent).toHaveLength(2);
    });
    expect(JSON.parse(first.sent[1]!)).toMatchObject({ seq: 2 });

    // End-of-body resets the stream and the input lease: the client re-mints
    // and rebinds under the same lease.
    streamControllers[0]!.close();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2), {
      timeout: 5_000,
      interval: 50,
    });
    const second = FakeWebSocket.instances[1]!;
    await vi.waitFor(() => expect(second.readyState).toBe(FakeWebSocket.OPEN));
    // The hub retained the lease's high-water mark across the socket
    // replacement — the client resumes numbering above it rather than
    // restarting at 1 into replay rejections.
    second.emit({
      type: "bound",
      leaseId: "bfli.1",
      geometrySeq: 4,
      highSeq: 2,
      expiresAt: Date.now() + 60_000,
    });
    await vi.waitFor(() => expect(streamControllers.length).toBeGreaterThan(1), {
      timeout: 5_000,
      interval: 50,
    });
    paintFrame(streamControllers[1]!);
    await vi.waitFor(() => {
      client.sendPointer("move", 0.4, 0.4);
      expect(second.sent).toHaveLength(1);
    });
    expect(JSON.parse(second.sent[0]!)).toMatchObject({ seq: 3, geometrySeq: 4 });
    client.stop();
  });

  it("re-mints the lease through openInput when the socket dies", async () => {
    let mints = 0;
    const openInput = vi.fn(async () => ({
      leaseId: `bfli.${++mints}`,
      inputTicket: `bfv1.in.${mints}`,
      expiresAt: Date.now() + 60_000,
    }));
    const events = makeEvents();
    const client = createBrowserFrameClient(
      { access, session, openInput },
      { canvas: fakeCanvas() },
      events,
    );
    client.start();
    client.sendPointer("move", 0.1, 0.1);
    await vi.waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });
    FakeWebSocket.instances[0]!.close();
    await vi.waitFor(
      () => {
        expect(openInput).toHaveBeenCalledTimes(2);
      },
      { timeout: 5_000, interval: 50 },
    );
    client.stop();
  });
});
