import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import {
  CANCEL_PICK_CHANNEL,
  ELEMENT_PICKED_CHANNEL,
  START_PICK_CHANNEL,
} from "./GuestProtocol.ts";

const ipc = vi.hoisted(() => ({
  listeners: new Map<string, Set<(...args: unknown[]) => void>>(),
  send: vi.fn(),
  on(channel: string, listener: (...args: unknown[]) => void) {
    const listeners = this.listeners.get(channel) ?? new Set();
    listeners.add(listener);
    this.listeners.set(channel, listeners);
  },
  off(channel: string, listener: (...args: unknown[]) => void) {
    this.listeners.get(channel)?.delete(listener);
  },
}));
vi.mock("electron", () => ({ ipcRenderer: ipc }));

vi.mock("react-grab/primitives", () => ({ getElementContext: () => null }));

import "./PickPreload.ts";

const emit = (channel: string) => {
  for (const listener of ipc.listeners.get(channel) ?? []) listener({});
};

it.each(["select", "region", "reload"])(
  "captures iframe elements with %s in top-viewport coordinates",
  async (mode) => {
    ipc.send.mockClear();
    const frame = document.createElement("iframe");
    frame.style.cssText =
      "position:fixed;left:100px;top:120px;width:500px;height:400px;border:5px solid black";
    frame.srcdoc =
      '<title>Button story</title><button id="story" style="position:absolute;left:40px;top:50px;width:100px;height:40px">Story</button>';
    const loaded = new Promise<void>((resolve) =>
      frame.addEventListener("load", () => resolve(), { once: true }),
    );
    document.body.append(frame);
    try {
      await loaded;
      emit(START_PICK_CHANNEL);
      if (mode === "reload") {
        const reloaded = new Promise<void>((resolve) =>
          frame.addEventListener("load", () => resolve(), { once: true }),
        );
        frame.srcdoc += "<!-- reloaded -->";
        await reloaded;
      }
      const child = frame.contentWindow as Window & typeof globalThis;
      const button = frame.contentDocument!.querySelector("button")!;
      const pointer = (type: string, x: number, y: number) =>
        button.dispatchEvent(
          new child.PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            view: child,
            clientX: x,
            clientY: y,
            button: 0,
          }),
        );
      if (mode === "region") {
        button.dispatchEvent(new child.KeyboardEvent("keydown", { key: "r", bubbles: true }));
        pointer("pointerdown", 35, 45);
        pointer("pointermove", 145, 95);
        pointer("pointerup", 145, 95);
      } else pointer("pointerdown", 60, 65);
      await vi.waitFor(() =>
        expect(document.activeElement?.hasAttribute("data-t3code-annotation-ui")).toBe(true),
      );
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() =>
        expect(ipc.send).toHaveBeenCalledWith(
          ELEMENT_PICKED_CHANNEL,
          expect.objectContaining({
            elements: [
              expect.objectContaining({
                element: expect.objectContaining({ tagName: "button", pageTitle: "Button story" }),
                rect: { x: 145, y: 175, width: 100, height: 40 },
              }),
            ],
          }),
          { x: 125, y: 155, width: 140, height: 80 },
          "attach",
          window.devicePixelRatio,
        ),
      );
      emit(CANCEL_PICK_CHANNEL);
      expect(pointer("pointerdown", 60, 65)).toBe(true);
    } finally {
      emit(CANCEL_PICK_CHANNEL);
      frame.remove();
    }
  },
);
