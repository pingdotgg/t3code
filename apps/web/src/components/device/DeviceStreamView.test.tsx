import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";

vi.mock("~/state/device", () => ({
  useDeviceHubAccess: () => access,
  refreshDeviceHubAccess: vi.fn(),
}));
const access = { httpBase: "http://test", wsBase: "ws://test", query: {}, credentials: true };
vi.mock("./deviceStream", () => ({
  createDeviceStreamClient: (
    _target: unknown,
    _canvas: unknown,
    events: { onMjpegFallback: (url: string) => void },
  ) => ({
    start: () => events.onMjpegFallback("http://test/stream.mjpeg"),
    stop: vi.fn(),
  }),
}));
import { DeviceStreamView } from "./DeviceStreamView";
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("removes MJPEG requests while hidden and reconnects when shown", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const view = (visible: boolean) => (
    <DeviceStreamView
      environmentId={EnvironmentId.make("test")}
      deviceId="test"
      platform="ios"
      visible={visible}
    />
  );
  await act(async () => {
    renderer = create(view(true), {
      createNodeMock: () => ({
        style: { setProperty() {} },
        getBoundingClientRect: () => ({ width: 400, height: 800 }),
      }),
    });
  });
  expect(renderer!.root.findAllByType("img")).toHaveLength(1);
  await act(async () => renderer!.update(view(false)));
  expect(renderer!.root.findAllByType("img")).toHaveLength(0);
  await act(async () => renderer!.update(view(true)));
  expect(renderer!.root.findAllByType("img")).toHaveLength(1);
});
