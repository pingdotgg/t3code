import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useBrowserVoiceInput } from "./useBrowserVoiceInput";
import type { BrowserSpeechRecognition } from "./browserVoiceInput";

let recognition: TestRecognition;
class TestRecognition implements BrowserSpeechRecognition {
  lang = "";
  continuous = false;
  interimResults = false;
  onstart: BrowserSpeechRecognition["onstart"] = null;
  onresult: BrowserSpeechRecognition["onresult"] = null;
  onerror: BrowserSpeechRecognition["onerror"] = null;
  onend: BrowserSpeechRecognition["onend"] = null;
  constructor() {
    recognition = this;
  }
  start() {
    this.onstart?.();
  }
  stop() {}
  abort = vi.fn();
  finish() {
    this.onresult?.({ results: [{ isFinal: true, 0: { transcript: "recognized words" } }] });
    this.onend?.();
  }
}
let voice: ReturnType<typeof useBrowserVoiceInput>;
let text: string;
let renderer: ReactTestRenderer;
const sent: string[] = [];
const documentEvents = new EventTarget();
function Composer({
  owner = "thread",
  send = false,
  blocked = false,
  disabled = false,
}: {
  owner?: string;
  send?: boolean;
  blocked?: boolean;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("Existing draft");
  const controller = useBrowserVoiceInput({
    ownerKey: owner,
    text: draft,
    sendImmediately: send,
    disabled,
    readSelection: () => ({ start: draft.length, end: draft.length }),
    commit: setDraft,
    submit: () => {
      if (!blocked && !controller.busy) sent.push(draft);
    },
  });
  useEffect(() => {
    voice = controller;
    text = draft;
  });
  return null;
}
beforeEach(() => {
  sent.length = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { isSecureContext: true, SpeechRecognition: TestRecognition });
  vi.stubGlobal("document", documentEvents);
  vi.stubGlobal("navigator", { language: "en-US" });
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

async function record() {
  await act(() => voice.start());
  await act(() => recognition.finish());
}

describe("browser voice composer integration", () => {
  it("inserts by default, without sending", async () => {
    await act(() => {
      renderer = create(<Composer />);
    });
    await record();
    expect(text).toBe("Existing draft recognized words");
    expect(sent).toEqual([]);
  });
  it("sends the rendered draft once, after the recording lock clears", async () => {
    await act(() => {
      renderer = create(<Composer send />);
    });
    await record();
    await act(() => {
      renderer.update(<Composer send />);
    });
    expect(sent).toEqual(["Existing draft recognized words"]);
  });
  it("does not defer a blocked send until it becomes available", async () => {
    await act(() => {
      renderer = create(<Composer send blocked />);
    });
    await record();
    await act(() => {
      renderer.update(<Composer send />);
    });
    expect(text).toBe("Existing draft recognized words");
    expect(sent).toEqual([]);
  });
  it("captures the setting at the start of the recording", async () => {
    await act(() => {
      renderer = create(<Composer />);
    });
    await act(() => voice.start());
    await act(() => {
      renderer.update(<Composer send />);
    });
    await act(() => recognition.finish());
    expect(text).toBe("Existing draft recognized words");
    expect(sent).toEqual([]);
  });
  it("cancels on a thread switch", async () => {
    await act(() => {
      renderer = create(<Composer send />);
    });
    await act(() => voice.start());
    const ended = recognition.onend;
    await act(() => {
      renderer.update(<Composer send owner="another-thread" />);
    });
    await act(() => ended?.());
    expect(recognition.abort).toHaveBeenCalledOnce();
    expect(sent).toEqual([]);
    expect(text).toBe("Existing draft");
  });
  it("cancels when an approval replaces the composer", async () => {
    await act(() => {
      renderer = create(<Composer send />);
    });
    await act(() => voice.start());
    await act(() => {
      renderer.update(<Composer send disabled />);
    });
    expect(recognition.abort).toHaveBeenCalledOnce();
    expect(voice.busy).toBe(false);
    expect(sent).toEqual([]);
  });
  it("cancels when the page is hidden", async () => {
    await act(() => {
      renderer = create(<Composer send />);
    });
    await act(() => voice.start());
    Object.defineProperty(documentEvents, "hidden", { value: true, configurable: true });
    await act(() => {
      documentEvents.dispatchEvent(new Event("visibilitychange"));
    });
    expect(recognition.abort).toHaveBeenCalledOnce();
    expect(sent).toEqual([]);
  });
});
