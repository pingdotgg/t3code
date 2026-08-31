import type { DesktopBridge } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { createDesktopVoiceInputPlatform } from "./desktopVoiceInput";

type SpeechBridge = NonNullable<DesktopBridge["speech"]>;

function makeBridge(overrides: Partial<SpeechBridge> = {}): SpeechBridge {
  return {
    getStatus: vi.fn(),
    getMicrophones: vi.fn(),
    setMicrophone: vi.fn(),
    prepare: vi.fn(async () => ({ locale: "en" })),
    cancelPreparation: vi.fn(async () => undefined),
    startRecording: vi.fn(async () => undefined),
    stopRecording: vi.fn(async () => "desktop-speech://recording"),
    cancelRecording: vi.fn(async () => undefined),
    transcribe: vi.fn(async () => "desktop transcript"),
    deleteRecording: vi.fn(async () => undefined),
    removeModel: vi.fn(),
    onEvent: vi.fn(() => () => undefined),
    ...overrides,
  };
}

describe("desktop voice input platform", () => {
  it("adapts Electron capture to the shared recorder contract", async () => {
    const bridge = makeBridge();
    const { recorder } = createDesktopVoiceInputPlatform(bridge);

    await recorder.prepareToRecordAsync();
    recorder.record({ forDuration: 300 });
    await recorder.stop();

    expect(bridge.startRecording).toHaveBeenCalledOnce();
    expect(bridge.stopRecording).toHaveBeenCalledOnce();
    expect(recorder.uri).toBe("desktop-speech://recording");
  });

  it("adapts transcribe.cpp IPC to the shared transcriber contract", async () => {
    const bridge = makeBridge();
    const { transcriber } = createDesktopVoiceInputPlatform(bridge);
    const options = { signal: new AbortController().signal };

    const prepared = await transcriber.prepare(options);
    await expect(prepared.transcribe("desktop-speech://recording", options)).resolves.toBe(
      "desktop transcript",
    );

    expect(prepared.locale).toBe("en");
    expect(bridge.transcribe).toHaveBeenCalledWith("desktop-speech://recording");
  });

  it("forwards preparation cancellation to Electron", async () => {
    let rejectPreparation!: (error: unknown) => void;
    const bridge = makeBridge({
      prepare: vi.fn(
        () =>
          new Promise<{ locale: string }>((_, reject) => {
            rejectPreparation = reject;
          }),
      ),
    });
    const { transcriber } = createDesktopVoiceInputPlatform(bridge);
    const abortController = new AbortController();
    const preparing = transcriber.prepare({ signal: abortController.signal });

    abortController.abort();
    expect(bridge.cancelPreparation).toHaveBeenCalledOnce();
    rejectPreparation(new Error("cancelled"));

    await expect(preparing).rejects.toMatchObject({ code: "cancelled" });
  });
});
