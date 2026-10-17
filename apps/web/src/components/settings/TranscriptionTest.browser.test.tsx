import { DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { userEvent } from "vite-plus/test/browser";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { createBrowserVoiceInputPlatform } from "../../speech/browserVoiceInput";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  record: vi.fn(),
  stop: vi.fn(async () => {}),
  release: vi.fn(),
  remove: vi.fn(),
  transcribe: vi.fn(),
  platform: vi.fn(),
}));
vi.mock("../../speech/browserVoiceInput", () => ({
  createBrowserVoiceInputPlatform: (
    input: Parameters<typeof createBrowserVoiceInputPlatform>[0],
  ) => {
    mocks.platform(input);
    return {
      recorder: {
        uri: "blob:pcm",
        prepareToRecordAsync: async () => {},
        record: mocks.record,
        stop: mocks.stop,
      },
      transcriber: { prepare: mocks.prepare },
      cancelRecording: mocks.release,
      deleteRecording: mocks.remove,
    };
  },
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ control, children }) => (
    <div>
      {control}
      {children}
    </div>
  ),
}));
import { TranscriptionTest } from "./TranscriptionTest";

let root: Root;
let container: HTMLDivElement;
const prepared = {} as PreparedConnection;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
async function mount() {
  mocks.prepare.mockResolvedValue({ locale: "en", transcribe: mocks.transcribe });
  await act(async () => {
    root.render(
      <TranscriptionTest
        prepared={prepared}
        options={DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS}
        microphoneId="mic"
        modelName="Test model"
        disabled={false}
      />,
    );
  });
}
async function click(label: string) {
  const name =
    (
      {
        Stop: "Finish voice input",
        Cancel: "Cancel voice input",
        Retry: "Retry transcription",
      } as Record<string, string>
    )[label] ?? label;
  const button = [...container.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === name || button.textContent?.trim() === name,
  );
  expect(button, name).toBeDefined();
  await userEvent.click(button!);
}
const result = () => container.querySelector('[aria-label="Test transcription"]');

it("transcribes a ten-second test through the voice controller and clears the result on Done", async () => {
  mocks.transcribe.mockResolvedValue("A model test.");
  await mount();
  await click("Test model");
  expect(mocks.record).toHaveBeenCalledWith({ forDuration: 10 });
  await click("Stop");
  expect(mocks.transcribe).toHaveBeenCalledWith("blob:pcm", { signal: expect.any(AbortSignal) });
  expect(result()!.textContent).toBe("A model test.");
  expect(mocks.remove).toHaveBeenCalledWith("blob:pcm");
  await click("Done");
  expect(container.querySelectorAll('[aria-label="Test transcription"]')).toHaveLength(0);
});

it("cancels recording without transcribing", async () => {
  await mount();
  await click("Test model");
  await click("Cancel");
  expect(mocks.transcribe).not.toHaveBeenCalled();
  expect(mocks.release).toHaveBeenCalled();
  expect(container.querySelectorAll('[aria-label="Test transcription"]')).toHaveLength(0);
});

it("shows transcription errors and allows another test", async () => {
  mocks.transcribe.mockRejectedValueOnce(new Error("Model failed"));
  await mount();
  await click("Test model");
  await click("Stop");
  expect(container.querySelector('[role="status"]')!.getAttribute("aria-label")).toBe(
    "Could not transcribe this recording.",
  );
  mocks.transcribe.mockResolvedValue("Try again.");
  await click("Retry");
  expect(result()!.textContent).toBe("Try again.");
});

it("shows live streaming text and finishes through the streaming session", async () => {
  await mount();
  const finish = vi.fn(async () => "Finished streaming text.");
  mocks.prepare.mockResolvedValue({
    locale: "en",
    transcribe: mocks.transcribe,
    streaming: { finish },
  });
  await click("Test model");
  const input = mocks.platform.mock.calls[0]?.[0] as Parameters<
    typeof createBrowserVoiceInputPlatform
  >[0];
  await act(async () => input.onText({ committed: "Live ", tentative: "text" }));
  expect(result()!.textContent).toBe("Live text");
  await click("Stop");
  expect(finish).toHaveBeenCalled();
  expect(mocks.transcribe).not.toHaveBeenCalled();
  expect(result()!.textContent).toBe("Finished streaming text.");
});
