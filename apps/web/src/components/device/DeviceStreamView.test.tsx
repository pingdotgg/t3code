import { act, useEffect, useSyncExternalStore } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const accessStore = {
  value: { httpBase: "http://test", wsBase: "ws://test", query: {}, credentials: true },
  listeners: new Set<() => void>(),
  refresh() {
    accessStore.value = { ...accessStore.value };
    for (const listener of accessStore.listeners) listener();
  },
  subscribe(listener: () => void) {
    accessStore.listeners.add(listener);
    return () => accessStore.listeners.delete(listener);
  },
};
vi.mock("~/state/device", () => ({
  useDeviceHubAccess: () => useSyncExternalStore(accessStore.subscribe, () => accessStore.value),
  refreshDeviceHubAccess: () => accessStore.refresh(),
}));
let viewerMounts = 0;
let viewerUnmounts = 0;
vi.mock("./DevicePhoneViewport", () => ({
  DevicePhoneViewport: function Viewer() {
    useEffect(() => {
      viewerMounts++;
      return () => {
        viewerUnmounts++;
      };
    }, []);
    return null;
  },
}));
import { DeviceStreamView } from "./DeviceStreamView";

class Image extends EventTarget {
  src = "";
  naturalWidth = 0;
  naturalHeight = 0;
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
}
let renderer: ReactTestRenderer | undefined;
let primes = 0;
beforeEach(() => {
  primes = 0;
  viewerMounts = 0;
  viewerUnmounts = 0;
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function setup(h264 = false) {
  const touches: unknown[] = [];
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let videoBody: ReadableStreamDefaultController<Uint8Array> | undefined;
  let output: VideoFrameOutputCallback | undefined;
  if (h264) {
    vi.stubGlobal(
      "VideoDecoder",
      class {
        static isConfigSupported = async () => ({ supported: true });
        state = "unconfigured";
        constructor(callbacks: VideoDecoderInit) {
          output = callbacks.output;
        }
        configure() {
          this.state = "configured";
        }
        close() {
          this.state = "closed";
        }
      },
    );
    vi.stubGlobal("EncodedVideoChunk", vi.fn());
  }
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    if (url.endsWith("stream.avcc")) {
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              videoBody = controller;
              init.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
            },
          }),
        ),
      );
    }
    primes++;
    return Promise.resolve(new Response("prime"));
  });
  const sockets: Array<{ onmessage?: (event: { data: ArrayBuffer }) => void }> = [];
  vi.stubGlobal(
    "WebSocket",
    class {
      static OPEN = 1;
      readyState = 1;
      constructor() {
        sockets.push(this);
      }
      onmessage?: (event: { data: ArrayBuffer }) => void;
      send(packet: Uint8Array) {
        if (packet[0] === 0x03) {
          touches.push(JSON.parse(new TextDecoder().decode(packet.subarray(1))));
        }
      }
      close() {}
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const images: Image[] = [];
  const view = (visible: boolean) => (
    <DeviceStreamView
      hostId="local"
      environmentId={EnvironmentId.make("test")}
      deviceId="test"
      platform="ios"
      visible={visible}
      allowPhoneView={h264}
    />
  );
  await act(async () => {
    renderer = create(view(true), {
      createNodeMock: (node) => {
        if (node.type === "img") {
          const image = new Image();
          images.push(image);
          return image;
        }
        return {
          getContext: () => ({ drawImage() {} }),
          style: { setProperty() {} },
          getBoundingClientRect: () => ({ width: 400, height: 800 }),
        };
      },
    });
  });
  return {
    images,
    view,
    touches,
    configure() {
      const json = new TextEncoder().encode(
        JSON.stringify({ width: 400, height: 800, orientation: "portrait" }),
      );
      const packet = new Uint8Array(1 + json.length);
      packet[0] = 0x82;
      packet.set(json, 1);
      sockets[0]?.onmessage?.({ data: Uint8Array.of(0x83).buffer });
      sockets[0]?.onmessage?.({ data: packet.buffer });
      videoBody?.enqueue(new Uint8Array([0, 0, 0, 5, 1, 1, 0x64, 0, 0x1f]));
    },
    frame() {
      output?.({ displayWidth: 400, displayHeight: 800, close() {} } as VideoFrame);
    },
  };
}

it.each([1, 2])(
  "ignores button %i gestures and still forwards the next primary drag",
  async (button) => {
    const { touches, configure } = await setup();
    await act(async () => configure());
    const viewport = renderer!.root.findByType("canvas").parent!;
    const currentTarget = {
      setPointerCapture() {},
      parentElement: { focus() {} },
      getBoundingClientRect: () => ({ left: 20, top: 40, width: 400, height: 800 }),
    };
    const event = { button, pointerId: 1, currentTarget, clientX: 120, clientY: 640 };
    await act(async () => {
      viewport.props.onPointerDown(event);
      viewport.props.onPointerMove({ ...event, clientY: 240 });
      viewport.props.onPointerUp({ ...event, clientY: 240 });
    });
    expect(touches).toEqual([]);

    await act(async () => {
      viewport.props.onPointerDown({ ...event, button: 0 });
      viewport.props.onPointerMove({ ...event, button: 0, clientY: 240 });
      viewport.props.onPointerUp({ ...event, button: 0, clientY: 240 });
      viewport.props.onPointerMove({ ...event, button: 0, clientY: 440 });
    });
    expect(touches).toEqual([
      { type: "begin", x: 0.25, y: 0.75 },
      { type: "move", x: 0.25, y: 0.25 },
      { type: "end", x: 0.25, y: 0.25 },
    ]);
  },
);

it("removes MJPEG requests while hidden and reconnects when shown", async () => {
  const { images, view } = await setup();
  expect(images[0]!.src).toContain("stream.mjpeg");
  await act(async () => renderer!.update(view(false)));
  expect(renderer!.root.findAllByType("img")).toHaveLength(0);
  expect(images[0]!.src).toBe("");
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => renderer!.update(view(true)));
  expect(images.at(-1)!.src).toContain("stream.mjpeg");
});

it("offers Reconnect after the shared timeout and receives a frame after retry with unchanged access", async () => {
  const { images } = await setup();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(
    renderer!.root.findByProps({ role: "alert" }).findByType("span").children.join(""),
  ).toContain("No video");
  expect(images[0]!.src).toBe("");
  await act(async () => renderer!.root.findByType("button").props.onClick());
  expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
  expect(images[1]!.src).toContain("stream.mjpeg");
  await act(async () => {
    images[1]!.naturalWidth = 400;
    images[1]!.naturalHeight = 800;
    images[1]!.dispatchEvent(new Event("load"));
  });
  expect(renderer!.root.findAllByProps({ role: "status" })).toHaveLength(0);
  expect(renderer!.root.findAllByType("button")).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("starts exactly one new stream per Reconnect press", async () => {
  await setup();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(primes).toBe(1);
  await act(async () => renderer!.root.findByType("button").props.onClick());
  expect(primes).toBe(2);
});

it("keeps the 3D viewer mounted across iOS video recovery and releases it when hidden", async () => {
  const { configure, frame, view } = await setup(true);
  await act(async () => configure());
  expect(viewerMounts).toBe(0);
  await act(async () => frame());
  expect(viewerMounts).toBe(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(viewerUnmounts).toBe(0);
  expect(viewerMounts).toBe(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
    configure();
  });
  await act(async () => frame());
  expect(viewerMounts).toBe(1);
  await act(async () => renderer!.update(view(false)));
  expect(viewerUnmounts).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});
