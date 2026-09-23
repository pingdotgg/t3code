import { afterEach, expect, it, vi } from "vite-plus/test";
import { start, stop } from "./device-stream.browser";

class Element extends EventTarget {
  readonly style = {};
  naturalWidth = 0;
  naturalHeight = 0;
  src = "";
  readonly tag: string;
  constructor(tag: string) {
    super();
    this.tag = tag;
  }
  setAttribute() {}
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
  append() {}
}

async function setup() {
  vi.useFakeTimers();
  const elements: Element[] = [];
  vi.stubGlobal("document", {
    documentElement: { style: {} },
    body: { style: {}, replaceChildren() {} },
    createElement: (tag: string) => {
      const element = new Element(tag);
      elements.push(element);
      return element;
    },
  });
  const postMessage = vi.fn();
  vi.stubGlobal("window", { ReactNativeWebView: { postMessage }, addEventListener() {} });
  vi.stubGlobal("fetch", () => Promise.resolve(new Response("prime")));
  const sockets: Socket[] = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    onopen: (() => void) | null = null;
    close = vi.fn();
    send = vi.fn();
    constructor() {
      sockets.push(this);
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  const configuration = {
    platform: "ios" as const,
    deviceId: "fixture-device",
    access: {
      httpBase: "https://device.test",
      wsBase: "wss://device.test",
      credentials: false,
      query: {},
    },
    colors: {
      background: "white",
      foreground: "black",
      muted: "gray",
      buttonBackground: "gray",
      buttonForeground: "black",
      buttonBorder: "gray",
    },
  };
  start(configuration);
  await vi.advanceTimersByTimeAsync(0);
  return {
    configuration,
    elements,
    sockets,
    messages: () =>
      postMessage.mock.calls.map(
        ([message]) => JSON.parse(message as string) as { type: string; status?: string },
      ),
  };
}

afterEach(() => {
  stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("bridges shared first-frame readiness, image failure, and a successful fresh attempt to native", async () => {
  const { elements, messages, sockets, configuration } = await setup();
  sockets[0]!.onopen?.();
  expect(messages()).not.toContainEqual({ type: "status", status: "streaming" });
  expect(messages()).toContainEqual({ type: "input", connected: true });
  const image = elements.find((element) => element.tag === "img")!;
  image.naturalWidth = 400;
  image.naturalHeight = 800;
  await vi.advanceTimersByTimeAsync(250);
  expect(messages()).toContainEqual({ type: "status", status: "streaming" });
  image.dispatchEvent(new Event("error"));
  expect(messages()).toContainEqual({
    type: "status",
    status: "error",
    detail: "Could not receive the device stream. Reconnect to try again.",
  });
  expect(messages()).toContainEqual({ type: "input", connected: false });
  expect(messages()).not.toContainEqual({ type: "unauthorized" });
  expect(image.src).toBe("");
  expect(sockets[0]!.close).toHaveBeenCalledOnce();
  start(configuration);
  await vi.advanceTimersByTimeAsync(0);
  const replacement = elements.findLast((element) => element.tag === "img")!;
  replacement.naturalWidth = 400;
  replacement.naturalHeight = 800;
  replacement.dispatchEvent(new Event("load"));
  expect(messages().at(-1)).toEqual({ type: "status", status: "streaming" });
  image.dispatchEvent(new Event("error"));
  expect(sockets[1]!.close).not.toHaveBeenCalled();
  stop();
  expect(replacement.src).toBe("");
  expect(vi.getTimerCount()).toBe(0);
});
