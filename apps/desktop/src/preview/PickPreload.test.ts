import { describe, expect, it, vi } from "vite-plus/test";

import {
  CANCEL_PICK_CHANNEL,
  ELEMENT_PICKED_CHANNEL,
  START_PICK_CHANNEL,
} from "./GuestProtocol.ts";

const harness = vi.hoisted(() => {
  // jsdom cannot create trusted input, so the preload's window listeners see these
  // dispatches as trusted when `input.trusted` is set, the way real OS presses arrive.
  const input = { trusted: false };
  const asTrusted = (event: Event): Event =>
    new Proxy(event, {
      get(target, property) {
        if (property === "isTrusted") return true;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const wrapped = new WeakMap<EventListener, EventListener>();
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  type Options = boolean | AddEventListenerOptions;
  // PickPreload registers only function listeners.
  window.addEventListener = ((type: string, listener: EventListener, options?: Options) => {
    const wrapper: EventListener = (event) =>
      listener.call(window, input.trusted ? asTrusted(event) : event);
    wrapped.set(listener, wrapper);
    add(type, wrapper, options);
  }) as typeof window.addEventListener;
  window.removeEventListener = ((type: string, listener: EventListener, options?: Options) => {
    remove(type, wrapped.get(listener) ?? listener, options);
  }) as typeof window.removeEventListener;

  // jsdom has no layout: tests name the element under the pointer.
  const pointer: { over: Element | null } = { over: null };
  document.elementsFromPoint = () => (pointer.over ? [pointer.over] : []);
  const shadowRoots: ShadowRoot[] = [];
  const attachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const root = attachShadow.call(this, init);
    root.elementFromPoint = () => pointer.over;
    shadowRoots.push(root);
    return root;
  };
  const captured = new WeakMap<Element, Set<number>>();
  Element.prototype.setPointerCapture = function (pointerId) {
    captured.set(this, new Set([...(captured.get(this) ?? []), pointerId]));
  };
  Element.prototype.hasPointerCapture = function (pointerId) {
    return captured.get(this)?.has(pointerId) ?? false;
  };
  Element.prototype.releasePointerCapture = function (pointerId) {
    captured.get(this)?.delete(pointerId);
  };
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const sends: { onSend: ((channel: string, args: unknown[]) => void) | null } = { onSend: null };
  return { input, pointer, shadowRoots, listeners, sends };
});

vi.mock("electron", () => ({
  ipcRenderer: {
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      harness.listeners.set(channel, [...(harness.listeners.get(channel) ?? []), listener]);
    },
    off: (channel: string, listener: (...args: unknown[]) => void) => {
      harness.listeners.set(
        channel,
        (harness.listeners.get(channel) ?? []).filter((candidate) => candidate !== listener),
      );
    },
    send: (channel: string, ...args: unknown[]) => {
      harness.sends.onSend?.(channel, args);
    },
  },
}));
vi.mock("react-grab/primitives", () => ({ getElementContext: () => null }));

await import("./PickPreload.ts");

const emit = (channel: string, ...args: unknown[]) => {
  for (const listener of harness.listeners.get(channel) ?? []) listener({}, ...args);
};

const PAGE_DISMISS_EVENTS = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];

/** An ordinary page panel that closes on any press outside it, seen from document capture. */
function openDetailsPage() {
  document.body.innerHTML =
    '<p id="outside">Outside</p><section id="details"><p id="detail">Select this detail</p></section>';
  const details = document.getElementById("details")!;
  const pageSaw: string[] = [];
  const dismiss = (event: Event) => {
    pageSaw.push(event.type);
    if (!details.contains(event.target as Node)) details.remove();
  };
  for (const type of PAGE_DISMISS_EVENTS) document.addEventListener(type, dismiss, true);
  return {
    details,
    detail: document.getElementById("detail")!,
    outside: document.getElementById("outside")!,
    pageSaw,
    [Symbol.dispose]: () => {
      for (const type of PAGE_DISMISS_EVENTS) document.removeEventListener(type, dismiss, true);
      emit(CANCEL_PICK_CHANNEL);
      harness.sends.onSend = null;
    },
  };
}

// Chromium reports a click count on mouse events and click, and 0 on other pointer events.
const pointerInit = (point: { x: number; y: number }, detail = 1): PointerEventInit => ({
  bubbles: true,
  cancelable: true,
  composed: true,
  clientX: point.x,
  clientY: point.y,
  button: 0,
  detail,
  pointerId: 1,
  pointerType: "mouse",
  isPrimary: true,
});

function dispatch(target: Element, event: Event, trusted = true): void {
  harness.input.trusted = trusted;
  try {
    target.dispatchEvent(event);
  } finally {
    harness.input.trusted = false;
  }
}

/** One mouse press the way Chromium delivers it to the element under the pointer. */
function press(target: Element, { over = target, trusted = true } = {}): void {
  harness.pointer.over = over;
  const point = { x: 40, y: 40 };
  dispatch(
    target,
    new PointerEvent("pointerdown", { ...pointerInit(point, 0), buttons: 1 }),
    trusted,
  );
  dispatch(target, new MouseEvent("mousedown", { ...pointerInit(point), buttons: 1 }), trusted);
  dispatch(target, new PointerEvent("pointerup", pointerInit(point, 0)), trusted);
  dispatch(target, new MouseEvent("mouseup", pointerInit(point)), trusted);
  dispatch(target, new PointerEvent("click", pointerInit(point)), trusted);
}

function startAnnotatingDetail(page: ReturnType<typeof openDetailsPage>) {
  emit(START_PICK_CHANNEL, undefined, false);
  const root = harness.shadowRoots.at(-1)!;
  const button = (label: string) =>
    Array.from(root.querySelectorAll("button")).find(
      (candidate) =>
        candidate.textContent === label || candidate.getAttribute("aria-label") === label,
    )!;
  press(page.detail);
  page.pageSaw.length = 0;
  return { attach: button("Attach"), adjust: button("Expand annotation editor"), button };
}

const nextPickedAnnotation = () =>
  new Promise<{ elements: Array<{ element: { tagName: string } }> }>((resolve) => {
    harness.sends.onSend = (channel, args) => {
      if (channel === ELEMENT_PICKED_CHANNEL) resolve(args[0] as never);
    };
  });

describe("annotation overlay presses", () => {
  it.each([
    ["a pointer press", (attach: Element) => press(attach)],
    [
      "keyboard activation",
      (attach: HTMLElement) => {
        attach.focus();
        dispatch(attach, new PointerEvent("click", { ...pointerInit({ x: 0, y: 0 }, 0) }));
      },
    ],
  ])(
    "attaches the selected detail on %s without dismissing the page panel",
    async (_, activate) => {
      using page = openDetailsPage();
      const { attach } = startAnnotatingDetail(page);
      const picked = nextPickedAnnotation();

      activate(attach);

      expect(page.pageSaw).toEqual([]);
      expect(page.details.isConnected).toBe(true);
      expect(attach.textContent).toBe("Capturing…");
      expect((await picked).elements.map(({ element }) => element.tagName)).toEqual(["p"]);
    },
  );

  it("does not attach for a press the page synthesizes on the overlay host", () => {
    using page = openDetailsPage();
    const { attach } = startAnnotatingDetail(page);
    const host = document.querySelector("[data-t3code-annotation-ui]:not(style)")!;

    press(host, { over: attach, trusted: false });

    expect(attach.textContent).toBe("Attach");
  });

  it("keeps an editor drag released over the page away from page listeners", () => {
    using page = openDetailsPage();
    const { adjust, button } = startAnnotatingDetail(page);
    press(adjust);
    const dragHandle = button("⠿");
    const editor = dragHandle.parentElement!.parentElement!;

    harness.pointer.over = dragHandle;
    const start = { x: 100, y: 100 };
    dispatch(dragHandle, new PointerEvent("pointerdown", { ...pointerInit(start, 0), buttons: 1 }));
    dispatch(dragHandle, new MouseEvent("mousedown", { ...pointerInit(start), buttons: 1 }));
    dispatch(dragHandle, new PointerEvent("pointermove", pointerInit({ x: 300, y: 200 }, 0)));
    dispatch(dragHandle, new PointerEvent("pointerup", pointerInit({ x: 300, y: 200 }, 0)));
    // Releasing pointer capture sends the compatibility mouseup and click to the page.
    dispatch(page.outside, new MouseEvent("mouseup", pointerInit({ x: 300, y: 200 })));
    dispatch(document.documentElement, new PointerEvent("click", pointerInit({ x: 300, y: 200 })));

    expect(editor.style.left).toBe("200px");
    expect(page.pageSaw).toEqual([]);
    expect(page.details.isConnected).toBe(true);
  });
});
