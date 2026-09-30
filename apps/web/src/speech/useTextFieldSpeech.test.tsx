// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { VoiceInputController } from "@t3tools/client-runtime/voice-input";
import type { useEnvironmentSpeechInput } from "./useEnvironmentSpeechInput";
import { DiffCommentAnnotation } from "~/components/diffs/DiffCommentAnnotation";

const mocks = vi.hoisted(() => ({
  input: null as Parameters<typeof useEnvironmentSpeechInput>[0] | null,
  busy: false,
}));
vi.mock("./useEnvironmentSpeechInput", () => ({
  useEnvironmentSpeechInput: (input: Parameters<typeof useEnvironmentSpeechInput>[0]) => {
    mocks.input = input;
    return {
      available: true,
      state: { phase: mocks.busy ? "recording" : "idle", error: null, errorAction: null },
      blocksSubmission: mocks.busy,
      freezesEditor: mocks.busy,
      progress: null,
      level: 0,
      preview: null,
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      cancel: vi.fn(),
      skipPostProcessing: vi.fn(),
      status: null,
      setup: {
        open: false,
        step: 0,
        model: null,
        downloading: false,
        error: null,
        setOpen: vi.fn(),
        download: vi.fn(),
        cancelDownload: vi.fn(),
        startRecording: vi.fn(),
      },
    };
  },
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => DEFAULT_RESOLVED_KEYBINDINGS }));
vi.mock("~/state/server", () => ({ primaryServerKeybindingsAtom: {} }));
vi.mock("~/hooks/useSettings", () => ({ useClientSettings: () => "toggle" }));
vi.mock("~/components/chat/VoiceInputSetup", () => ({ VoiceInputSetup: () => null }));
vi.mock("~/components/chat/ComposerSpeechButton", () => ({
  ComposerSpeechButton: () => null,
  ComposerSpeechCancelButton: () => null,
  ComposerSpeechRecordingPill: () => null,
  ComposerSpeechStatus: () => null,
}));

let root: Root;
let container: HTMLDivElement;
let frames: FrameRequestCallback[];
const comments: string[] = [];
const environmentId = EnvironmentId.make("test-environment");
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.busy = false;
  comments.length = 0;
  frames = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount() {
  await act(() =>
    root.render(
      <DiffCommentAnnotation
        kind="draft"
        rangeLabel="12"
        text=""
        environmentId={environmentId}
        ownerKey="thread:file:12"
        onCancel={() => {}}
        onComment={(text) => comments.push(text)}
        focusOnMount={false}
      />,
    ),
  );
  return container.querySelector("textarea")!;
}
it("inserts dictation at the comment cursor and submits the completed draft", async () => {
  const field = await mount();
  await act(() => mocks.input!.commitDraft("one two", { start: 7, end: 7 }));
  field.setSelectionRange(4, 7);
  const controller = new VoiceInputController({
    recorder: {
      uri: "recording",
      prepareToRecordAsync: async () => {},
      record: () => {},
      stop: async () => {},
    },
    getTranscriber: () => ({
      prepare: async () => ({ locale: "en-US", transcribe: async () => "new" }),
    }),
    requestPermission: async () => ({ granted: true, canAskAgain: true }),
    configureRecording: async () => {},
    releaseRecording: async () => {},
    deleteRecording: () => {},
    readDraft: () => ({
      ...mocks.input!.readDraft(),
      ownerKey: mocks.input!.ownerKey,
      revision: 0,
    }),
    commitDraft: (text, selection) => mocks.input!.commitDraft(text, selection),
    onStateChange: () => {},
  });
  try {
    await act(() => controller.start());
    await act(() => controller.stop());
  } finally {
    controller.dispose();
  }
  await act(() => {
    frames.splice(0).forEach((frame) => frame(0));
  });
  expect(field.value).toBe("one new two");
  expect(field.selectionStart).toBe(8);
  const submit = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Comment",
  )!;
  await act(() => submit.click());
  expect(comments).toEqual(["one new two"]);
});
it("blocks click and keyboard submission while dictation is running", async () => {
  mocks.busy = true;
  const field = await mount();
  await act(() => mocks.input!.commitDraft("unfinished", { start: 10, end: 10 }));
  expect(field.readOnly).toBe(true);
  const submit = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Comment",
  )!;
  await act(() => {
    submit.click();
    field.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(comments).toEqual([]);
});
