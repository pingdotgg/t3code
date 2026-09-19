import type { TranscriptionResult } from "@react-native-ai/apple/src/NativeAppleTranscription";
import type { Spec as AppleLLM } from "@react-native-ai/apple/src/NativeAppleLLM";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { VoiceTranscriptionError } from "@t3tools/client-runtime/voice-input";

const mocks = vi.hoisted(() => ({
  isAvailable: vi.fn<(locale: string) => boolean>(),
  prepare: vi.fn<(locale: string) => Promise<string>>(),
  transcribe: vi.fn<(audio: ArrayBufferLike, locale: string) => Promise<TranscriptionResult>>(),
  readAudio: vi.fn<() => Promise<ArrayBuffer>>(),
  modelAvailable: vi.fn<AppleLLM["isAvailable"]>(),
  generateText: vi.fn<AppleLLM["generateText"]>(),
}));

vi.mock("@react-native-ai/apple/src/NativeAppleLLM", () => ({
  default: { isAvailable: mocks.modelAvailable, generateText: mocks.generateText },
}));

vi.mock("@react-native-ai/apple/src/NativeAppleTranscription", () => ({
  default: {
    isAvailable: mocks.isAvailable,
    prepare: mocks.prepare,
    transcribe: mocks.transcribe,
  },
}));

vi.mock("expo-file-system", () => ({
  File: class {
    arrayBuffer = mocks.readAudio;
  },
}));

import { getLocalVoiceTranscriber } from "./voiceTranscription.ios";

const audio = new ArrayBuffer(4);
const nativeTranscript: TranscriptionResult = {
  duration: 2,
  segments: [
    { text: " Hej", startSecond: 0, endSecond: 1 },
    { text: "världen. ", startSecond: 1, endSecond: 2 },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.isAvailable.mockReturnValue(true);
  mocks.prepare.mockResolvedValue("sv-SE");
  mocks.readAudio.mockResolvedValue(audio);
  mocks.transcribe.mockResolvedValue(nativeTranscript);
  mocks.modelAvailable.mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getLocalVoiceTranscriber", () => {
  it("keeps the selected language and Apple's resolved locale when the device language changes", async () => {
    const resolvedOptions = Intl.DateTimeFormat().resolvedOptions();
    const deviceLocale = vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({ ...resolvedOptions, locale: "sv-FI" });
    const transcriber = getLocalVoiceTranscriber()!;
    const options = { signal: new AbortController().signal };

    deviceLocale.mockReturnValue({ ...resolvedOptions, locale: "de-DE" });
    const prepared = await transcriber.prepare(options);
    deviceLocale.mockReturnValue({ ...resolvedOptions, locale: "en-US" });

    await expect(prepared.transcribe("file:///voice.m4a", options)).resolves.toBe("Hej världen.");
    expect(mocks.prepare).toHaveBeenCalledWith("sv-FI");
    expect(prepared.locale).toBe("sv-SE");
    expect(mocks.transcribe).toHaveBeenCalledWith(audio, "sv-SE");
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it.each([
    ["Uh, fix umm the bug. Ahh.", "fix the bug.", "fix the bug."],
    ["Eh, ändra um färgen.", "ändra färgen.", "ändra färgen."],
    [
      "Unm, use the uh useVoiceInput hook.",
      "use the useVoiceInput hook.",
      "use the useVoiceInput hook.",
    ],
    ["Uh, fix the bug.", "Fix the bug.", "Uh, fix the bug."],
    ["Uh, do not delete it.", "do delete it.", "Uh, do not delete it."],
    ["Uh, keep foo_bar.ts.", "keep fooBar.ts.", "Uh, keep foo_bar.ts."],
    ["Uh, first then second.", "second then first.", "Uh, first then second."],
    ["Uh, fix it.", "Here is the transcript: fix it.", "Uh, fix it."],
    ["Uh, fix it.", "", "Uh, fix it."],
    ["Uh, umm.", "", "Uh, umm."],
    ['Uh, explain "um".', "explain", 'Uh, explain "um".'],
    ["Uh, explain the word um.", "explain the word um.", "explain the word um."],
  ])("accepts only filler deletions from %s", async (text, cleaned, expected) => {
    mocks.transcribe.mockResolvedValue({
      duration: 2,
      segments: [{ text, startSecond: 0, endSecond: 2 }],
    });
    mocks.generateText.mockResolvedValue([{ type: "text", text: cleaned }]);
    const options = { signal: new AbortController().signal };
    const prepared = await getLocalVoiceTranscriber()!.prepare(options);

    await expect(prepared.transcribe("file:///voice.m4a", options)).resolves.toBe(expected);
    expect(mocks.generateText).toHaveBeenCalledOnce();
  });

  it.each(["unavailable", "failure", "unexpected-response"])(
    "keeps successful transcription when cleanup has %s",
    async (failure) => {
      const text = "Uh, fix it.";
      mocks.transcribe.mockResolvedValue({
        duration: 2,
        segments: [{ text, startSecond: 0, endSecond: 2 }],
      });
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      if (failure === "unavailable") mocks.modelAvailable.mockReturnValue(false);
      if (failure === "failure") mocks.generateText.mockRejectedValue(new Error("Model refused"));
      if (failure === "unexpected-response") mocks.generateText.mockResolvedValue([]);
      const options = { signal: new AbortController().signal };
      const prepared = await getLocalVoiceTranscriber()!.prepare(options);

      await expect(prepared.transcribe("file:///voice.m4a", options)).resolves.toBe(text);
      if (failure === "unavailable") expect(mocks.generateText).not.toHaveBeenCalled();
      if (failure === "failure") expect(warning).toHaveBeenCalledOnce();
    },
  );

  it("discards cleanup after cancellation", async () => {
    const enteredCleanup = deferred<void>();
    const finishCleanup = deferred<Awaited<ReturnType<AppleLLM["generateText"]>>>();
    mocks.transcribe.mockResolvedValue({
      duration: 2,
      segments: [{ text: "Uh, fix it.", startSecond: 0, endSecond: 2 }],
    });
    mocks.generateText.mockImplementation(() => {
      enteredCleanup.resolve();
      return finishCleanup.promise;
    });
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const prepared = await getLocalVoiceTranscriber()!.prepare(options);
    const result = prepared
      .transcribe("file:///voice.m4a", options)
      .catch((error: unknown) => error);

    await enteredCleanup.promise;
    controller.abort();
    finishCleanup.resolve([{ type: "text", text: "fix it." }]);

    expect(await result).toMatchObject({ code: "cancelled" });
  });

  it("does not start native transcription after cancellation during a file read", async () => {
    const enteredRead = deferred<void>();
    const readResult = deferred<ArrayBuffer>();
    mocks.readAudio.mockImplementation(() => {
      enteredRead.resolve();
      return readResult.promise;
    });
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const prepared = await getLocalVoiceTranscriber()!.prepare(options);
    const result = prepared
      .transcribe("file:///voice.m4a", options)
      .catch((error: unknown) => error);

    await enteredRead.promise;
    controller.abort();
    readResult.resolve(audio);

    const error = await result;
    expect(error).toBeInstanceOf(VoiceTranscriptionError);
    expect(error).toMatchObject({ code: "cancelled" });
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });

  it.each(["prepare", "transcribe"] as const)(
    "waits for native %s to finish before settling cancellation",
    async (phase) => {
      const enteredNative = deferred<void>();
      const finishNative = deferred<void>();
      if (phase === "prepare") {
        mocks.prepare.mockImplementation(async () => {
          enteredNative.resolve();
          await finishNative.promise;
          return "sv-SE";
        });
      } else {
        mocks.transcribe.mockImplementation(async () => {
          enteredNative.resolve();
          await finishNative.promise;
          return nativeTranscript;
        });
      }
      const controller = new AbortController();
      const options = { signal: controller.signal };
      const transcriber = getLocalVoiceTranscriber()!;
      const operation =
        phase === "prepare"
          ? transcriber.prepare(options)
          : (await transcriber.prepare(options)).transcribe("file:///voice.m4a", options);
      const settled = vi.fn((value: unknown) => value);
      const result = operation.then(settled, settled);

      await enteredNative.promise;
      controller.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).not.toHaveBeenCalled();
      finishNative.resolve();

      const error = await result;
      expect(error).toBeInstanceOf(VoiceTranscriptionError);
      expect(error).toMatchObject({ code: "cancelled" });
    },
  );
});
