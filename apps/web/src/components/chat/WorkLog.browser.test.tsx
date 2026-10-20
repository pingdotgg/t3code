import { describe, expect, it } from "vite-plus/test";
import { act, render as renderUi } from "../../../test/render";
import { WorkLogDetails } from "./WorkLog";

// The scroller's geometry is simulated so the test controls it: a 384px
// viewport over content whose height the test grows like a streamed trace.
const VIEWPORT = 384;
async function setup() {
  let contentHeight = 1000;
  let scrollTop = 0;
  const maxScrollTop = () => contentHeight - VIEWPORT;
  const keys = ["clientHeight", "scrollHeight", "scrollTop"] as const;
  const original = keys.map((key) =>
    Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, key),
  );
  await using stack = new AsyncDisposableStack();
  stack.defer(() =>
    keys.forEach((key, i) => {
      const descriptor = original[i];
      if (descriptor) Object.defineProperty(HTMLDivElement.prototype, key, descriptor);
      else Reflect.deleteProperty(HTMLDivElement.prototype, key);
    }),
  );
  Object.defineProperties(HTMLDivElement.prototype, {
    clientHeight: { configurable: true, get: () => VIEWPORT },
    scrollHeight: { configurable: true, get: () => contentHeight },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, maxScrollTop()));
      },
    },
  });
  const screen = stack.use(await renderUi(null));
  const render = async (followLive: boolean, text: string) =>
    await screen.rerender(
      <WorkLogDetails followLive={followLive}>
        <p>{text}</p>
      </WorkLogDetails>,
    );
  const scroller = () => {
    const element = screen.container.firstElementChild;
    if (!(element instanceof HTMLDivElement)) throw new Error("missing scroller");
    return element;
  };
  const stream = async (followLive: boolean, text: string) => {
    contentHeight += 200;
    await render(followLive, text);
  };
  const readerScrollsTo = async (top: number) => {
    scroller().scrollTop = top;
    await act(() => scroller().dispatchEvent(new Event("scroll")));
  };
  const environment = stack.move();
  return {
    render,
    stream,
    readerScrollsTo,
    maxScrollTop,
    getScrollTop: () => scrollTop,
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  };
}

describe("WorkLogDetails followLive", () => {
  it("keeps the newest streamed text in view", async () => {
    await using fixture = await setup();
    const { render, stream, maxScrollTop, getScrollTop } = fixture;
    await render(true, "a");
    expect(getScrollTop()).toBe(maxScrollTop());

    await stream(true, "ab");
    await stream(true, "abc");
    expect(getScrollTop()).toBe(maxScrollTop());
  });

  it("stops following when the reader scrolls up and resumes at the end", async () => {
    await using fixture = await setup();
    const { render, stream, readerScrollsTo, maxScrollTop, getScrollTop } = fixture;
    await render(true, "a");
    await readerScrollsTo(100);

    await stream(true, "ab");
    expect(getScrollTop()).toBe(100);

    await readerScrollsTo(maxScrollTop());
    await stream(true, "abc");
    expect(getScrollTop()).toBe(maxScrollTop());
  });

  it("does not move a trace that is not streaming", async () => {
    await using fixture = await setup();
    const { render, stream, getScrollTop } = fixture;
    await render(false, "a");
    await stream(false, "ab");
    expect(getScrollTop()).toBe(0);
  });
});
