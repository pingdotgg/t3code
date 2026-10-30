import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type {
  PreviewStreamEvents,
  PreviewStreamInput,
} from "@t3tools/client-runtime/preview/server-browser-stream";

import "~/index.css";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";

const mocks = vi.hoisted(() => ({
  send: vi.fn<(input: PreviewStreamInput) => void>(),
  connect: vi.fn(),
  events: null as PreviewStreamEvents | null,
  painted: null as (() => void) | null,
}));

vi.mock(import("@t3tools/client-runtime/preview/server-browser-stream"), async (original) => ({
  ...(await original()),
  createPreviewFramePainter: (_canvas, onPainted) => {
    mocks.painted = onPainted ?? null;
    return { paint: () => undefined, stop: () => undefined };
  },
  createPreviewStreamClient: (_options, events) => {
    mocks.events = events;
    mocks.connect();
    return { send: mocks.send, stop: () => undefined } as never;
  },
}));

vi.mock(import("~/state/previewStream"), async (original) => ({
  ...(await original()),
  usePreviewStreamAccess: () => ({}) as never,
}));

import { ServerBrowserSurface } from "./ServerBrowserSurface";

async function renderSurface() {
  mocks.send.mockReset();
  mocks.connect.mockReset();
  const container = document.createElement("div");
  container.style.cssText = "width: 400px; height: 300px;";
  await using stack = new AsyncDisposableStack();
  stack.use(
    await render(
      <ServerBrowserSurface
        environmentId={EnvironmentId.make("environment-1")}
        threadId={ThreadId.make("thread-1")}
        tabId="tab-1"
        visible
      />,
      { container },
    ),
  );
  const canvas = container.querySelector("canvas");
  if (!canvas) throw new Error("The surface did not render its canvas.");
  // The stream connects once the surface has measured its size.
  await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalled());
  return Object.assign(stack.move(), { canvas });
}

const mouseUp = (canvas: HTMLCanvasElement, button: number) => {
  const event = new MouseEvent("mouseup", { button, bubbles: true, cancelable: true });
  canvas.dispatchEvent(event);
  return event;
};

describe("ServerBrowserSurface", () => {
  it("routes mouse thumb buttons to the preview's history instead of the app", async () => {
    await using surface = await renderSurface();
    const { canvas } = surface;

    expect(mouseUp(canvas, 3).defaultPrevented).toBe(true);
    expect(mouseUp(canvas, 4).defaultPrevented).toBe(true);
    expect(mocks.send.mock.calls).toEqual([
      [{ type: "history", delta: -1 }],
      [{ type: "history", delta: 1 }],
    ]);
  });

  it("leaves other mouse buttons alone", async () => {
    await using surface = await renderSurface();
    const { canvas } = surface;

    expect(mouseUp(canvas, 0).defaultPrevented).toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("does not forward thumb-button presses to the page", async () => {
    await using surface = await renderSurface();
    const { canvas } = surface;
    canvas.width = 400;
    canvas.height = 300;
    // Synthetic pointers have no active pointer id to capture.
    canvas.setPointerCapture = () => undefined;
    mocks.painted?.();
    mocks.events?.onViewport({ width: 400, height: 300 });
    mocks.events?.onControl?.({ canOperate: true, controller: "you", generation: 1, dialog: null });
    const { left, top } = canvas.getBoundingClientRect();
    const press = (type: "pointerdown" | "pointerup", button: number) =>
      canvas.dispatchEvent(
        new PointerEvent(type, {
          button,
          buttons: type === "pointerdown" ? 1 << button : 0,
          clientX: left + 10,
          clientY: top + 10,
          pointerType: "mouse",
          bubbles: true,
        }),
      );
    const mouseInputs = () => mocks.send.mock.calls.filter(([input]) => input.type === "mouse");

    for (const button of [3, 4]) {
      press("pointerdown", button);
      press("pointerup", button);
    }
    expect(mouseInputs()).toEqual([]);

    press("pointerdown", 0);
    expect(mouseInputs()).not.toEqual([]);
  });
});
