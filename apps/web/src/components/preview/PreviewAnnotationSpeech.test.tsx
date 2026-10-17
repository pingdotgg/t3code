// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vite-plus/test";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import {
  EnvironmentId,
  ThreadId,
  type DesktopPreviewAnnotationVoiceEvent,
} from "@t3tools/contracts";
import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { useDictationShortcut } from "../../speech/useDictationShortcut";
import { PreviewAnnotationSpeech } from "./PreviewAnnotationSpeech";

const mocks = vi.hoisted(() => ({
  onEvent: null as ((tabId: string, event: DesktopPreviewAnnotationVoiceEvent) => void) | null,
  speech: {
    available: true,
    state: { phase: "idle", error: null, errorAction: null } as VoiceInputState<true>,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    cancel: vi.fn(),
    setup: { open: false },
    transcriptionEnvironmentId: null,
  },
}));
vi.mock("../../speech/useEnvironmentSpeechInput", () => ({
  useEnvironmentSpeechInput: () => mocks.speech,
}));
vi.mock("../../hooks/useSettings", () => ({ useClientSettings: () => "toggle" }));
vi.mock("../../commandPaletteBus", () => ({ isCommandPaletteOpen: () => false }));
vi.mock("../../lib/terminalFocus", () => ({ getTerminalFocusOwner: () => null }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../state/entities", () => ({ useThreadShell: () => null, useProject: () => null }));
vi.mock("../../composerDraftStore", () => ({ useComposerDraftStore: () => null }));
vi.mock("../chat/VoiceInputSetup", () => ({ VoiceInputSetup: () => null }));
vi.mock("../chat/ComposerSpeechButton", () => ({
  resolveSpeechPresentation: () => ({ status: null }),
}));
vi.mock("./previewBridge", () => ({
  previewBridge: {
    annotationVoice: {
      update: vi.fn(async () => {}),
      onEvent: (listener: typeof mocks.onEvent) => {
        mocks.onEvent = listener;
        return () => {
          mocks.onEvent = null;
        };
      },
    },
  },
}));
const main = {
  available: true,
  state: { phase: "idle", error: null, errorAction: null } as VoiceInputState<true>,
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  cancel: vi.fn(),
};
const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
function Editors() {
  const targetRef = useRef<HTMLTextAreaElement | null>(null);
  useDictationShortcut({
    targetRef,
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    speech: main,
    disabled: false,
    terminalOpen: false,
    modelPickerOpen: false,
  });
  return (
    <>
      <textarea ref={targetRef} aria-label="Main" />
      <PreviewAnnotationSpeech
        threadRef={threadRef}
        tabId="tab"
        config={{ sessionId: "session", keybindings: DEFAULT_RESOLVED_KEYBINDINGS }}
      />
    </>
  );
}
function guest(action: DesktopPreviewAnnotationVoiceEvent["action"], key = "d") {
  mocks.onEvent!("tab", {
    sessionId: "session",
    text: "",
    cursor: 0,
    action,
    ...(action === "key"
      ? {
          keyboard: {
            type: "keydown" as const,
            key,
            code: key === "d" ? "KeyD" : "Escape",
            ctrlKey: key === "d",
            shiftKey: key === "d",
            altKey: false,
            metaKey: false,
            repeat: false,
          },
        }
      : {}),
  });
}
function host(key = "d") {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      code: key === "d" ? "KeyD" : "Escape",
      ctrlKey: key === "d",
      shiftKey: key === "d",
      cancelable: true,
    }),
  );
  window.dispatchEvent(
    new KeyboardEvent("keyup", { key, code: key === "d" ? "KeyD" : "Escape", cancelable: true }),
  );
}
let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  main.state = mocks.speech.state = { phase: "idle", error: null, errorAction: null };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => root.render(<Editors />));
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("returns shortcut ownership to the composer and back to the open guest annotation", async () => {
  await act(() => guest("focus"));
  container.querySelector<HTMLTextAreaElement>("textarea")!.focus();
  await act(() => host());
  expect(main.start).toHaveBeenCalledOnce();
  expect(mocks.speech.start).not.toHaveBeenCalled();
  await act(() => {
    guest("focus");
    guest("key");
  });
  expect(mocks.speech.start).toHaveBeenCalledOnce();
  expect(main.start).toHaveBeenCalledOnce();
});
it("cancels annotation recording from the main window after focus moves", async () => {
  mocks.speech.state = { phase: "recording", error: null, errorAction: null };
  await act(() => root.render(<Editors />));
  container.querySelector<HTMLTextAreaElement>("textarea")!.focus();
  await act(() => host("Escape"));
  expect(mocks.speech.cancel).toHaveBeenCalledOnce();
  expect(main.cancel).not.toHaveBeenCalled();
});
it("cancels main-window recording with a forwarded guest Escape", async () => {
  main.state = { phase: "recording", error: null, errorAction: null };
  await act(() => root.render(<Editors />));
  await act(() => {
    guest("focus");
    guest("key", "Escape");
  });
  expect(main.cancel).toHaveBeenCalledOnce();
  expect(mocks.speech.cancel).not.toHaveBeenCalled();
});
