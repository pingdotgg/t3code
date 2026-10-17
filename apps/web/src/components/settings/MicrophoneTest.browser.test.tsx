import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { MicrophoneTest } from "./MicrophoneTest";

vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ control, children }) => (
    <div>
      {control}
      {children}
    </div>
  ),
}));

let root: Root;
let container: HTMLDivElement;
let recorder: TestRecorder;
const stopTrack = vi.fn();
const closeContext = vi.fn(async () => {});
const getUserMedia = vi.fn();
const revokeObjectURL = vi.fn();
const stream = {
  getTracks: () => [{ stop: stopTrack }],
  getAudioTracks: () => [{ addEventListener: vi.fn() }],
};

class TestRecorder extends EventTarget {
  state = "inactive";
  mimeType = "audio/webm";
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    const event = new Event("dataavailable");
    Object.assign(event, { data: new Blob(["audio"], { type: this.mimeType }) });
    this.dispatchEvent(event);
    this.dispatchEvent(new Event("stop"));
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(navigator.mediaDevices, "getUserMedia").mockImplementation(getUserMedia);
  vi.stubGlobal("MediaRecorder", function () {
    recorder = new TestRecorder();
    return recorder;
  });
  vi.stubGlobal(
    "AudioContext",
    class {
      createAnalyser() {
        return {
          fftSize: 256,
          getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.1),
        };
      }
      createMediaStreamSource() {
        return { connect: vi.fn() };
      }
      resume() {
        return Promise.resolve();
      }
      close = closeContext;
    },
  );
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(revokeObjectURL);
  getUserMedia.mockResolvedValue(stream);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function click(label: string) {
  await act(async () => {
    const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(button).not.toBeNull();
    button!.click();
  });
}

it("records the selected mic, stops after ten seconds, and discards playback on retry", async () => {
  await act(async () => {
    root.render(<MicrophoneTest microphoneId="selected" />);
  });
  await click("Test mic");
  expect(getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: "selected" } } });
  await act(async () => {
    vi.advanceTimersByTime(4_000);
  });
  expect(container.querySelector("meter")!.value).toBeGreaterThan(0);
  expect(container.querySelector('[aria-label="Recording time"]')!.textContent).toBe("0:04 / 0:10");
  await act(async () => {
    vi.advanceTimersByTime(6_000);
  });
  expect(container.querySelector("audio")!.getAttribute("src")).toBe("blob:test");
  expect(stopTrack).toHaveBeenCalledTimes(1);
  expect(closeContext).toHaveBeenCalledTimes(1);
  await click("Try again");
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");
  expect(container.querySelector("audio")).toBeNull();
  expect(recorder.state).toBe("recording");
  await act(async () => root.unmount());
  expect(recorder.state).toBe("inactive");
  expect(stopTrack).toHaveBeenCalledTimes(2);
});

it("releases a microphone granted after leaving the page", async () => {
  let grant!: (value: typeof stream) => void;
  getUserMedia.mockReturnValue(
    new Promise<typeof stream>((resolve) => {
      grant = resolve;
    }),
  );
  await act(async () => {
    root.render(<MicrophoneTest microphoneId="" />);
  });
  await click("Test mic");
  await act(async () => root.unmount());
  await act(async () => grant(stream));
  expect(stopTrack).toHaveBeenCalledTimes(1);
  expect(closeContext).not.toHaveBeenCalled();
});

it("shows permission failures and lets the user try again", async () => {
  getUserMedia.mockRejectedValueOnce(new DOMException("Permission denied", "NotAllowedError"));
  await act(async () => {
    root.render(<MicrophoneTest microphoneId="" />);
  });
  await click("Test mic");
  expect(container.querySelector('[role="status"]')!.getAttribute("aria-label")).toBe(
    "Microphone access is required for voice input. Allow access in your browser or system settings and try again.",
  );
  await click("Record again");
  expect(recorder.state).toBe("recording");
  await click("Stop recording");
  await click("Done");
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");
  expect(container.querySelector("audio")).toBeNull();
});

it("reports unavailable capture and can retry after microphone support becomes available", async () => {
  vi.stubGlobal("MediaRecorder", undefined);
  await act(async () => {
    root.render(<MicrophoneTest microphoneId="" />);
  });
  await click("Test mic");
  expect(container.querySelector('[role="status"]')!.getAttribute("aria-label")).toBe(
    "Microphone testing is unavailable in this browser. Use HTTPS or the desktop app.",
  );
  expect(getUserMedia).not.toHaveBeenCalled();
  vi.stubGlobal("MediaRecorder", function () {
    recorder = new TestRecorder();
    return recorder;
  });
  await click("Record again");
  expect(recorder.state).toBe("recording");
});
