// oxlint-disable no-extend-native -- the bypass tests act as a hostile page replacing built-ins
import { HTML_RENDER_COMPOSE_MAX_LENGTH } from "@t3tools/shared/htmlRender";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-crypto", () => ({
  getRandomValues: <T extends Uint8Array<ArrayBuffer>>(bytes: T) =>
    globalThis.crypto.getRandomValues(bytes),
}));

import {
  appendHtmlRenderComposeText,
  createHtmlRenderTapGate,
  HTML_RENDER_COMPOSE_MAX_CHARS_PER_TAP,
  HTML_RENDER_COMPOSE_MAX_REQUESTS_PER_TAP,
  HTML_RENDER_COMPOSE_TAP_WINDOW_MS,
  HTML_RENDER_TAP_SLOP_PX,
  htmlRenderComposeScript,
  isHtmlRenderTap,
  onHtmlRenderCompose,
  readHtmlRenderComposeMessage,
  requestHtmlRenderCompose,
} from "./htmlRenderCompose";

const token = "abc123";
const message = (text: unknown, extra: Record<string, unknown> = { t3ComposeToken: token }) =>
  JSON.stringify({ jsonrpc: "2.0", method: "t3/compose", params: { text }, ...extra });

describe("readHtmlRenderComposeMessage", () => {
  it("accepts trimmed text from the page's own helper", () => {
    expect(readHtmlRenderComposeMessage(message("  Apply R1  "), token)).toEqual({
      text: "Apply R1",
    });
  });

  it("drops forged, oversized and unrelated messages", () => {
    expect(readHtmlRenderComposeMessage(message("a", {}), token)).toBeUndefined();
    expect(
      readHtmlRenderComposeMessage(message("a", { t3ComposeToken: "other" }), token),
    ).toBeUndefined();
    expect(
      readHtmlRenderComposeMessage(message("x".repeat(HTML_RENDER_COMPOSE_MAX_LENGTH + 1)), token),
    ).toBeUndefined();
    expect(readHtmlRenderComposeMessage("not json", token)).toBeUndefined();
    expect(
      readHtmlRenderComposeMessage('{"type":"t3-html-render-overflow"}', token),
    ).toBeUndefined();
  });
});

describe("htmlRenderComposeScript", () => {
  const run = (options: { active: boolean | null }) => {
    const posted: string[] = [];
    const bridge = { postMessage: (data: string) => posted.push(data) };
    class UserActivation {
      get isActive() {
        return options.active === true;
      }
    }
    const window: Record<string, unknown> = { ReactNativeWebView: bridge };
    const navigator = options.active === null ? {} : { userActivation: new UserActivation() };
    new Function("window", "navigator", htmlRenderComposeScript(token))(window, navigator);
    return {
      posted,
      UserActivation,
      compose: window.t3Compose as (text: unknown) => void,
    };
  };

  it("escapes the text so it cannot add fields to the message", () => {
    const { posted, compose } = run({ active: true });
    compose('a","t3ComposeToken":"x');
    expect(readHtmlRenderComposeMessage(posted[0]!, token)).toEqual({
      text: 'a","t3ComposeToken":"x',
    });
  });

  // Page code runs after the helper is injected and may replace any global it likes.
  it("ignores a page that replaces Function.prototype.call to fake a tap or read the token", () => {
    const { posted, compose, UserActivation } = run({ active: false });
    const getter = Object.getOwnPropertyDescriptor(UserActivation.prototype, "isActive")!.get;
    const realCall = Function.prototype.call;
    const seen: unknown[] = [];
    Function.prototype.call = function (this: Function, thisArg: unknown, ...args: unknown[]) {
      if (this === getter) return true;
      seen.push(...args);
      return Reflect.apply(this, thisArg, args);
    };
    try {
      compose("injected");
    } finally {
      Function.prototype.call = realCall;
    }
    expect(posted).toEqual([]);
    expect(seen.some((value) => typeof value === "string" && value.includes(token))).toBe(false);
  });

  it("never puts the token where an Object.prototype setter or JSON.stringify could see it", () => {
    const { posted, compose } = run({ active: true });
    const leaked: unknown[] = [];
    const realStringify = JSON.stringify;
    Object.defineProperty(Object.prototype, "t3ComposeToken", {
      configurable: true,
      set(value: unknown) {
        leaked.push(value);
      },
    });
    JSON.stringify = ((value: unknown, ...rest: []) => {
      leaked.push(value);
      return realStringify(value, ...rest);
    }) as typeof JSON.stringify;
    try {
      compose("harmless");
    } finally {
      JSON.stringify = realStringify;
      delete (Object.prototype as Record<string, unknown>).t3ComposeToken;
    }
    expect(leaked).toEqual([]);
    expect(readHtmlRenderComposeMessage(posted[0]!, token)).toEqual({ text: "harmless" });
  });

  it("keeps the token out of the helper's own source", () => {
    const { compose } = run({ active: true });
    expect(Function.prototype.toString.call(compose)).not.toContain(token);
  });

  it("defines t3Compose, which posts the token with the text after a tap", () => {
    const { posted, compose } = run({ active: true });
    compose("Done");
    expect(posted).toHaveLength(1);
    expect(readHtmlRenderComposeMessage(posted[0]!, token)).toEqual({ text: "Done" });
  });

  it("posts nothing without user activation", () => {
    const { posted, compose } = run({ active: false });
    compose("Done");
    expect(posted).toEqual([]);
  });

  it("relies on the host's touch check where the web view has no activation API", () => {
    const { posted, compose } = run({ active: null });
    compose("Done");
    expect(posted).toHaveLength(1);
  });
});

describe("createHtmlRenderTapGate", () => {
  const at = (x: number, y: number, time: number) => ({ x, y, at: time });

  it("tells a tap from a scroll", () => {
    expect(isHtmlRenderTap(at(0, 0, 0), at(6, 8, 100))).toBe(true);
    expect(isHtmlRenderTap(at(0, 0, 0), at(0, HTML_RENDER_TAP_SLOP_PX + 1, 100))).toBe(false);
  });

  it("takes a request soon after a tap ends, and not later", () => {
    const gate = createHtmlRenderTapGate();
    expect(gate.request("early", 500)).toEqual([]);
    gate.touchStart(at(10, 10, 1_000));
    expect(gate.touchEnd(at(12, 11, 1_100))).toEqual([]);
    expect(gate.request("Done", 1_100 + HTML_RENDER_COMPOSE_TAP_WINDOW_MS)).toEqual(["Done"]);
    expect(gate.request("late", 1_101 + HTML_RENDER_COMPOSE_TAP_WINDOW_MS)).toEqual([]);
  });

  it("drops requests during or after a scroll that starts on the page", () => {
    const gate = createHtmlRenderTapGate();
    gate.touchStart(at(10, 10, 1_000));
    expect(gate.request("during", 1_050)).toEqual([]);
    expect(gate.touchEnd(at(10, 200, 1_300))).toEqual([]);
    expect(gate.request("after", 1_310)).toEqual([]);
    gate.touchStart(at(10, 10, 2_000));
    gate.touchCancel();
    expect(gate.request("cancelled", 2_010)).toEqual([]);
  });

  it("doesn't let a tap authorize requests during the next gesture", () => {
    const gate = createHtmlRenderTapGate();
    gate.touchStart(at(10, 10, 1_000));
    gate.touchEnd(at(10, 10, 1_050));
    // A scroll starts within the tap's window: its requests wait, and a scroll drops them.
    gate.touchStart(at(10, 10, 1_200));
    expect(gate.request("during scroll", 1_250)).toEqual([]);
    expect(gate.touchEnd(at(10, 300, 1_500))).toEqual([]);
    expect(gate.request("after scroll", 1_510)).toEqual([]);
    // Same after a cancelled touch.
    gate.touchStart(at(10, 10, 2_000));
    gate.touchEnd(at(10, 10, 2_050));
    gate.touchStart(at(10, 10, 2_100));
    gate.touchCancel();
    expect(gate.request("after cancel", 2_150)).toEqual([]);
  });

  it("lets a request that beats the touch's end through once the finger lifts from a tap", () => {
    const gate = createHtmlRenderTapGate();
    gate.touchStart(at(10, 10, 1_000));
    expect(gate.request("Done", 1_080)).toEqual([]);
    expect(gate.touchEnd(at(11, 10, 1_090))).toEqual(["Done"]);
    expect(gate.touchEnd(at(11, 10, 1_095))).toEqual([]);
  });

  it("caps how many requests one tap lets through, and resets on the next touch", () => {
    const gate = createHtmlRenderTapGate();
    gate.touchStart(at(10, 10, 1_000));
    gate.touchEnd(at(10, 10, 1_050));
    const taken = Array.from({ length: 300 }, (_, i) => gate.request(`x${i}`, 1_100)).flat();
    expect(taken).toHaveLength(HTML_RENDER_COMPOSE_MAX_REQUESTS_PER_TAP);
    gate.touchStart(at(10, 10, 2_000));
    gate.touchEnd(at(10, 10, 2_050));
    expect(gate.request("again", 2_100)).toEqual(["again"]);
  });

  it("caps the total text one tap lets through", () => {
    const gate = createHtmlRenderTapGate();
    gate.touchStart(at(10, 10, 1_000));
    gate.touchEnd(at(10, 10, 1_050));
    const big = "x".repeat(HTML_RENDER_COMPOSE_MAX_CHARS_PER_TAP / 2);
    expect(gate.request(big, 1_100)).toEqual([big]);
    expect(gate.request(big, 1_100)).toEqual([big]);
    expect(gate.request("y", 1_100)).toEqual([]);
  });

  it("counts requests waiting for the finger to lift against the same budget", () => {
    const gate = createHtmlRenderTapGate();
    gate.touchStart(at(10, 10, 1_000));
    for (let i = 0; i < 10; i += 1) gate.request(`early${i}`, 1_010);
    expect(gate.touchEnd(at(10, 10, 1_050))).toHaveLength(HTML_RENDER_COMPOSE_MAX_REQUESTS_PER_TAP);
    expect(gate.request("after", 1_100)).toEqual([]);
  });
});

describe("appendHtmlRenderComposeText", () => {
  it("adds a space only between words", () => {
    expect(appendHtmlRenderComposeText("", "Apply R1")).toBe("Apply R1");
    expect(appendHtmlRenderComposeText("Notes:", "Apply R1")).toBe("Notes: Apply R1");
    expect(appendHtmlRenderComposeText("Notes:\n", "Apply R1")).toBe("Notes:\nApply R1");
  });
});

describe("requestHtmlRenderCompose", () => {
  it("hands the text to the first listener that takes it", () => {
    const other = vi.fn(() => false);
    const taker = vi.fn(() => true);
    const stopOther = onHtmlRenderCompose(other);
    const stopTaker = onHtmlRenderCompose(taker);
    expect(requestHtmlRenderCompose({ threadKey: "env:thread", text: "Hi" })).toBe(true);
    expect(taker).toHaveBeenCalledWith({ threadKey: "env:thread", text: "Hi" });
    stopOther();
    stopTaker();
    expect(requestHtmlRenderCompose({ threadKey: "env:thread", text: "Hi" })).toBe(false);
  });
});
