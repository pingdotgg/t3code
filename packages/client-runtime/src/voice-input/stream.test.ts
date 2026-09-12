import { afterEach, expect, it, vi } from "vite-plus/test";
import { SPEECH_STREAM_MAX_QUEUED_BYTES, type SpeechStreamEvent } from "@t3tools/contracts";
import { openSpeechStream } from "./stream.ts";

class TestSocket extends EventTarget {
  sent: (string | Uint8Array)[] = [];
  closed = false;
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }
  receive(event: SpeechStreamEvent) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
  }
}

afterEach(() => vi.useRealTimers());

async function connect() {
  const socket = new TestSocket();
  const abort = new AbortController();
  const onText = vi.fn();
  const onError = vi.fn();
  const pending = openSpeechStream({
    url: "wss://environment.test/ws/voice",
    signal: abort.signal,
    onText,
    onError,
    createSocket: () => socket as unknown as WebSocket,
  });
  socket.receive({ type: "ready" });
  return { socket, abort, onText, onError, stream: await pending };
}

it("drains ordered PCM before finishing and replaces tentative hypotheses", async () => {
  const { socket, stream, onText } = await connect();
  stream.feed(new Float32Array([0.1]));
  stream.feed(new Float32Array([0.2]));
  const final = stream.finish();
  expect(socket.sent).toHaveLength(1);
  socket.receive({ type: "update", revision: 1, text: { committed: "hello ", tentative: "were" } });
  expect(socket.sent).toHaveLength(2);
  expect(new Float32Array((socket.sent[1] as Uint8Array).slice().buffer)[0]).toBeCloseTo(0.2);
  socket.receive({
    type: "update",
    revision: 2,
    text: { committed: "hello ", tentative: "world" },
  });
  expect(socket.sent[2]).toBe('{"type":"finish"}');
  expect(onText.mock.calls.map(([text]) => text)).toEqual([
    { committed: "hello ", tentative: "were" },
    { committed: "hello ", tentative: "world" },
  ]);
  socket.receive({ type: "finished", text: "hello world" });
  await expect(final).resolves.toBe("hello world");
  expect(socket.closed).toBe(true);
});

it("rejects overload instead of silently dropping audio", async () => {
  const { socket, stream, onError } = await connect();
  stream.feed(new Float32Array(SPEECH_STREAM_MAX_QUEUED_BYTES / 4 + 1));
  await expect(stream.finish()).rejects.toThrow("cannot keep up");
  expect(onError).toHaveBeenCalledOnce();
  expect(socket.sent).toHaveLength(0);
  expect(socket.closed).toBe(true);
});

it("cancels in-flight audio without sending queued frames or accepting late text", async () => {
  const { socket, stream, abort, onText } = await connect();
  stream.feed(new Float32Array([0.1]));
  stream.feed(new Float32Array([0.2]));
  abort.abort();
  socket.receive({ type: "update", revision: 1, text: { committed: "late", tentative: "" } });
  expect(socket.sent).toHaveLength(1);
  expect(onText).not.toHaveBeenCalled();
  await expect(stream.finish()).rejects.toThrow("cancelled");
});

it("fails on disconnect and times out stalled inference", async () => {
  vi.useFakeTimers();
  const first = await connect();
  first.socket.close();
  await expect(first.stream.finish()).rejects.toThrow("connection closed");
  const second = await connect();
  second.stream.feed(new Float32Array([0.1]));
  await vi.advanceTimersByTimeAsync(120_000);
  await expect(second.stream.finish()).rejects.toThrow("stopped responding");
  expect(second.socket.closed).toBe(true);
});
