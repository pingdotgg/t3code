export const FRAME_PICK_MESSAGE_KEY = "__t3codeFramePick";

export interface FramePickRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface FramePickHit {
  readonly id: string | null;
  readonly label: string;
  readonly rect: FramePickRect;
  readonly styles: Readonly<Record<string, string>> | null;
}

export interface FramePickCapture {
  readonly selector: string;
  readonly htmlPreview: string;
  readonly tagName: string;
}

export type FramePickPointerType = "pointermove" | "pointerdown" | "pointerup" | "pointerout";

export type FramePickUp =
  | { readonly kind: "hello" }
  | {
      readonly kind: "pointer";
      readonly type: FramePickPointerType;
      readonly x: number;
      readonly y: number;
      readonly button: number;
      readonly shiftKey: boolean;
      readonly hit: FramePickHit | null;
    }
  | { readonly kind: "key"; readonly key: string }
  | {
      readonly kind: "rects";
      readonly rects: ReadonlyArray<{ readonly id: string; readonly rect: FramePickRect }>;
    }
  | {
      readonly kind: "captured";
      readonly requestId: string;
      readonly capture: FramePickCapture | null;
    };

export type FramePickDown =
  | { readonly kind: "start" }
  | { readonly kind: "stop" }
  | { readonly kind: "refresh" }
  | { readonly kind: "capture"; readonly requestId: string; readonly id: string }
  | {
      readonly kind: "style";
      readonly id: string;
      readonly property: string;
      readonly value: string;
    }
  | { readonly kind: "restore"; readonly id: string };

export interface FramePickDelivery {
  readonly up: FramePickUp;
  readonly path: ReadonlyArray<number>;
  readonly frames: ReadonlyArray<string>;
}

export interface FramePickRelay {
  readonly send: (path: ReadonlyArray<number>, down: FramePickDown) => void;
  readonly dispose: () => void;
}

// Main injects this function's source text into subframes, so it must not reference anything
// outside its own body.
export function installFramePickAgent(
  key: string,
  deliver?: (delivery: FramePickDelivery) => void,
): FramePickRelay {
  const registry = window as unknown as Record<string, FramePickRelay | undefined>;
  const installed = deliver ? undefined : registry[key];
  if (installed) return installed;

  const styleProperties = [
    "font-family",
    "font-size",
    "font-weight",
    "line-height",
    "color",
    "background-color",
    "border-color",
    "border-width",
    "border-radius",
    "opacity",
    "padding",
    "margin",
    "gap",
  ];
  const toolKeys = new Set(["Escape", "v", "r", "d", "e"]);
  const elementsById = new Map<string, Element>();
  const idsByElement = new WeakMap<Element, string>();
  const baselines = new Map<string, Map<string, string>>();
  let lastId = 0;
  let active = false;
  let cursorStyle: HTMLStyleElement | null = null;

  const childFrames = (): HTMLIFrameElement[] =>
    Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe, frame"));

  const post = (target: Window | null | undefined, envelope: unknown): void => {
    if (!target) return;
    try {
      target.postMessage({ [key]: envelope }, "*");
    } catch {}
  };

  const cssPath = (element: Element): string => {
    const parts: string[] = [];
    for (
      let node: Element | null = element;
      node && node !== document.documentElement && node !== document.body;
      node = node.parentElement
    ) {
      if (node.id) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const tagName = node.tagName;
      const siblings = node.parentElement
        ? Array.from(node.parentElement.children).filter((child) => child.tagName === tagName)
        : [];
      const tag = tagName.toLowerCase();
      parts.unshift(
        siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag,
      );
    }
    return parts.join(" > ");
  };

  const describe = (element: Element): string => {
    const id = element.id ? `#${element.id}` : "";
    const classes =
      typeof element.className === "string"
        ? element.className
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((name) => `.${name}`)
            .join("")
        : "";
    return `${element.tagName.toLowerCase()}${id}${classes}`;
  };

  const intersect = (rect: FramePickRect, bounds: FramePickRect): FramePickRect => {
    const left = Math.max(rect.x, bounds.x);
    const top = Math.max(rect.y, bounds.y);
    const right = Math.min(rect.x + rect.width, bounds.x + bounds.width);
    const bottom = Math.min(rect.y + rect.height, bounds.y + bounds.height);
    return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  };

  const visibleRect = (element: Element): FramePickRect => {
    if (!element.isConnected) return { x: 0, y: 0, width: 0, height: 0 };
    const box = element.getBoundingClientRect();
    return intersect(
      { x: box.left, y: box.top, width: box.width, height: box.height },
      {
        x: 0,
        y: 0,
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      },
    );
  };

  const contentBox = (frame: HTMLIFrameElement): FramePickRect => {
    const box = frame.getBoundingClientRect();
    const style = getComputedStyle(frame);
    const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
    const paddingTop = Number.parseFloat(style.paddingTop) || 0;
    const paddingRight = Number.parseFloat(style.paddingRight) || 0;
    const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
    return {
      x: box.left + frame.clientLeft + paddingLeft,
      y: box.top + frame.clientTop + paddingTop,
      width: frame.clientWidth - paddingLeft - paddingRight,
      height: frame.clientHeight - paddingTop - paddingBottom,
    };
  };

  const shiftRect = (rect: FramePickRect, box: FramePickRect): FramePickRect =>
    intersect(
      { x: rect.x + box.x, y: rect.y + box.y, width: rect.width, height: rect.height },
      box,
    );

  const translate = (up: FramePickUp, box: FramePickRect): FramePickUp => {
    if (up.kind === "pointer") {
      return {
        ...up,
        x: up.x + box.x,
        y: up.y + box.y,
        hit: up.hit ? { ...up.hit, rect: shiftRect(up.hit.rect, box) } : null,
      };
    }
    if (up.kind === "rects") {
      return {
        ...up,
        rects: up.rects.map((entry) => ({ id: entry.id, rect: shiftRect(entry.rect, box) })),
      };
    }
    return up;
  };

  const sendUp = (
    up: FramePickUp,
    path: ReadonlyArray<number> = [],
    frames: ReadonlyArray<string> = [],
  ): void => {
    if (deliver) deliver({ up, path, frames });
    else post(window.parent, { up, path, frames });
  };

  const sendDown = (index: number, down: FramePickDown, path: ReadonlyArray<number>): void =>
    post(childFrames()[index]?.contentWindow, { down, path });

  const broadcast = (down: FramePickDown): void => {
    childFrames().forEach((_frame, index) => sendDown(index, down, []));
  };

  const register = (element: Element): string => {
    const known = idsByElement.get(element);
    if (known) return known;
    lastId += 1;
    const id = String(lastId);
    idsByElement.set(element, id);
    elementsById.set(id, element);
    return id;
  };

  const snapshotStyles = (element: Element): Record<string, string> => {
    const computed = getComputedStyle(element);
    return Object.fromEntries(
      styleProperties.map((property) => [property, computed.getPropertyValue(property)]),
    );
  };

  const hitAt = (x: number, y: number, selecting: boolean): FramePickHit | null => {
    const element = document
      .elementsFromPoint(x, y)
      .find((candidate) => candidate !== document.documentElement && candidate !== document.body);
    if (!element) return null;
    return {
      id: selecting ? register(element) : null,
      label: describe(element),
      rect: visibleRect(element),
      styles: selecting ? snapshotStyles(element) : null,
    };
  };

  const reportRects = (): void => {
    if (elementsById.size === 0) return;
    sendUp({
      kind: "rects",
      rects: Array.from(elementsById, ([id, element]) => ({ id, rect: visibleRect(element) })),
    });
  };

  const restore = (id: string): void => {
    const element = elementsById.get(id);
    const saved = baselines.get(id);
    if (!saved || !(element instanceof HTMLElement || element instanceof SVGElement)) return;
    for (const [property, value] of saved) {
      if (value) element.style.setProperty(property, value);
      else element.style.removeProperty(property);
    }
    baselines.delete(id);
  };

  const applyStyle = (id: string, property: string, value: string): void => {
    const element = elementsById.get(id);
    if (!(element instanceof HTMLElement || element instanceof SVGElement)) return;
    const saved = baselines.get(id) ?? new Map<string, string>();
    if (!saved.has(property)) saved.set(property, element.style.getPropertyValue(property));
    baselines.set(id, saved);
    element.style.setProperty(property, value, "important");
    reportRects();
  };

  const onPointer = (event: PointerEvent): void => {
    if (!event.isTrusted) return;
    const type = event.type as FramePickPointerType;
    if (type === "pointerout" && event.relatedTarget !== null) return;
    if ((type === "pointerdown" || type === "pointerup") && event.button === 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    sendUp({
      kind: "pointer",
      type,
      x: event.clientX,
      y: event.clientY,
      button: event.button,
      shiftKey: event.shiftKey,
      hit:
        type === "pointerout" ? null : hitAt(event.clientX, event.clientY, type === "pointerdown"),
    });
  };

  const onClick = (event: MouseEvent): void => {
    if (!event.isTrusted) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const onKey = (event: KeyboardEvent): void => {
    if (!event.isTrusted || event.isComposing || event.metaKey || event.ctrlKey || event.altKey)
      return;
    if (!toolKeys.has(event.key)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    sendUp({ kind: "key", key: event.key });
  };

  const onLayoutChange = (): void => {
    reportRects();
    broadcast({ kind: "refresh" });
  };

  const pointerTypes: ReadonlyArray<FramePickPointerType> = [
    "pointermove",
    "pointerdown",
    "pointerup",
    "pointerout",
  ];

  const activate = (): void => {
    if (active) return;
    active = true;
    for (const type of pointerTypes) window.addEventListener(type, onPointer, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onLayoutChange, { capture: true, passive: true });
    window.addEventListener("resize", onLayoutChange, { passive: true });
    cursorStyle = document.createElement("style");
    cursorStyle.textContent = "html, html * { cursor: crosshair !important; }";
    document.documentElement.appendChild(cursorStyle);
  };

  const deactivate = (): void => {
    if (!active) return;
    active = false;
    for (const type of pointerTypes) window.removeEventListener(type, onPointer, true);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", onLayoutChange, true);
    window.removeEventListener("resize", onLayoutChange);
    cursorStyle?.remove();
    cursorStyle = null;
    for (const id of Array.from(baselines.keys())) restore(id);
    elementsById.clear();
  };

  const handleHere = (down: FramePickDown): void => {
    if (down.kind === "start") activate();
    else if (down.kind === "stop") deactivate();
    else if (down.kind === "refresh") reportRects();
    else if (down.kind === "style") applyStyle(down.id, down.property, down.value);
    else if (down.kind === "restore") restore(down.id);
    else if (down.kind === "capture") {
      const element = elementsById.get(down.id);
      sendUp({
        kind: "captured",
        requestId: down.requestId,
        capture: element
          ? {
              selector: cssPath(element),
              htmlPreview: element.outerHTML.slice(0, 500),
              tagName: element.tagName.toLowerCase(),
            }
          : null,
      });
    }
  };

  const route = (down: FramePickDown, path: ReadonlyArray<number>): void => {
    const [next, ...rest] = path;
    if (next !== undefined) {
      sendDown(next, down, rest);
      return;
    }
    if (!deliver) handleHere(down);
    if (down.kind === "start" || down.kind === "stop" || down.kind === "refresh") broadcast(down);
    // Main injects a fresh agent into every frame when the next session starts.
    if (down.kind === "stop") relay.dispose();
  };

  const onMessage = (event: MessageEvent): void => {
    const envelope = (event.data as Record<string, unknown> | null)?.[key] as
      | { up?: FramePickUp; down?: FramePickDown; path?: number[]; frames?: string[] }
      | undefined;
    if (!envelope || typeof envelope !== "object" || !Array.isArray(envelope.path)) return;
    if (envelope.up) {
      const frames = childFrames();
      const index = frames.findIndex((frame) => frame.contentWindow === event.source);
      const frame = frames[index];
      if (!frame) return;
      if (envelope.up.kind === "hello") {
        if (deliver || active) sendDown(index, { kind: "start" }, []);
        return;
      }
      sendUp(
        translate(envelope.up, contentBox(frame)),
        [index, ...envelope.path],
        [cssPath(frame), ...(envelope.frames ?? [])],
      );
      return;
    }
    if (envelope.down && !deliver && event.source === window.parent)
      route(envelope.down, envelope.path);
  };

  window.addEventListener("message", onMessage);
  const relay: FramePickRelay = {
    send: (path, down) => route(down, path),
    dispose: () => {
      window.removeEventListener("message", onMessage);
      if (deliver) return;
      deactivate();
      delete registry[key];
    },
  };
  if (!deliver) {
    Object.defineProperty(registry, key, { value: relay, configurable: true });
    sendUp({ kind: "hello" });
  }
  return relay;
}
