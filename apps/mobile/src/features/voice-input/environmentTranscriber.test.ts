import { VOICE_RECORDING_LIMIT_SECONDS } from "@t3tools/client-runtime/voice-input";
import { expect, it, vi } from "vite-plus/test";
import { createEnvironmentTranscriber } from "./environmentTranscriber";

it("never uploads a recording whose grant changed while the phone decoded it", async () => {
  let grant = 1;
  const decoded = Promise.withResolvers<Uint8Array>();
  const upload = vi.fn(async () => "hello");
  const transcriber = createEnvironmentTranscriber({
    canSend: () => grant === 1,
    prepare: async () => "en",
    decode: () => decoded.promise,
    upload,
  });
  const options = { signal: new AbortController().signal };
  const recording = await transcriber.prepare(options);
  const transcription = recording.transcribe("file:///draft.m4a", options);
  grant++;
  decoded.resolve(new Uint8Array([0, 128, 0, 64]));
  await expect(transcription).rejects.toMatchObject({ code: "cancelled" });
  expect(upload).not.toHaveBeenCalled();
});

it("uploads normalized mono samples only after the recording is finished", async () => {
  const upload = vi.fn(async (bytes: Uint8Array) => {
    expect(Array.from(new Float32Array(Uint8Array.from(bytes).buffer))).toEqual([-1, 0.5]);
    return "hello";
  });
  const transcriber = createEnvironmentTranscriber({
    canSend: () => true,
    prepare: async () => "en",
    decode: async () => new Uint8Array([255, 0, 128, 0, 64, 255]).subarray(1, 5),
    upload,
  });
  const options = { signal: new AbortController().signal };
  const recording = await transcriber.prepare(options);
  expect(upload).not.toHaveBeenCalled();
  await expect(recording.transcribe("file:///draft.m4a", options)).resolves.toBe("hello");
});

it("trims at most one second of recorder padding and rejects longer recordings", async () => {
  const limit = 16_000 * VOICE_RECORDING_LIMIT_SECONDS;
  const padded = new Uint8Array((limit + 16_000 + 1) * 2);
  padded[(limit - 1) * 2 + 1] = 64;
  let bytes = padded.subarray(0, -2);
  const upload = vi.fn(async (body: Uint8Array) => {
    expect(body.byteLength).toBe(limit * 4);
    expect(
      new DataView(body.buffer, body.byteOffset, body.byteLength).getFloat32(
        body.byteLength - 4,
        true,
      ),
    ).toBe(0.5);
    return "hello";
  });
  const options = { signal: new AbortController().signal };
  const recording = await createEnvironmentTranscriber({
    canSend: () => true,
    prepare: async () => "en",
    decode: async () => bytes,
    upload,
  }).prepare(options);
  await expect(recording.transcribe("file:///padded.m4a", options)).resolves.toBe("hello");
  bytes = padded;
  await expect(recording.transcribe("file:///too-long.m4a", options)).rejects.toThrow(
    "This recording couldn’t be read. Try recording again.",
  );
  expect(upload).toHaveBeenCalledOnce();
});
