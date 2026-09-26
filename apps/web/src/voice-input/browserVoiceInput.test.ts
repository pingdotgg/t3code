import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  BrowserVoiceInputController,
  browserVoiceSupport,
  type BrowserSpeechRecognition,
} from "./browserVoiceInput";
import type { VoiceDraftSnapshot, VoiceInputState } from "@t3tools/client-runtime/voice-input";

class Recognition implements BrowserSpeechRecognition {
  lang = "";
  continuous = false;
  interimResults = false;
  onstart: BrowserSpeechRecognition["onstart"] = null;
  onresult: BrowserSpeechRecognition["onresult"] = null;
  onerror: BrowserSpeechRecognition["onerror"] = null;
  onend: BrowserSpeechRecognition["onend"] = null;
  start = vi.fn(() => this.onstart?.());
  stop = vi.fn();
  abort = vi.fn();
  results(...transcripts: string[]) {
    this.onresult?.({
      results: transcripts.map((transcript) => ({ isFinal: true, 0: { transcript } })),
    });
  }
}

const controllers: BrowserVoiceInputController[] = [];
function harness() {
  const recognition = new Recognition();
  let draft: VoiceDraftSnapshot = {
    ownerKey: "environment:thread",
    text: "Hello world",
    selection: { start: 6, end: 11 },
    revision: 0,
  };
  let state: VoiceInputState | undefined;
  const commit = vi.fn();
  const controller = new BrowserVoiceInputController({
    create: () => recognition,
    readDraft: () => draft,
    commit,
    onState: (next) => {
      state = next;
    },
  });
  controllers.push(controller);
  return {
    controller,
    recognition,
    commit,
    state: () => state,
    changeDraft: (patch: Partial<VoiceDraftSnapshot>) => {
      draft = { ...draft, ...patch };
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.cancel();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("browser voice input", () => {
  it("replaces the captured selection once, preserving the rest of the draft", () => {
    const h = harness();
    h.controller.start("en-US", false);
    h.recognition.results("team");
    h.recognition.results("team");
    const ended = h.recognition.onend;
    h.controller.stop();
    expect(h.state()?.phase).toBe("transcribing");
    expect(h.commit).not.toHaveBeenCalled();
    ended?.();
    ended?.();
    expect(h.commit).toHaveBeenCalledExactlyOnceWith("Hello team", 10, false);
    expect(h.state()?.phase).toBe("idle");
  });
  it("handles a browser ending speech naturally and keeps the captured send choice", () => {
    const h = harness();
    h.controller.start("en-US", true);
    h.controller.start("fr-FR", false);
    h.recognition.results("one ", "two");
    h.recognition.onend?.();
    expect(h.recognition.lang).toBe("en-US");
    expect(h.commit).toHaveBeenCalledExactlyOnceWith("Hello one two", 13, true);
  });
  it.each([{ ownerKey: "other:thread" }, { text: "Changed draft" }, { revision: 2 }])(
    "does not overwrite a changed draft (%j)",
    (patch) => {
      const h = harness();
      h.controller.start("en-US", true);
      h.recognition.results("team");
      h.changeDraft(patch);
      h.recognition.onend?.();
      expect(h.commit).not.toHaveBeenCalled();
      expect(h.state()?.error).toContain("draft changed");
    },
  );
  it("preserves the recognizer's spacing for languages without word separators", () => {
    const h = harness();
    h.changeDraft({ text: "", selection: { start: 0, end: 0 } });
    h.controller.start("zh-CN", false);
    h.recognition.results("你", "好");
    h.recognition.onend?.();
    expect(h.commit).toHaveBeenCalledExactlyOnceWith("你好", 2, false);
  });
  it("discards late results after cancellation and permits another recording", () => {
    const h = harness();
    h.controller.start("en-US", true);
    const ended = h.recognition.onend;
    const result = h.recognition.onresult;
    h.controller.cancel();
    result?.({ results: [{ isFinal: true, 0: { transcript: "late" } }] });
    ended?.();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.recognition.abort).toHaveBeenCalledOnce();
    h.controller.start("en-US", false);
    h.recognition.results("again");
    h.recognition.onend?.();
    expect(h.commit).toHaveBeenCalledExactlyOnceWith("Hello again", 11, false);
  });
  it.each(["not-allowed", "audio-capture", "network", "language-not-supported"])(
    "keeps the draft on %s",
    (error) => {
      const h = harness();
      h.controller.start("en-US", true);
      const ended = h.recognition.onend;
      h.recognition.results("partial speech");
      h.recognition.onerror?.({ error });
      ended?.();
      expect(h.commit).not.toHaveBeenCalled();
      expect(h.state()?.phase).toBe("error");
      expect(h.controller.busy).toBe(false);
    },
  );
  it("does not submit empty or interim-only results", () => {
    const h = harness();
    h.controller.start("en-US", true);
    h.recognition.onresult?.({ results: [{ isFinal: false, 0: { transcript: "interim" } }] });
    h.recognition.onend?.();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.state()?.error).toContain("No speech");
  });
  it("limits recording and releases a browser that never finishes", () => {
    const h = harness();
    h.controller.start("en-US", true);
    vi.advanceTimersByTime(5 * 60 * 1_000);
    expect(h.recognition.stop).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(15_000);
    expect(h.recognition.abort).toHaveBeenCalledOnce();
    expect(h.state()?.phase).toBe("error");
    expect(h.commit).not.toHaveBeenCalled();
  });
  it("prevents two composers from recording at once", () => {
    const first = harness();
    const second = harness();
    first.controller.start("en-US", false);
    second.controller.start("en-US", false);
    expect(second.recognition.start).not.toHaveBeenCalled();
    first.controller.cancel();
    second.controller.start("en-US", false);
    expect(second.recognition.start).toHaveBeenCalledOnce();
  });
  it("recovers when the browser throws while starting", () => {
    const h = harness();
    h.recognition.start.mockImplementationOnce(() => {
      throw new Error("start failed");
    });
    h.controller.start("en-US", true);
    expect(h.controller.busy).toBe(false);
    expect(h.state()?.phase).toBe("error");
    h.controller.start("en-US", false);
    expect(h.state()?.phase).toBe("recording");
  });
});

describe("browser voice support", () => {
  it.each(["SpeechRecognition", "webkitSpeechRecognition"])(
    "supports %s on a secure origin",
    (key) => {
      vi.stubGlobal("window", { isSecureContext: true, [key]: Recognition });
      expect(browserVoiceSupport().create?.()).toBeInstanceOf(Recognition);
    },
  );
  it.each([
    [{ isSecureContext: false, SpeechRecognition: Recognition }, "HTTPS"],
    [{ isSecureContext: true }, "does not support"],
    [{ isSecureContext: true, desktopBridge: {}, SpeechRecognition: Recognition }, "Desktop"],
  ])("explains unsupported clients", (window, reason) => {
    vi.stubGlobal("window", window);
    expect(browserVoiceSupport().create).toBeNull();
    expect(browserVoiceSupport().unavailableReason).toContain(reason);
  });
});
