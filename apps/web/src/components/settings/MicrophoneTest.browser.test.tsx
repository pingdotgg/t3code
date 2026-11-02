import { act, render, fakeTimers, stubGlobal } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";

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

function setup() {
  const scope = new DisposableStack();
  let recorder: TestRecorder;
  const stopTrack = vi.fn();
  const closeContext = vi.fn(async () => {});
  const getUserMedia = vi.fn();
  const revokeObjectURL = vi.fn();
  const stream = {
    getTracks: () => [{ stop: stopTrack }],
    getAudioTracks: () => [{ addEventListener: vi.fn() }],
  };
  scope.use(vi.spyOn(navigator.mediaDevices, "getUserMedia").mockImplementation(getUserMedia));
  scope.use(
    stubGlobal("MediaRecorder", function () {
      recorder = new TestRecorder();
      return recorder;
    }),
  );
  scope.use(
    stubGlobal(
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
    ),
  );
  scope.use(vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test"));
  scope.use(vi.spyOn(URL, "revokeObjectURL").mockImplementation(revokeObjectURL));
  getUserMedia.mockResolvedValue(stream);
  return {
    [Symbol.dispose]() {
      scope.dispose();
    },
    get recorder() {
      return recorder;
    },
    stopTrack,
    closeContext,
    getUserMedia,
    revokeObjectURL,
    stream,
  };
}

async function click(container: HTMLElement, label: string) {
  await act(async () => {
    const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(button).not.toBeNull();
    button!.click();
  });
}

it("records the selected mic, stops after ten seconds, and discards playback on retry", async () => {
  using native = setup();
  const { stopTrack, closeContext, getUserMedia, revokeObjectURL } = native;
  await using screen = await render(<MicrophoneTest microphoneId="selected" />);
  const { container } = screen;
  using _timers = fakeTimers();
  await click(container, "Test mic");
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
  await click(container, "Try again");
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");
  expect(container.querySelector("audio")).toBeNull();
  expect(native.recorder.state).toBe("recording");
  await screen.unmount();
  expect(native.recorder.state).toBe("inactive");
  expect(stopTrack).toHaveBeenCalledTimes(2);
});

it("releases a microphone granted after leaving the page", async () => {
  using native = setup();
  const { stopTrack, closeContext, getUserMedia, stream } = native;
  let grant!: (value: typeof stream) => void;
  getUserMedia.mockReturnValue(
    new Promise<typeof stream>((resolve) => {
      grant = resolve;
    }),
  );
  await using screen = await render(<MicrophoneTest microphoneId="" />);
  const { container } = screen;
  using _timers = fakeTimers();
  await click(container, "Test mic");
  await screen.unmount();
  await act(async () => grant(stream));
  expect(stopTrack).toHaveBeenCalledTimes(1);
  expect(closeContext).not.toHaveBeenCalled();
});

it("shows permission failures and lets the user try again", async () => {
  using native = setup();
  const { getUserMedia, revokeObjectURL } = native;
  getUserMedia.mockRejectedValueOnce(new DOMException("Permission denied", "NotAllowedError"));
  await using screen = await render(<MicrophoneTest microphoneId="" />);
  const { container } = screen;
  using _timers = fakeTimers();
  await click(container, "Test mic");
  expect(container.querySelector('[role="status"]')!.getAttribute("aria-label")).toBe(
    "Microphone access is required for voice input. Allow access in your browser or system settings and try again.",
  );
  await click(container, "Record again");
  expect(native.recorder.state).toBe("recording");
  await click(container, "Stop recording");
  await click(container, "Done");
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");
  expect(container.querySelector("audio")).toBeNull();
});

it("reports unavailable capture and can retry after microphone support becomes available", async () => {
  using native = setup();
  const { getUserMedia } = native;
  using unavailable = stubGlobal("MediaRecorder", undefined);
  await using screen = await render(<MicrophoneTest microphoneId="" />);
  const { container } = screen;
  using _timers = fakeTimers();
  await click(container, "Test mic");
  expect(container.querySelector('[role="status"]')!.getAttribute("aria-label")).toBe(
    "Microphone testing is unavailable in this browser. Use HTTPS or the desktop app.",
  );
  expect(getUserMedia).not.toHaveBeenCalled();
  unavailable[Symbol.dispose]();
  await click(container, "Record again");
  expect(native.recorder.state).toBe("recording");
});
