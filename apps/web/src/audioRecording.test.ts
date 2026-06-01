import { afterEach, describe, expect, it, vi } from "vitest";
import { getAudioRecordingUnavailableReason, isAudioRecordingSupported } from "./audioRecording";

function fakeRecorder() {
  return {};
}

function fakeAudioContext() {
  return {};
}

function stubSecureWindow(overrides: Record<string, unknown> = {}) {
  vi.stubGlobal("window", {
    isSecureContext: true,
    ...overrides,
  });
}

describe("audio recording support detection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires microphone capture", () => {
    stubSecureWindow();
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("MediaRecorder", fakeRecorder);

    expect(isAudioRecordingSupported()).toBe(false);
    expect(getAudioRecordingUnavailableReason()).toContain("microphone capture");
  });

  it("requires a secure browser context", () => {
    stubSecureWindow({ isSecureContext: false });
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(),
      },
    });
    vi.stubGlobal("MediaRecorder", fakeRecorder);

    expect(isAudioRecordingSupported()).toBe(false);
    expect(getAudioRecordingUnavailableReason()).toContain("requires HTTPS");
  });

  it("supports native MediaRecorder", () => {
    stubSecureWindow();
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(),
      },
    });
    vi.stubGlobal("MediaRecorder", fakeRecorder);

    expect(isAudioRecordingSupported()).toBe(true);
  });

  it("supports Web Audio fallback recording when MediaRecorder is missing", () => {
    stubSecureWindow({
      webkitAudioContext: fakeAudioContext,
    });
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(),
      },
    });
    vi.stubGlobal("MediaRecorder", undefined);

    expect(isAudioRecordingSupported()).toBe(true);
  });
});
