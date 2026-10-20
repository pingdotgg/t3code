import { useEffect, useSyncExternalStore } from "react";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render, stubGlobal } from "../../../test/render";

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
vi.mock(import("~/state/device"), async (original) => ({
  ...(await original()),
  useDeviceHubAccess: () => useSyncExternalStore(accessStore.subscribe, () => accessStore.value),
  refreshDeviceHubAccess: () => accessStore.refresh(),
}));
let viewerMounts = 0;
let viewerUnmounts = 0;
// The 3D phone frame needs WebGL; the test only cares whether it stays mounted.
vi.mock(import("./DevicePhoneViewport"), async (original) => ({
  ...(await original()),
  DevicePhoneViewport: function Viewer(): React.ReactElement {
    useEffect(() => {
      viewerMounts++;
      return () => {
        viewerUnmounts++;
      };
    }, []);
    return <></>;
  },
}));
import { pasteTextToFocusComposer } from "../chat/composerFocusRedirect";
import { DeviceStreamView } from "./DeviceStreamView";

// MJPEG frames come from the device hub, so images keep their src without loading it and a
// test publishes a frame by setting the natural size and firing "load".
const imageSources = new WeakMap<HTMLImageElement, string>();
const framedImages = new WeakSet<HTMLImageElement>();
let images: HTMLImageElement[] = [];
const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")!;
const naturalWidthDescriptor = Object.getOwnPropertyDescriptor(
  HTMLImageElement.prototype,
  "naturalWidth",
)!;
const naturalHeightDescriptor = Object.getOwnPropertyDescriptor(
  HTMLImageElement.prototype,
  "naturalHeight",
)!;
const removeAttribute = Element.prototype.removeAttribute;
function stubImages() {
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    configurable: true,
    get(this: HTMLImageElement) {
      return imageSources.get(this) ?? "";
    },
    set(this: HTMLImageElement, value: string) {
      if (!images.includes(this)) images.push(this);
      imageSources.set(this, value);
    },
  });
  for (const name of ["naturalWidth", "naturalHeight"]) {
    Object.defineProperty(HTMLImageElement.prototype, name, {
      configurable: true,
      get(this: HTMLImageElement) {
        if (!framedImages.has(this)) return 0;
        return name === "naturalWidth" ? 400 : 800;
      },
    });
  }
  Element.prototype.removeAttribute = function (this: Element, name: string) {
    if (this instanceof HTMLImageElement && name === "src") imageSources.delete(this);
    return removeAttribute.call(this, name);
  };
}
function restoreImages() {
  Object.defineProperty(HTMLImageElement.prototype, "src", srcDescriptor);
  Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", naturalWidthDescriptor);
  Object.defineProperty(HTMLImageElement.prototype, "naturalHeight", naturalHeightDescriptor);
  Element.prototype.removeAttribute = removeAttribute;
}
async function publishFrame(image: HTMLImageElement) {
  framedImages.add(image);
  await act(async () => image.dispatchEvent(new Event("load")));
}
let container: HTMLDivElement;
let primes = 0;

async function setup(h264 = false, platform: "ios" | "android" = "ios") {
  primes = 0;
  viewerMounts = 0;
  viewerUnmounts = 0;
  images = [];
  await using stack = new AsyncDisposableStack();
  stubImages();
  stack.defer(restoreImages);
  stack.use(fakeTimers());
  const touches: unknown[] = [];
  let videoBody: ReadableStreamDefaultController<Uint8Array> | undefined;
  let output: VideoFrameOutputCallback | undefined;
  if (h264) {
    stack.use(
      stubGlobal(
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
      ),
    );
    stack.use(stubGlobal("EncodedVideoChunk", vi.fn()));
  } else {
    // Without WebCodecs the iOS client streams MJPEG.
    const videoDecoder = Object.getOwnPropertyDescriptor(globalThis, "VideoDecoder");
    if (videoDecoder) {
      Reflect.deleteProperty(globalThis, "VideoDecoder");
      stack.defer(() => {
        Object.defineProperty(globalThis, "VideoDecoder", videoDecoder);
      });
    }
  }
  stack.use(
    stubGlobal("fetch", (url: string, init: RequestInit) => {
      if (url.endsWith("stream.avcc")) {
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                videoBody = controller;
                init.signal?.addEventListener("abort", () =>
                  controller.error(new Error("aborted")),
                );
              },
            }),
          ),
        );
      }
      primes++;
      return Promise.resolve(new Response("prime"));
    }),
  );
  const sockets: Array<{ onmessage?: (event: { data: ArrayBuffer }) => void }> = [];
  const sent: unknown[] = [];
  stack.use(
    stubGlobal(
      "WebSocket",
      class {
        static OPEN = 1;
        readyState = 1;
        constructor() {
          sockets.push(this);
        }
        onmessage?: (event: { data: ArrayBuffer }) => void;
        send(message: string | Uint8Array) {
          if (typeof message === "string") {
            sent.push(message);
          } else if (message[0] === 0x03) {
            touches.push(JSON.parse(new TextDecoder().decode(message.subarray(1))));
          }
        }
        close() {}
      },
    ),
  );
  const view = (visible: boolean) => (
    <DeviceStreamView
      hostId="local"
      environmentId={EnvironmentId.make("test")}
      deviceId="test"
      platform={platform}
      visible={visible}
      allowPhoneView={h264}
    />
  );
  container = document.createElement("div");
  container.style.cssText = "width: 400px; height: 800px; display: flex";
  const screen = stack.use(await render(view(true), { container }));
  const environment = stack.move();
  return {
    images,
    show: (visible: boolean) => screen.rerender(view(visible)),
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
    sent,
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
      const source = new OffscreenCanvas(400, 800);
      source.getContext("2d")!.fillRect(0, 0, 400, 800);
      output?.(new VideoFrame(source, { timestamp: 0 }));
    },
  };
}

const alert = () => container.querySelector('[role="alert"]');
const reconnect = () =>
  act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Reconnect"))!
      .click(),
  );

it.each([
  { name: "middle", button: 1, buttons: 4 },
  { name: "right", button: 2, buttons: 2 },
])("ignores $name-button drags and forwards the next primary drag", async ({ button, buttons }) => {
  await using stream = await setup();
  const { touches, configure } = stream;
  await act(async () => configure());
  const viewport = container.querySelector("canvas")!.parentElement!;
  viewport.style.width = "400px";
  viewport.style.height = "800px";
  // Synthetic pointer events do not register an active browser pointer to capture.
  viewport.setPointerCapture = () => {};
  const rect = viewport.getBoundingClientRect();
  const pointer = (type: string, button: number, buttons: number, y: number) =>
    viewport.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        pointerId: 1,
        pointerType: "mouse",
        button,
        buttons,
        clientX: rect.left + 100,
        clientY: rect.top + y,
      }),
    );

  await act(async () => {
    pointer("pointerdown", button, buttons, 600);
    pointer("pointermove", -1, buttons, 200);
    pointer("pointerup", button, 0, 200);
  });
  expect(touches).toEqual([]);

  await act(async () => {
    pointer("pointerdown", 0, 1, 600);
    pointer("pointermove", -1, 1, 200);
    pointer("pointerup", 0, 0, 200);
    pointer("pointermove", -1, 0, 400);
  });
  expect(touches).toEqual([
    { type: "begin", x: 0.25, y: 0.75 },
    { type: "move", x: 0.25, y: 0.25 },
    { type: "end", x: 0.25, y: 0.25 },
  ]);
});

it("removes MJPEG requests while hidden and reconnects when shown", async () => {
  await using stream = await setup();
  const { images, show } = stream;
  expect(images[0]!.src).toContain("stream.mjpeg");
  await show(false);
  expect(container.querySelectorAll("img")).toHaveLength(0);
  expect(images[0]!.src).toBe("");
  expect(vi.getTimerCount()).toBe(0);
  await show(true);
  expect(images.at(-1)!.src).toContain("stream.mjpeg");
});

it("offers Reconnect after the shared timeout and receives a frame after retry with unchanged access", async () => {
  await using stream = await setup();
  const { images } = stream;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(alert()?.textContent).toContain("No video");
  expect(images[0]!.src).toBe("");
  await reconnect();
  expect(alert()).toBeNull();
  expect(images[1]!.src).toContain("stream.mjpeg");
  await publishFrame(images[1]!);
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(container.querySelectorAll("button")).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("starts exactly one new stream per Reconnect press", async () => {
  await using _stream = await setup();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(primes).toBe(1);
  await reconnect();
  expect(primes).toBe(2);
});

it("keeps the 3D viewer mounted across iOS video recovery and releases it when hidden", async () => {
  await using stream = await setup(true);
  const { configure, frame, show } = stream;
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
  await show(false);
  expect(viewerUnmounts).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("types a paste on the Android screen into the device and lets Ctrl+V reach the paste", async () => {
  await using stream = await setup(true, "android");
  const { sent } = stream;
  const screen = container.querySelector<HTMLElement>('[role="application"]')!;
  screen.focus();
  expect(document.activeElement).toBe(screen);
  const chord = new KeyboardEvent("keydown", {
    key: "v",
    code: "KeyV",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  screen.dispatchEvent(chord);
  expect(chord.defaultPrevented).toBe(false);
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", "pässwörd 1");
  const composerPastes: Array<string | null> = [];
  const capturePaste = (event: ClipboardEvent) =>
    composerPastes.push(pasteTextToFocusComposer(event));
  window.addEventListener("paste", capturePaste, true);
  using _paste = {
    [Symbol.dispose]: () => window.removeEventListener("paste", capturePaste, true),
  };
  const paste = new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true });
  screen.dispatchEvent(paste);
  expect(paste.defaultPrevented).toBe(true);
  expect(sent.map((message) => JSON.parse(message as string) as unknown)).toEqual([
    { type: "text", text: "pässwörd 1" },
  ]);
  expect(composerPastes).toEqual([null]);
});
