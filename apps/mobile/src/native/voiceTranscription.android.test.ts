import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  checkAvailability: vi.fn<() => Promise<boolean>>(),
  prepare: vi.fn<(id: number) => Promise<{ locale: string; mode: number }>>(),
  transcribe: vi.fn<(id: number, uri: string, locale: string, mode: number) => Promise<string>>(),
  cancel: vi.fn<(id: number) => Promise<void>>(),
}));

vi.mock("expo", () => ({
  requireOptionalNativeModule: () => ({ isAvailable: () => true, ...mocks }),
}));

import { getLocalVoiceTranscriber } from "./voiceTranscription.android";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

it.each([false, true])(
  "waits for device support before offering a transcriber (%s)",
  async (supported) => {
    vi.resetAllMocks();
    const probe = deferred<boolean>();
    mocks.checkAvailability.mockReturnValue(probe.promise);
    let settled = false;
    const result = Promise.resolve(getLocalVoiceTranscriber()).then((transcriber) => {
      settled = true;
      return transcriber;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    probe.resolve(supported);
    expect((await result) !== null).toBe(supported);
  },
);

it.each(["preparation", "transcription"] as const)(
  "waits for native cancellation cleanup during %s before settling",
  async (phase) => {
    vi.resetAllMocks();
    mocks.checkAvailability.mockResolvedValue(true);
    const prepared = { locale: "en-US", mode: 1 };
    mocks.prepare.mockResolvedValue(prepared);
    const enteredCancellation = deferred<number>();
    const cleanup = deferred<void>();
    mocks.cancel.mockImplementation((id) => {
      enteredCancellation.resolve(id);
      return cleanup.promise;
    });
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const pending = deferred<void>();
    let operationId: number | undefined;
    const operation = (id: number) => {
      operationId = id;
      return pending.promise;
    };
    const transcriber = (await getLocalVoiceTranscriber())!;
    const transcription = phase === "transcription" ? await transcriber.prepare(options) : null;
    if (phase === "preparation")
      mocks.prepare.mockImplementation((id) => operation(id).then(() => prepared));
    else mocks.transcribe.mockImplementation((id) => operation(id).then(() => "Dictated text."));
    let settled = false;
    const result = (
      transcription
        ? transcription.transcribe("file:///recording.m4a", options)
        : transcriber.prepare(options)
    ).catch((error: unknown) => {
      settled = true;
      return error;
    });

    controller.abort();
    expect(await enteredCancellation.promise).toBe(operationId);
    expect(settled).toBe(false);
    // The bridge may finish while cancellation is still closing the native recognizer.
    pending.resolve();
    cleanup.resolve();
    expect(await result).toMatchObject({ code: "cancelled" });
  },
);
