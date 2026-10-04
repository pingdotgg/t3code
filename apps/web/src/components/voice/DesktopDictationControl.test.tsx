// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { DesktopDictationInput, DesktopDictationResult } from "@t3tools/contracts";
import { DesktopDictationControl } from "./DesktopDictationControl";
import { useDictationSubmission } from "./useDictationSubmission";

const { settings, updateSettings, release, clear } = vi.hoisted(() => ({
  settings: { dictationExecutablePath: "", dictationMicrophoneId: "" },
  updateSettings: vi.fn(async () => {}),
  release: vi.fn(async () => {}),
  clear: vi.fn(),
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: () => settings,
  useUpdateClientSettings: () => updateSettings,
}));
vi.mock("./desktopVoiceCapture", () => ({
  DesktopVoiceRecorder: class {
    uri = "blob:recording";
    prepareToRecordAsync = async () => {};
    record = () => {};
    stop = async () => {};
    release = release;
    clear = clear;
    audio = () => new Uint8Array([1, 2]);
  },
}));

let root: Root;
let container: HTMLDivElement;
function deferredTranscript() {
  let resolve!: (result: DesktopDictationResult) => void;
  const promise = new Promise<DesktopDictationResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let transcript: ReturnType<typeof deferredTranscript>;
const ready: DesktopDictationResult = {
  state: "ready",
  message: "Ready",
  downloadedBytes: 0,
  totalBytes: 0,
};
const sent = vi.fn();
const bridge = vi.fn((input: DesktopDictationInput): Promise<DesktopDictationResult> =>
  input.action === "transcribe" ? transcript.promise : Promise.resolve(ready),
);
const microphone = vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] }));

function Composer({ owner = "environment:thread-a" }: { owner?: string }) {
  const draft = useRef("Existing draft");
  const editor = useRef<HTMLTextAreaElement>(null);
  const submission = useDictationSubmission(owner);
  return (
    <>
      <textarea
        ref={editor}
        aria-label="Draft"
        defaultValue="Existing draft"
        onChange={(event) => {
          draft.current = event.target.value;
        }}
      />
      <button
        disabled={submission.blocked}
        onClick={() => {
          if (submission.isSubmissionBlocked()) return;
          sent(draft.current);
          draft.current = "";
          editor.current!.value = "";
        }}
      >
        Send
      </button>
      <DesktopDictationControl
        key={owner}
        ownerKey={owner}
        disabled={false}
        keybindings={[]}
        onStateChange={submission.onStateChange}
        readDraft={() => ({ text: draft.current, cursor: 8 })}
        insertDraft={(text) => {
          draft.current = text;
          editor.current!.value = text;
        }}
        composerFocused={() => true}
      />
    </>
  );
}

function button(label: string) {
  const match = [...container.querySelectorAll("button")].find(
    (el) => el.getAttribute("aria-label") === label || el.textContent === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}
async function click(label: string) {
  await act(async () => {
    button(label).click();
  });
}
async function render(owner?: string) {
  await act(async () => {
    root.render(<Composer {...(owner ? { owner } : {})} />);
  });
}
function edit(input: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const prototype =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(async () => {
  vi.clearAllMocks();
  settings.dictationExecutablePath = "";
  transcript = deferredTranscript();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("desktopBridge", { dictation: bridge });
  vi.stubGlobal("navigator", {
    platform: "MacIntel",
    mediaDevices: Object.assign(new EventTarget(), {
      getUserMedia: microphone,
      enumerateDevices: async () => [],
    }),
  });
  microphone.mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("blocks sending immediately and throughout transcription, then preserves concurrently typed text", async () => {
  await act(async () => {
    button("Start local voice dictation").click();
    // This runs before React has rendered a disabled Send button.
    button("Send").click();
  });
  expect(sent).not.toHaveBeenCalled();
  expect(button("Send").disabled).toBe(true);
  await click("Stop dictation and transcribe locally");
  expect(button("Send").disabled).toBe(true);
  const draft = container.querySelector("textarea")!;
  await act(async () => edit(draft, "Existing draft plus typing"));
  await click("Send");
  expect(sent).not.toHaveBeenCalled();
  await act(async () => transcript.resolve({ ...ready, state: "completed", transcript: "spoken" }));
  expect(draft.value).toBe("Existing spoken draft plus typing");
  expect(button("Send").disabled).toBe(false);
  expect(sent).not.toHaveBeenCalled();
  await click("Send");
  expect(sent).toHaveBeenCalledExactlyOnceWith("Existing spoken draft plus typing");
  expect(release).toHaveBeenCalled();
  expect(clear).toHaveBeenCalled();
});

it.each(["cancel", "switch thread"])(
  "ignores a late transcript after %s and releases the send gate",
  async (action) => {
    await click("Start local voice dictation");
    await click("Stop dictation and transcribe locally");
    if (action === "cancel") await click("Cancel dictation");
    else await render("environment:thread-b");
    await act(async () =>
      transcript.resolve({ ...ready, state: "completed", transcript: "late result" }),
    );
    expect(container.querySelector("textarea")!.value).toBe("Existing draft");
    expect(button("Send").disabled).toBe(false);
    expect(sent).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenCalledWith(expect.objectContaining({ action: "cancel" }));
    expect(release).toHaveBeenCalled();
  },
);

it("unblocks submission after denied microphone permission without changing the draft", async () => {
  microphone.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
  await click("Start local voice dictation");
  expect(container.textContent).toContain("Microphone permission was denied");
  expect(button("Send").disabled).toBe(false);
  expect(container.querySelector("textarea")!.value).toBe("Existing draft");
  expect(bridge).not.toHaveBeenCalledWith(expect.objectContaining({ action: "transcribe" }));
});

it.each([false, true])(
  "hydrates the executable setting without overwriting a user edit (%s)",
  async (edited) => {
    await click("Dictation settings and status");
    if (edited) await act(async () => edit(container.querySelector("input")!, "/my/whisper-cli"));
    settings.dictationExecutablePath = "/opt/homebrew/bin/whisper-cli";
    await render();
    const expected = edited ? "/my/whisper-cli" : settings.dictationExecutablePath;
    expect(container.querySelector("input")!.value).toBe(expected);
    await click("Save executable path and check");
    expect(updateSettings).toHaveBeenCalledExactlyOnceWith({ dictationExecutablePath: expected });
  },
);
