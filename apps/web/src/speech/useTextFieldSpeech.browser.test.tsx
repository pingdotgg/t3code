import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../test/render";
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
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => DEFAULT_RESOLVED_KEYBINDINGS,
}));
vi.mock("~/state/server", () => ({ primaryServerKeybindingsAtom: {} }));
vi.mock("~/hooks/useSettings", () => ({ useClientSettings: () => "toggle" }));
vi.mock("~/components/chat/VoiceInputSetup", () => ({ VoiceInputSetup: () => null }));
vi.mock("~/components/chat/ComposerSpeechButton", () => ({
  ComposerSpeechButton: () => null,
  ComposerSpeechCancelButton: () => null,
  ComposerSpeechRecordingPill: () => null,
  ComposerSpeechStatus: () => null,
}));

const environmentId = EnvironmentId.make("test-environment");
function setup() {
  mocks.busy = false;
  const comments: string[] = [];
  const frames: FrameRequestCallback[] = [];
  const animationFrame = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
  return {
    comments,
    frames,
    [Symbol.dispose]: () => animationFrame.mockRestore(),
    ui: (
      <DiffCommentAnnotation
        kind="draft"
        rangeLabel="12"
        text=""
        environmentId={environmentId}
        ownerKey="thread:file:12"
        onCancel={() => {}}
        onComment={(text) => comments.push(text)}
        focusOnMount={false}
      />
    ),
  };
}
function mount(ui: ReactNode) {
  // The animation-frame stub must capture only the editor's cursor restoration.
  return render(ui, { router: false });
}
it("replaces the selected comment text and submits the completed draft", async () => {
  using env = setup();
  await using screen = await mount(env.ui);
  const field = screen.container.querySelector("textarea")!;
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
    env.frames.splice(0).forEach((frame) => frame(0));
  });
  expect(field.value).toBe("one new");
  expect(field.selectionStart).toBe(7);
  const submit = [...screen.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Comment",
  )!;
  await act(() => submit.click());
  expect(env.comments).toEqual(["one new"]);
});
it("blocks click and keyboard submission while dictation is running", async () => {
  using env = setup();
  mocks.busy = true;
  await using screen = await mount(env.ui);
  const field = screen.container.querySelector("textarea")!;
  await act(() => mocks.input!.commitDraft("unfinished", { start: 10, end: 10 }));
  expect(field.readOnly).toBe(true);
  const submit = [...screen.container.querySelectorAll("button")].find(
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
  expect(env.comments).toEqual([]);
});
