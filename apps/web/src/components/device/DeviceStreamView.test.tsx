import { act, useSyncExternalStore } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { EnvironmentId } from "@t3tools/contracts";
import { REACT_ACT_SAFE_FAKE_TIMER_METHODS } from "@t3tools/shared/testing/reactActFakeTimers";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

// Like the real atom, a refresh yields a new access object and re-renders subscribers.
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
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function setup() {
  vi.useFakeTimers({ toFake: [...REACT_ACT_SAFE_FAKE_TIMER_METHODS] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", () => {
    primes++;
    return Promise.resolve(new Response("prime"));
  });
  vi.stubGlobal(
    "WebSocket",
    class {
      static OPEN = 1;
      readyState = 1;
      send() {}
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
          style: { setProperty() {} },
          getBoundingClientRect: () => ({ width: 400, height: 800 }),
        };
      },
    });
  });
  return { images, view };
}

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
