import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createCodexVoiceRecorder, readVoiceTranscriptEvent } from "./codexVoiceRecorder";

describe("Codex realtime transcription", () => {
  it("accepts user input chunks and ignores assistant speech and commands", () => {
    expect(
      readVoiceTranscriptEvent(
        JSON.stringify({ type: "input_transcript.added", item: { id: "one", text: " Hello" } }),
      ),
    ).toEqual({ id: "one", text: " Hello" });
    expect(
      readVoiceTranscriptEvent(
        JSON.stringify({
          type: "output_transcript.added",
          item: { id: "two", text: "Run this command" },
        }),
      ),
    ).toBeNull();
    expect(
      readVoiceTranscriptEvent(
        JSON.stringify({ type: "delegation", item: { id: "three", text: "Run this command" } }),
      ),
    ).toBeNull();
  });
  it("ignores malformed and unrelated channel messages", () => {
    for (const event of [
      "not json",
      "null",
      "{}",
      '{"type":"input_transcript.added","item":{"text":1}}',
    ])
      expect(readVoiceTranscriptEvent(event)).toBeNull();
  });
});

const network = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  readConnection: vi.fn(),
  startRequest: vi.fn(),
  stopRequest: vi.fn(),
}));
vi.mock("../state/session", () => ({ readPreparedConnection: network.readConnection }));
vi.mock("@t3tools/client-runtime/voice-input", () => ({
  startVoice: network.startRequest,
  stopVoice: network.stopRequest,
}));
vi.mock("../lib/runtime", () => ({
  runtime: {
    runPromise: (request: { kind: string; text: string }) => {
      if (request.kind === "start") network.start();
      if (request.kind === "stop") network.stop();
      return Promise.resolve({ sessionId: "session", sdp: "answer" });
    },
  },
}));

class VoicePeer {
  static current: VoicePeer;
  connectionState = "connected";
  onconnectionstatechange: (() => void) | null = null;
  setConnectionState(state: string) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
  channel = {
    readyState: "open",
    onmessage: null as ((event: { data: string }) => void) | null,
    onclose: null as (() => void) | null,
  };
  localDescription = { sdp: "offer" };
  constructor() {
    VoicePeer.current = this;
  }
  createDataChannel() {
    return this.channel;
  }
  addTransceiver() {
    return { sender: { replaceTrack: async () => {} } };
  }
  createOffer() {
    return Promise.resolve({ sdp: "offer" });
  }
  setLocalDescription() {
    return Promise.resolve();
  }
  setRemoteDescription() {
    return Promise.resolve();
  }
  close() {}
  chunk(id: string, text: string) {
    this.channel.onmessage?.({
      data: JSON.stringify({ type: "input_transcript.added", item: { id, text } }),
    });
  }
}
function deferredMicrophone() {
  let resolve = (_stream: MediaStream) => {};
  const promise = new Promise<MediaStream>((done) => {
    resolve = done;
  });
  return { promise, resolve: (stream: MediaStream) => resolve(stream) };
}

function createRecorderHarness(microphone?: Promise<MediaStream>) {
  const track = { enabled: true, stop: vi.fn() };
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  const callbacks = { onTranscript: vi.fn(), onError: vi.fn() };
  const recorder = createCodexVoiceRecorder(
    EnvironmentId.make("env"),
    ProviderInstanceId.make("codex"),
    microphone ?? Promise.resolve(stream),
    callbacks,
  );
  return { track, callbacks, recorder };
}
describe("live recorder completion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("RTCPeerConnection", VoicePeer);
    vi.stubGlobal("navigator", { language: "en-US" });
    network.start.mockReset();
    network.stop.mockReset();
    network.readConnection.mockReset().mockReturnValue({ environment: "original" });
    network.startRequest.mockReset().mockReturnValue({ kind: "start" });
    network.stopRequest.mockReset().mockReturnValue({ kind: "stop" });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it("pins start and cleanup to the selected environment and account", async () => {
    const { recorder } = createRecorderHarness();
    const original = network.readConnection.mock.results[0]?.value;
    expect(network.readConnection).toHaveBeenCalledExactlyOnceWith("env");
    network.readConnection.mockReturnValue({ environment: "different" });
    await recorder.start();
    expect(network.startRequest).toHaveBeenCalledExactlyOnceWith(original, "codex", "offer");
    recorder.dispose();
    expect(network.stopRequest).toHaveBeenCalledExactlyOnceWith(original, "session");
    expect(network.readConnection).toHaveBeenCalledTimes(1);
  });
  it("survives a brief disconnect but reports a persistent loss", async () => {
    const { recorder, callbacks } = createRecorderHarness();
    await recorder.start();
    VoicePeer.current.setConnectionState("disconnected");
    await vi.advanceTimersByTimeAsync(4000);
    expect(callbacks.onError).not.toHaveBeenCalled();
    VoicePeer.current.setConnectionState("connected");
    await vi.advanceTimersByTimeAsync(5000);
    expect(callbacks.onError).not.toHaveBeenCalled();
    VoicePeer.current.setConnectionState("disconnected");
    await vi.advanceTimersByTimeAsync(5000);
    expect(callbacks.onError).toHaveBeenCalledOnce();
    recorder.dispose();
  });
  it("clears disconnect cleanup timers and fails immediately on terminal failure", async () => {
    const first = createRecorderHarness();
    await first.recorder.start();
    VoicePeer.current.setConnectionState("disconnected");
    first.recorder.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(first.callbacks.onError).not.toHaveBeenCalled();
    const second = createRecorderHarness();
    await second.recorder.start();
    VoicePeer.current.setConnectionState("failed");
    expect(second.callbacks.onError).toHaveBeenCalledOnce();
    second.recorder.dispose();
  });
  it("batches live chunks and finishes without a second AI request", async () => {
    const { recorder, callbacks, track } = createRecorderHarness();
    await recorder.start();
    VoicePeer.current.chunk("1", "can you");
    VoicePeer.current.chunk("1", "can you");
    VoicePeer.current.chunk("2", " check it question mark");
    expect(callbacks.onTranscript).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(callbacks.onTranscript).toHaveBeenCalledExactlyOnceWith(
      "can you check it question mark",
    );
    const stopped = recorder.stop();
    expect(track.enabled).toBe(false);
    await vi.advanceTimersByTimeAsync(1500);
    await expect(stopped).resolves.toEqual({
      text: "can you check it question mark",
      locale: "en-US",
    });
    recorder.dispose();
    expect(network.stop).toHaveBeenCalledTimes(1);
  });

  it("extends the quiet window when the last words arrive after stop", async () => {
    const { recorder } = createRecorderHarness();
    await recorder.start();
    VoicePeer.current.chunk("1", "can you check");
    const stopped = recorder.stop();
    const completed = vi.fn();
    void stopped.then(completed);
    await vi.advanceTimersByTimeAsync(1400);
    VoicePeer.current.chunk("2", " the microphone");
    await vi.advanceTimersByTimeAsync(999);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(stopped).resolves.toMatchObject({ text: "can you check the microphone" });
    recorder.dispose();
  });

  it("cancels pending completion without inserting late speech", async () => {
    const { recorder, callbacks } = createRecorderHarness();
    await recorder.start();
    VoicePeer.current.chunk("1", "keep these words");
    const stopped = recorder.stop();
    const rejected = expect(stopped).rejects.toThrow("cancelled");
    recorder.dispose();
    VoicePeer.current.chunk("2", "discard these");
    await vi.advanceTimersByTimeAsync(8000);
    await rejected;
    expect(callbacks.onTranscript).not.toHaveBeenCalled();
  });

  it("negotiates while the microphone is opening and keeps it muted until ready", async () => {
    const microphone = deferredMicrophone();
    const { recorder } = createRecorderHarness(microphone.promise);
    const started = recorder.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(network.start).toHaveBeenCalledTimes(1);
    const track = { enabled: true, stop: vi.fn() };
    microphone.resolve({
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream);
    await started;
    expect(track.enabled).toBe(true);
    recorder.dispose();
    expect(track.stop).toHaveBeenCalled();
  });

  it("releases a microphone that opens after cancellation", async () => {
    const microphone = deferredMicrophone();
    const { recorder } = createRecorderHarness(microphone.promise);
    const started = recorder.start();
    await vi.advanceTimersByTimeAsync(0);
    recorder.dispose();
    const track = { enabled: true, stop: vi.fn() };
    microphone.resolve({
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream);
    await started;
    expect(track.stop).toHaveBeenCalled();
  });
  it("keeps late microphone tracks muted after a concurrent stop", async () => {
    const microphone = deferredMicrophone();
    const { recorder } = createRecorderHarness(microphone.promise);
    const started = recorder.start();
    const stopped = recorder.stop();
    const track = { enabled: true, stop: vi.fn() };
    microphone.resolve({
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream);
    await started;
    expect(track.enabled).toBe(false);
    await vi.advanceTimersByTimeAsync(1500);
    await stopped;
    expect(track.enabled).toBe(false);
    recorder.dispose();
  });
});
