import { describe, expect, it } from "vite-plus/test";

import { appendVoiceTranscript, resolveVoiceTranscriptionAction } from "./voiceTranscription.js";

describe("appendVoiceTranscript", () => {
  it("appends trimmed speech to an empty draft", () => {
    expect(appendVoiceTranscript("", "  hello  ")).toBe("hello");
  });

  it("adds one boundary space after existing text", () => {
    expect(appendVoiceTranscript("existing", "speech")).toBe("existing speech");
  });

  it("preserves an existing whitespace boundary", () => {
    expect(appendVoiceTranscript("existing\n", " speech ")).toBe("existing\nspeech");
  });

  it("ignores an empty transcript", () => {
    expect(appendVoiceTranscript("existing", "   ")).toBe("existing");
  });
});

describe("resolveVoiceTranscriptionAction", () => {
  it("upgrades insert to send", () => {
    expect(resolveVoiceTranscriptionAction("insert", "send")).toBe("send");
  });

  it("does not downgrade send to insert", () => {
    expect(resolveVoiceTranscriptionAction("send", "insert")).toBe("send");
  });

  it("lets cancellation win", () => {
    expect(resolveVoiceTranscriptionAction("send", "abort")).toBe("abort");
    expect(resolveVoiceTranscriptionAction("abort", "send")).toBe("abort");
  });
});
