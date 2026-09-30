// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { ThreadSwipeable } from "./Sidebar.swipe";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function mountRow() {
  const activate = vi.fn();
  const settle = vi.fn();
  const pin = vi.fn();
  act(() => {
    root.render(
      <ThreadSwipeable
        start={{ id: "pin", label: "Pin", icon: null, className: "", onPress: pin }}
        end={[
          {
            id: "settle",
            label: "Settle",
            icon: null,
            className: "",
            primary: true,
            onPress: settle,
          },
        ]}
      >
        <div role="button" tabIndex={0} onClick={activate}>
          Thread
        </div>
      </ThreadSwipeable>,
    );
  });
  const row = container.querySelector<HTMLElement>('[role="button"]')!;
  const content = row.parentElement!;
  Object.defineProperty(content, "offsetWidth", { value: 260 });
  // jsdom has no pointer capture. Model its event retargeting explicitly;
  // real browser capture and scrolling still need integrated verification.
  let captured: HTMLElement | null = null;
  content.setPointerCapture = () => {
    captured = content;
  };
  const pointer = (type: string, x = 200, y = 100, pointerType = "touch") => {
    const target = captured ?? row;
    act(() => {
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerId: 1,
          pointerType,
          isPrimary: true,
          button: 0,
          clientX: x,
          clientY: y,
        }),
      );
    });
    return target;
  };
  const click = (target: HTMLElement, detail = 1) => {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, detail });
    act(() => target.dispatchEvent(event));
    return event;
  };
  const release = (x = 200, y = 100, pointerType = "touch") => {
    const target = pointer("pointerup", x, y, pointerType);
    captured = null;
    return target;
  };
  return { row, content, activate, settle, pin, pointer, click, release };
}

it.each(["touch", "pen"])("keeps an ordinary %s tap targeted at the thread", (pointerType) => {
  const view = mountRow();
  view.pointer("pointerdown", 200, 100, pointerType);
  view.pointer("pointermove", 203, 100, pointerType);
  view.click(view.release(203, 100, pointerType));
  expect(view.activate).toHaveBeenCalledOnce();
  expect(view.settle).not.toHaveBeenCalled();
});

it("swallows a full swipe's compatibility click and allows the next ordinary tap", () => {
  const view = mountRow();
  view.pointer("pointerdown");
  view.pointer("pointermove", 20);
  const releaseTarget = view.release(20);
  expect(view.settle).toHaveBeenCalledOnce();
  expect(view.click(releaseTarget).defaultPrevented).toBe(true);
  expect(view.activate).not.toHaveBeenCalled();
  view.pointer("pointerdown");
  view.click(view.release());
  expect(view.activate).toHaveBeenCalledOnce();
});

it("allows keyboard activation when the browser omitted the swipe's compatibility click", () => {
  const view = mountRow();
  view.pointer("pointerdown");
  view.pointer("pointermove", 160);
  view.release(160);
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="Settle"]')!;
  button.focus();
  expect(view.click(button, 0).defaultPrevented).toBe(false);
  expect(view.settle).toHaveBeenCalledOnce();
  expect(view.activate).not.toHaveBeenCalled();
});

it("allows a fresh tap on a revealed action after swallowing a compatibility click on it", () => {
  const view = mountRow();
  view.pointer("pointerdown");
  view.pointer("pointermove", 160);
  view.release(160);
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="Settle"]')!;
  expect(view.click(button).defaultPrevented).toBe(true);
  expect(view.settle).not.toHaveBeenCalled();
  act(() => button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  view.click(button);
  expect(view.settle).toHaveBeenCalledOnce();
});

it.each(["pointercancel", "lostpointercapture"])("cancels without committing on %s", (event) => {
  const view = mountRow();
  view.pointer("pointerdown");
  view.pointer("pointermove", 20);
  view.pointer(event, 20);
  view.click(view.release(20));
  expect(view.content.style.transform).toBe("");
  expect(view.settle).not.toHaveBeenCalled();
  expect(view.activate).not.toHaveBeenCalled();
});

it("commits the final direction after crossing the origin", () => {
  const view = mountRow();
  view.pointer("pointerdown");
  view.pointer("pointermove", 160);
  view.pointer("pointermove", 380);
  view.release(380);
  expect(view.pin).toHaveBeenCalledOnce();
  expect(view.settle).not.toHaveBeenCalled();
});

it("keeps swiping when capture transfers from the touched child to the wrapper", () => {
  const view = mountRow();
  view.pointer("pointerdown");
  view.pointer("pointermove", 160);
  act(() => {
    view.row.dispatchEvent(new PointerEvent("lostpointercapture", { bubbles: true, pointerId: 1 }));
  });
  view.pointer("pointermove", 20);
  view.release(20);
  expect(view.settle).toHaveBeenCalledOnce();
});

it("leaves a vertical scrolling gesture closed without committing", () => {
  const view = mountRow();
  view.pointer("pointerdown");
  view.pointer("pointermove", 202, 130);
  view.pointer("pointercancel", 202, 130);
  view.release(202, 130);
  expect(view.content.style.transform).toBe("");
  expect(view.settle).not.toHaveBeenCalled();
  expect(view.pin).not.toHaveBeenCalled();
});
