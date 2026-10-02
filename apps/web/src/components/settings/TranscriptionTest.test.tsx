import { DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS } from "@t3tools/contracts";
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
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
vi.mock("../chat/ComposerSpeechButton", () => ({
  ComposerSpeechRecordingPill: ({ onStop, onCancel }: { onStop(): void; onCancel(): void }) =>
    createElement(
      "div",
      null,
      createElement("button", { onClick: onStop }, "Stop"),
      createElement("button", { onClick: onCancel }, "Cancel"),
    ),
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("./settingsSearch", () => ({ searchableSetting: () => ({}) }));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({ control, children }: { control: ReactNode; children: ReactNode }) =>
    createElement("div", null, control, children),
}));
import { TranscriptionTest } from "./TranscriptionTest";

let root: ReactTestRenderer;
const prepared = {} as PreparedConnection;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
async function mount() {
  mocks.prepare.mockResolvedValue({ locale: "en", transcribe: mocks.transcribe });
  await act(async () => {
    root = create(
      createElement(TranscriptionTest, {
        prepared,
        options: DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        microphoneId: "mic",
        modelName: "Test model",
        disabled: false,
      }),
    );
  });
}
async function click(label: string) {
  await act(async () => {
    root.root
      .findAllByType("button")
      .find((button) => button.children.includes(label))
      ?.props.onClick();
  });
}

it("transcribes a ten-second test through the voice controller and clears the result on Done", async () => {
  mocks.transcribe.mockResolvedValue("A model test.");
  await mount();
  await click("Test model");
  expect(mocks.record).toHaveBeenCalledWith({ forDuration: 10 });
  await click("Stop");
  expect(mocks.transcribe).toHaveBeenCalledWith("blob:pcm", { signal: expect.any(AbortSignal) });
  expect(root.root.findByProps({ "aria-label": "Test transcription" }).children.join("")).toBe(
    "A model test.",
  );
  expect(mocks.remove).toHaveBeenCalledWith("blob:pcm");
  await click("Done");
  expect(root.root.findAllByProps({ "aria-label": "Test transcription" })).toHaveLength(0);
});

it("cancels recording without transcribing", async () => {
  await mount();
  await click("Test model");
  await click("Cancel");
  expect(mocks.transcribe).not.toHaveBeenCalled();
  expect(mocks.release).toHaveBeenCalled();
  expect(root.root.findAllByProps({ "aria-label": "Test transcription" })).toHaveLength(0);
});

it("shows transcription errors and allows another test", async () => {
  mocks.transcribe.mockRejectedValueOnce(new Error("Model failed"));
  await mount();
  await click("Test model");
  await click("Stop");
  expect(root.root.findByProps({ role: "alert" }).children.join("")).toBe(
    "Could not transcribe this recording.",
  );
  mocks.transcribe.mockResolvedValue("Try again.");
  await click("Test model");
  await click("Stop");
  expect(root.root.findByProps({ "aria-label": "Test transcription" }).children.join("")).toBe(
    "Try again.",
  );
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
  const result = root.root.findByProps({ "aria-label": "Test transcription" });
  expect(
    result
      .findAllByType("span")
      .map((span) => span.children.join(""))
      .join(""),
  ).toBe("Live text");
  await click("Stop");
  expect(finish).toHaveBeenCalled();
  expect(mocks.transcribe).not.toHaveBeenCalled();
  expect(root.root.findByProps({ "aria-label": "Test transcription" }).children.join("")).toBe(
    "Finished streaming text.",
  );
});
