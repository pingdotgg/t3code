// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vite-plus/test";
import { GhosttyTerminalSurface } from "./surface";

vi.mock("./vendor/ghostty-vt.wasm?url", async () => ({
  default: (await import("./vendor/ghostty-vt.wasm?inline")).default,
}));
vi.mock("./vendor/ghostty-write-pty.wasm?url&no-inline", async () => ({
  default: (await import("./vendor/ghostty-write-pty.wasm?inline")).default,
}));

const getContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
let surface: GhosttyTerminalSurface | undefined;
const consumeShortcut = (event: KeyboardEvent) => {
  if (event.code === "KeyD" || (event.code === "KeyB" && event.repeat)) event.stopPropagation();
};

afterEach(() => {
  surface?.dispose();
  surface = undefined;
  window.removeEventListener("keydown", consumeShortcut, { capture: true });
  document.body.replaceChildren();
  if (getContext) Object.defineProperty(HTMLCanvasElement.prototype, "getContext", getContext);
  vi.unstubAllGlobals();
});

async function createSurface(beforeKey: (event: KeyboardEvent) => boolean = () => true) {
  // Only drawing/layout are stubbed; DOM propagation, the surface and WASM encoder are real.
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({
      fillRect() {},
      measureText: () => ({ width: 8, actualBoundingBoxAscent: 9, actualBoundingBoxDescent: 3 }),
    }),
  });
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: Object.assign(new EventTarget(), { load: async () => [], add() {} }),
  });
  vi.stubGlobal("matchMedia", () => Object.assign(new EventTarget(), { matches: false }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const mount = document.createElement("div");
  document.body.append(mount);
  const onData = vi.fn<(data: string) => void>();
  window.addEventListener("keydown", consumeShortcut, { capture: true });
  surface = await GhosttyTerminalSurface.create(mount, {
    theme: {
      foreground: { r: 255, g: 255, b: 255 },
      background: { r: 0, g: 0, b: 0 },
      cursor: { r: 255, g: 255, b: 255 },
    },
    visible: false,
    onData,
    onResize() {},
    onSelectionChange() {},
    beforeKey,
    onLinkActivate() {},
  });
  surface.write("\x1b[>11u");
  const input = mount.querySelector("textarea");
  if (!input) throw new Error("Terminal input was not created");
  return { input, onData };
}

it("keeps encoded releases through real DOM capture while dropping an app-consumed press", async () => {
  const { input, onData } = await createSurface();
  const key = (type: "keydown" | "keyup", key: string, code: string, metaKey = false) =>
    input.dispatchEvent(new KeyboardEvent(type, { key, code, metaKey, bubbles: true }));

  key("keydown", "a", "KeyA");
  key("keyup", "a", "KeyA");
  key("keydown", "Meta", "MetaLeft", true);
  key("keydown", "d", "KeyD", true);
  key("keyup", "d", "KeyD", true);
  key("keyup", "Meta", "MetaLeft");

  expect(onData.mock.calls.map(([data]) => data)).toEqual([
    "\x1b[97u",
    "\x1b[97;1:3u",
    "\x1b[57444;9u",
    "\x1b[57444;1:3u",
  ]);
});

it("keeps an encoded press's release when the app consumes its repeat", async () => {
  const { input, onData } = await createSurface((event) => !event.repeat);

  // A's repeat reaches beforeKey; B's repeat is stopped during window capture.
  for (const [key, code] of [
    ["a", "KeyA"],
    ["b", "KeyB"],
  ] as const) {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, code, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key, code, bubbles: true, repeat: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key, code, bubbles: true }));
  }

  expect(onData.mock.calls.map(([data]) => data)).toEqual([
    "\x1b[97u",
    "\x1b[97;1:3u",
    "\x1b[98u",
    "\x1b[98;1:3u",
  ]);
});
