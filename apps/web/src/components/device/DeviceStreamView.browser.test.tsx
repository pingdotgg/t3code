import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import "~/index.css";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "~/composerDraftStore";
import { act, render, stubGlobal } from "../../../test/render";

vi.mock(import("~/state/device"), async (original) => ({
  ...(await original()),
  useDeviceHubAccess: () => access,
}));
vi.mock(import("./DevicePhoneViewport"), () => ({
  DevicePhoneViewport: () => <></>,
}));
import { DeviceControlsRail } from "./DeviceControlsRail";
import { DeviceStreamView, type DeviceViewControls } from "./DeviceStreamView";
import type { DeviceControls } from "./useDeviceControls";
import { useDeviceRecording } from "./useDeviceRecording";

const access = { httpBase: "http://test", wsBase: "ws://test", query: {}, credentials: true };
function setup(hub: { screenshot?: Blob; ax?: unknown } = {}) {
  const registry = AtomRegistry.make();
  const touches: unknown[] = [];
  const image = vi.spyOn(HTMLImageElement.prototype, "src", "set").mockImplementation(() => {});
  // Select MJPEG without starting a WebCodecs decoder. Input uses the real stream client.
  const decoder = stubGlobal("VideoDecoder", undefined);
  Reflect.deleteProperty(globalThis, "VideoDecoder");
  const fetch = stubGlobal("fetch", (url: string) =>
    Promise.resolve(
      url.includes("/api/screenshot") && hub.screenshot
        ? new Response(hub.screenshot)
        : url.includes("/ax")
          ? Response.json(hub.ax ?? [])
          : new Response("prime"),
    ),
  );
  // The client opens its input socket only after the MJPEG prime resolves.
  type InputSocket = {
    onmessage?: (event: { data: ArrayBuffer }) => void;
  };
  let open!: (socket: InputSocket) => void;
  const opened = new Promise<InputSocket>((resolve) => {
    open = resolve;
  });
  const socket = stubGlobal(
    "WebSocket",
    class {
      static OPEN = 1;
      readyState = 1;
      constructor() {
        open(this);
      }
      onmessage?: (event: { data: ArrayBuffer }) => void;
      send(message: string | Uint8Array) {
        if (typeof message !== "string" && message[0] === 0x03) {
          touches.push(JSON.parse(new TextDecoder().decode(message.subarray(1))));
        }
      }
      close() {}
    },
  );
  return {
    view: (content = view()) => (
      <RegistryContext.Provider value={registry}>
        <div style={{ width: 400, height: 800 }}>{content}</div>
      </RegistryContext.Provider>
    ),
    [Symbol.dispose]() {
      registry.dispose();
      image.mockRestore();
      socket[Symbol.dispose]();
      fetch[Symbol.dispose]();
      decoder[Symbol.dispose]();
    },
    touches,
    async configure(inputUnavailable = false) {
      const json = new TextEncoder().encode(
        JSON.stringify({ width: 400, height: 800, orientation: "portrait", inputUnavailable }),
      );
      const packet = new Uint8Array(1 + json.length);
      packet[0] = 0x82;
      packet.set(json, 1);
      const input = await opened;
      input.onmessage?.({ data: Uint8Array.of(0x83).buffer });
      input.onmessage?.({ data: packet.buffer });
    },
  };
}

function view() {
  return (
    <DeviceStreamView
      hostId="local"
      environmentId={EnvironmentId.make("test")}
      deviceId="test"
      platform="ios"
      visible
      allowPhoneView={false}
      renderControls={(controls) => (
        <output>
          {controls.handle?.inputConnected ? "Input connected" : "Input disconnected"}
        </output>
      )}
    />
  );
}

// router: false because the device view renders no links and never navigates.
const options = { router: false } as const;

function flatPointer(container: HTMLElement) {
  const surface = container.querySelector("canvas")!.parentElement!.parentElement!;
  // Synthetic IDs exercise concurrent touches independently of the browser's capture state.
  surface.setPointerCapture = () => {};
  const rect = new DOMRect(0, 0, 400, 800);
  surface.getBoundingClientRect = () => rect;
  return {
    send(type: string, pointerId: number, x = 0.25, y = 0.25) {
      surface.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerId,
          pointerType: "touch",
          clientX: rect.left + rect.width * x,
          clientY: rect.top + rect.height * y,
        }),
      );
    },
  };
}

it("keeps the first flat pointer active when a second finger moves and lifts", async () => {
  using input = setup();
  const { configure, touches } = input;
  await using screen = await render(input.view(), options);
  await act(async () => configure());
  await expect.element(screen.getByText("Input connected", { exact: true })).toBeVisible();
  const { send } = flatPointer(screen.container);
  send("pointerdown", 1);
  send("pointerdown", 2, 0.75, 0.75);
  send("pointermove", 2, 0.875, 0.875);
  send("pointerup", 2);
  send("pointercancel", 2);
  send("pointermove", 1, 0.5, 0.5);
  send("pointerup", 1, 0.75, 0.75);
  send("pointermove", 1);
  expect(touches).toEqual([
    { type: "begin", x: 0.25, y: 0.25 },
    { type: "move", x: 0.5, y: 0.5 },
    { type: "end", x: 0.75, y: 0.75 },
  ]);
});

it("ignores a flat pointer that goes down before input connects", async () => {
  using input = setup();
  const { configure, touches } = input;
  await using screen = await render(input.view(), options);
  const { send } = flatPointer(screen.container);
  send("pointerdown", 1);
  await act(async () => configure());
  await expect.element(screen.getByText("Input connected", { exact: true })).toBeVisible();
  send("pointerdown", 2, 0.5, 0.5);
  send("pointerup", 2, 0.75, 0.75);
  expect(touches).toEqual([
    { type: "begin", x: 0.5, y: 0.5 },
    { type: "end", x: 0.75, y: 0.75 },
  ]);
});

it.each(["pointerup", "pointercancel", "lostpointercapture"])(
  "ends the owned flat pointer exactly once on %s, then accepts a new pointer",
  async (ending) => {
    using input = setup();
    const { configure, touches } = input;
    await using screen = await render(input.view(), options);
    await act(async () => configure());
    await expect.element(screen.getByText("Input connected", { exact: true })).toBeVisible();
    const { send } = flatPointer(screen.container);
    send("pointerdown", 7);
    send("pointermove", 7, 0.5, 0.5);
    send("lostpointercapture", 8, 0, 0);
    // Capture loss reports its own point; the end must still use the last move.
    const at = ending === "lostpointercapture" ? 0 : 0.5;
    send(ending, 7, at, at);
    send("lostpointercapture", 7, 0, 0);
    send("pointerup", 7);
    send("pointermove", 7);
    send("pointerdown", 9);
    send("pointerup", 9);
    expect(touches).toEqual([
      { type: "begin", x: 0.25, y: 0.25 },
      { type: "move", x: 0.5, y: 0.5 },
      { type: "end", x: 0.5, y: 0.5 },
      { type: "begin", x: 0.25, y: 0.25 },
      { type: "end", x: 0.25, y: 0.25 },
    ]);
  },
);

it("releases flat pointer ownership when input disconnects", async () => {
  using input = setup();
  await using screen = await render(input.view(), options);
  await act(() => input.configure());
  await expect.element(screen.getByText("Input connected", { exact: true })).toBeVisible();
  const { send } = flatPointer(screen.container);
  send("pointerdown", 1);
  await act(() => input.configure(true));
  await expect.element(screen.getByText("Input disconnected", { exact: true })).toBeVisible();
  await act(() => input.configure());
  await expect.element(screen.getByText("Input connected", { exact: true })).toBeVisible();
  send("pointerdown", 2, 0.5, 0.5);
  send("pointerup", 2, 0.75, 0.75);
  expect(input.touches).toEqual([
    { type: "begin", x: 0.25, y: 0.25 },
    { type: "begin", x: 0.5, y: 0.5 },
    { type: "end", x: 0.75, y: 0.75 },
  ]);
});

const threadRef = { environmentId: EnvironmentId.make("test"), threadId: ThreadId.make("thread") };
const NO_HOST_CONTROLS: DeviceControls = {
  detail: null,
  pending: false,
  error: null,
  act: () => Promise.resolve(false),
  disabled: true,
  foregroundApp: null,
};

function RecordingRail(props: { view: DeviceViewControls }) {
  const recording = useDeviceRecording({
    environmentId: threadRef.environmentId,
    threadRef,
    device: {
      hostId: "local",
      id: "test",
      name: "Phone",
      platform: "ios",
      version: "iOS 19",
      booted: true,
      physical: false,
    },
    access,
    visible: true,
    appId: "com.example.app",
  });
  return (
    <DeviceControlsRail
      platform="ios"
      hostKind={undefined}
      handle={props.view.handle}
      view={props.view}
      controls={NO_HOST_CONTROLS}
      screenshotPending={false}
      onScreenshot={() => {}}
      recording={recording.state}
      onRecord={() => recording.toggle(props.view.handle?.videoSource ?? null)}
      toolsOpen={false}
      onTools={() => {}}
      onFloat={() => {}}
      onClose={() => {}}
      onPowerOff={() => {}}
    />
  );
}

async function screenshotPng() {
  const canvas = document.createElement("canvas");
  canvas.width = 40;
  canvas.height = 80;
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  return blob!;
}

it("records a tap from the rail and hands its step and frames to the composer, unsent", async () => {
  using input = setup({
    screenshot: await screenshotPng(),
    ax: [
      {
        frame: { x: 0, y: 0, width: 400, height: 800 },
        children: [
          { type: "Button", AXLabel: "Settings", frame: { x: 160, y: 320, width: 80, height: 80 } },
        ],
      },
    ],
  });
  // The MJPEG image reports a frame at once, so the stream counts as streaming.
  using _width = vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(400);
  using _height = vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(800);
  useComposerDraftStore.getState().clearDraftThread(threadRef);
  await using screen = await render(
    input.view(
      <DeviceStreamView
        hostId="local"
        environmentId={threadRef.environmentId}
        deviceId="test"
        platform="ios"
        visible
        allowPhoneView={false}
        renderControls={(controls) => <RecordingRail view={controls} />}
      />,
    ),
    options,
  );
  await act(() => input.configure());
  const record = screen.getByRole("button", { name: "Record for agent" });
  await expect.element(record).toBeEnabled();
  await record.click();
  const { send } = flatPointer(screen.container);
  send("pointerdown", 1, 0.5, 0.45);
  send("pointerup", 1, 0.5, 0.45);
  await screen.getByRole("button", { name: "Stop recording and add it to the composer" }).click();
  await expect.element(record).toBeEnabled();

  const draft = useComposerDraftStore.getState().getComposerDraft(threadRef);
  expect(draft?.images.map((image) => image.name)).toEqual(["frame-01.png", "frame-02.png"]);
  const [start, tap] = draft!.images.map((image) => `![${image.name}](t3-context://v1/image/`);
  expect(draft?.prompt).toContain(`Start: ${start}`);
  expect(draft?.prompt).toContain(`1. Tapped button "Settings" → ${tap}`);
  expect(draft?.prompt).toContain("No video: this browser streams the device as still images");
});
