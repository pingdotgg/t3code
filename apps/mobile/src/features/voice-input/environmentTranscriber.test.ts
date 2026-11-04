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
  await expect(transcription).rejects.toThrow();
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
    decode: async () => new Uint8Array([0, 128, 0, 64]),
    upload,
  });
  const options = { signal: new AbortController().signal };
  const recording = await transcriber.prepare(options);
  expect(upload).not.toHaveBeenCalled();
  await expect(recording.transcribe("file:///draft.m4a", options)).resolves.toBe("hello");
});
