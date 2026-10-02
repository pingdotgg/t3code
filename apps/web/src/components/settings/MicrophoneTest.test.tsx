import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { MicrophoneTest } from "./MicrophoneTest";

vi.mock("./settingsSearch", () => ({ searchableSetting: () => ({}) }));
vi.mock("~/hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({ control, children }: { control: ReactNode; children: ReactNode }) =>
    createElement("div", null, control, children),
}));

let root: ReactTestRenderer;
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
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
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
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:test"), revokeObjectURL });
  getUserMedia.mockResolvedValue(stream);
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function click(label: string) {
  await act(async () => {
    root.root
      .findAllByType("button")
      .find((button) => (button.props["aria-label"] ?? button.props.children) === label)
      ?.props.onClick();
  });
}

it("records the selected mic, stops after ten seconds, and discards playback on retry", async () => {
  await act(async () => {
    root = create(createElement(MicrophoneTest, { microphoneId: "selected" }));
  });
  await click("Test mic");
  expect(getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: "selected" } } });
  await act(async () => {
    vi.advanceTimersByTime(4_000);
  });
  expect(root.root.findByType("meter").props.value).toBeGreaterThan(0);
  expect(root.root.findByProps({ "aria-label": "Recording time" }).children.join("")).toBe(
    "0:04 / 0:10",
  );
  await act(async () => {
    vi.advanceTimersByTime(6_000);
  });
  expect(root.root.findByType("audio").props.src).toBe("blob:test");
  expect(stopTrack).toHaveBeenCalledTimes(1);
  expect(closeContext).toHaveBeenCalledTimes(1);
  await click("Try again");
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");
  expect(root.root.findAllByType("audio")).toHaveLength(0);
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
    root = create(createElement(MicrophoneTest, { microphoneId: "" }));
  });
  await click("Test mic");
  await act(async () => root.unmount());
  await act(async () => grant(stream));
  expect(stopTrack).toHaveBeenCalledTimes(1);
  expect(closeContext).not.toHaveBeenCalled();
});

it("shows permission failures and lets the user try again", async () => {
  getUserMedia.mockRejectedValueOnce(new Error("Microphone permission denied"));
  await act(async () => {
    root = create(createElement(MicrophoneTest, { microphoneId: "" }));
  });
  await click("Test mic");
  expect(root.root.findByProps({ role: "alert" }).props.children).toBe(
    "Microphone permission denied",
  );
  await click("Test mic");
  expect(recorder.state).toBe("recording");
  await click("Stop recording");
  await click("Done");
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");
  expect(root.root.findAllByType("audio")).toHaveLength(0);
});
