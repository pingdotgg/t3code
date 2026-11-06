import type { TranscriptionResult } from "@react-native-ai/apple/src/NativeAppleTranscription";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { VoiceTranscriptionError } from "@t3tools/client-runtime/voice-input";

const mocks = vi.hoisted(() => ({
  isAvailable: vi.fn<(locale: string) => boolean>(),
  prepare: vi.fn<(locale: string) => Promise<string>>(),
  transcribe: vi.fn<(audio: ArrayBufferLike, locale: string) => Promise<TranscriptionResult>>(),
  readAudio: vi.fn<() => Promise<ArrayBuffer>>(),
  preferredLanguages: [] as unknown,
}));

// iOS exposes the user's ordered Language & Region list through NSUserDefaults.
vi.mock("react-native", () => ({
  Settings: { get: (key: string) => (key === "AppleLanguages" ? mocks.preferredLanguages : null) },
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

const unsupportedLocale = () =>
  Object.assign(new Error("unsupported"), { code: "AppleTranscriptionUnsupportedLocale" });

function useLanguages(preferred: ReadonlyArray<string>, appLocale: string) {
  mocks.preferredLanguages = preferred;
  const resolvedOptions = Intl.DateTimeFormat().resolvedOptions();
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
    ...resolvedOptions,
    locale: appLocale,
  });
}

/** Prepares and transcribes one recording, resolving with the error when either step fails. */
async function transcribeOnce(signal = new AbortController().signal) {
  const transcriber = (await getLocalVoiceTranscriber())!;
  return transcriber
    .prepare({ signal })
    .then(async (prepared) => {
      const text = await prepared.transcribe("file:///voice.m4a", { signal });
      return { text, locale: prepared.locale };
    })
    .catch((error: unknown) => error);
}

beforeEach(() => {
  vi.resetAllMocks();
  useLanguages([], "sv-SE");
  mocks.isAvailable.mockReturnValue(true);
  mocks.prepare.mockResolvedValue("sv-SE");
  mocks.readAudio.mockResolvedValue(audio);
  mocks.transcribe.mockResolvedValue(nativeTranscript);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getLocalVoiceTranscriber", () => {
  it.each([
    {
      case: "a spoken language ahead of the English app locale",
      preferred: ["ko-KR", "en-US"],
      supported: ["ko-KR", "en-US"],
      tried: ["ko-KR"],
    },
    {
      case: "the next preferred language after an unsupported one",
      preferred: ["gsw-CH", "de-CH", "en-US"],
      supported: ["de-CH", "en-US"],
      tried: ["gsw-CH", "de-CH"],
    },
    {
      case: "the app locale when no preferred language is supported",
      preferred: ["gsw-CH", "yi"],
      supported: ["en-US"],
      tried: ["gsw-CH", "yi", "en-US"],
    },
  ])("prepares $case", async ({ preferred, supported, tried }) => {
    useLanguages(preferred, "en-US");
    mocks.prepare.mockImplementation(async (candidate) => {
      if (!supported.includes(candidate)) throw unsupportedLocale();
      return candidate;
    });

    const locale = tried.at(-1)!;
    expect(await transcribeOnce()).toEqual({ text: "Hej världen.", locale });
    expect(mocks.prepare.mock.calls.map(([candidate]) => candidate)).toEqual(tried);
    expect(mocks.transcribe).toHaveBeenCalledWith(audio, locale);
  });

  it("reports an unsupported language when neither preferred nor app locales are supported", async () => {
    useLanguages(["gsw-CH"], "yi");
    mocks.prepare.mockRejectedValue(unsupportedLocale());

    expect(await transcribeOnce()).toMatchObject({ code: "unsupported-locale" });
    expect(mocks.prepare.mock.calls.map(([candidate]) => candidate)).toEqual(["gsw-CH", "yi"]);
  });

  it.each(["cancellation", "a model failure"] as const)(
    "does not fall back to another language after %s",
    async (failure) => {
      useLanguages(["ko-KR", "ja-JP"], "en-US");
      const entered = Promise.withResolvers<void>();
      const nativePrepare = Promise.withResolvers<string>();
      mocks.prepare.mockImplementation(() => {
        entered.resolve();
        return nativePrepare.promise;
      });
      const controller = new AbortController();
      const result = transcribeOnce(controller.signal);

      await entered.promise;
      if (failure === "cancellation") {
        controller.abort();
        nativePrepare.reject(unsupportedLocale());
      } else {
        nativePrepare.reject(Object.assign(new Error("download failed"), { code: "Network" }));
      }

      expect(await result).toMatchObject({
        code: failure === "cancellation" ? "cancelled" : "preparation-failed",
      });
      expect(mocks.prepare.mock.calls.map(([candidate]) => candidate)).toEqual(["ko-KR"]);
    },
  );

  it("does not start native transcription after cancellation during a file read", async () => {
    const enteredRead = Promise.withResolvers<void>();
    const readResult = Promise.withResolvers<ArrayBuffer>();
    mocks.readAudio.mockImplementation(() => {
      enteredRead.resolve();
      return readResult.promise;
    });
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const prepared = await (await getLocalVoiceTranscriber())!.prepare(options);
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
});
