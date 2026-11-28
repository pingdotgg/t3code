export const FRAME_PICK_MESSAGE_KEY = "__t3codeFramePick";
export const FRAME_PICK_COMMAND_CHANNEL = "preview:frame-pick-command";
export const FRAME_PICK_ESCAPE_CHANNEL = "preview:frame-pick-escape";

export interface FramePickRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface FramePickSize {
  readonly width: number;
  readonly height: number;
}

export interface FramePickHit {
  readonly id: string | null;
  readonly label: string;
  readonly visibleRect: FramePickRect;
  readonly unclippedSize: FramePickSize;
}

export interface FramePickCapture {
  readonly selector: string;
  readonly htmlPreview: string;
  readonly tagName: string;
}

export type FramePickCommand =
  | { readonly kind: "capture"; readonly id: string }
  | { readonly kind: "describe"; readonly id: string }
  | {
      readonly kind: "style";
      readonly id: string;
      readonly property: string;
      readonly value: string;
    }
  | { readonly kind: "restore"; readonly id: string };

export type FramePickPointerType = "pointermove" | "pointerdown" | "pointerup" | "pointerout";

export interface FramePickElementBox {
  readonly id: string;
  readonly visibleRect: FramePickRect;
  readonly unclippedSize: FramePickSize;
}

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
  | { readonly kind: "rects"; readonly rects: ReadonlyArray<FramePickElementBox> };

export type FramePickDown =
  | { readonly kind: "start" }
  | { readonly kind: "stop" }
  | { readonly kind: "refresh" };

export interface FramePickDelivery {
  readonly up: FramePickUp;
  readonly framePathsOutermostFirst: ReadonlyArray<string>;
  readonly senderDocumentToken: string | null;
}

export interface FramePickRelay {
  readonly send: (down: FramePickDown) => void;
  readonly dispose: () => void;
  readonly runCommandForDocument: (documentToken: string, command: FramePickCommand) => unknown;
}

// Main injects this function's source text into subframes, so it must not reference anything
// outside its own body.
export function installFramePickAgent(
  key: string,
  deliver?: (delivery: FramePickDelivery) => void,
  documentToken: string | null = null,
): FramePickRelay {
  const registry = window as unknown as Record<string, FramePickRelay | undefined>;
  const replaceAgentWhoseStopIsStillInFlight = (): void => registry[key]?.dispose();
  if (!deliver) replaceAgentWhoseStopIsStillInFlight();

  const styleProperties = [
    "font-family",
    "font-size",
    "font-weight",
    "line-height",
    "color",
    "background-color",
    "border-color",
    "border-width",
    "border-style",
    "border-radius",
    "opacity",
    "padding",
    "margin",
    "gap",
    "width",
    "height",
  ];
  const toolKeys = new Set(["Escape", "v", "r", "d", "e"]);
  const elementsById = new Map<string, Element>();
  let idsByElement = new WeakMap<Element, string>();
  const styleAttributeBeforeFirstEdit = new Map<string, string | null>();
  let lastId = 0;
  let active = false;
  let cursorStyle: HTMLStyleElement | null = null;

  // Frames inside open shadow roots count too. The walk is cached and redone on a lookup miss
  // so per-pointermove relays do not rescan the whole document.
  let frameCache: HTMLIFrameElement[] | null = null;
  const scanFrames = (): HTMLIFrameElement[] => {
    const found: HTMLIFrameElement[] = [];
    const visit = (root: Document | ShadowRoot): void => {
      for (const element of Array.from(root.querySelectorAll("*"))) {
        if (element instanceof HTMLIFrameElement || element.tagName === "FRAME")
          found.push(element as HTMLIFrameElement);
        if (element.shadowRoot) visit(element.shadowRoot);
      }
    };
    visit(document);
    frameCache = found;
    return found;
  };
  const childFrames = (): HTMLIFrameElement[] => frameCache ?? scanFrames();

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

  const isNumber = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);
  const isRect = (value: unknown): value is FramePickRect => {
    const rect = value as Partial<FramePickRect> | null;
    return (
      typeof rect === "object" &&
      rect !== null &&
      isNumber(rect.x) &&
      isNumber(rect.y) &&
      isNumber(rect.width) &&
      isNumber(rect.height)
    );
  };
  const isSize = (value: unknown): value is FramePickSize => {
    const size = value as Partial<FramePickSize> | null;
    return (
      typeof size === "object" && size !== null && isNumber(size.width) && isNumber(size.height)
    );
  };

  const transformScale = (element: HTMLElement, box: DOMRect): { sx: number; sy: number } => ({
    sx: element.offsetWidth ? box.width / element.offsetWidth : 1,
    sy: element.offsetHeight ? box.height / element.offsetHeight : 1,
  });

  const parentAcrossShadowRoots = (element: Element): Element | null => {
    if (element.parentElement) return element.parentElement;
    const root = element.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  };

  const viewportRect = (): FramePickRect => ({
    x: 0,
    y: 0,
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  });

  const clipByOverflowAncestor = (clip: FramePickRect, ancestor: HTMLElement): FramePickRect => {
    const style = getComputedStyle(ancestor);
    const clipsX = style.overflowX !== "visible";
    const clipsY = style.overflowY !== "visible";
    if (!clipsX && !clipsY) return clip;
    const box = ancestor.getBoundingClientRect();
    const { sx, sy } = transformScale(ancestor, box);
    return intersect(clip, {
      x: clipsX ? box.left + ancestor.clientLeft * sx : clip.x,
      y: clipsY ? box.top + ancestor.clientTop * sy : clip.y,
      width: clipsX ? ancestor.clientWidth * sx : clip.width,
      height: clipsY ? ancestor.clientHeight * sy : clip.height,
    });
  };

  const visibleAreaFor = (element: Element): FramePickRect => {
    let clip = viewportRect();
    for (
      let ancestor = parentAcrossShadowRoots(element);
      ancestor && ancestor !== document.documentElement && ancestor !== document.body;
      ancestor = parentAcrossShadowRoots(ancestor)
    ) {
      if (ancestor instanceof HTMLElement) clip = clipByOverflowAncestor(clip, ancestor);
    }
    return clip;
  };

  const elementBox = (element: Element): Omit<FramePickElementBox, "id"> => {
    if (!element.isConnected) {
      return {
        visibleRect: { x: 0, y: 0, width: 0, height: 0 },
        unclippedSize: { width: 0, height: 0 },
      };
    }
    const box = element.getBoundingClientRect();
    return {
      visibleRect: intersect(
        { x: box.left, y: box.top, width: box.width, height: box.height },
        visibleAreaFor(element),
      ),
      unclippedSize: { width: box.width, height: box.height },
    };
  };

  interface ChildDocumentPlacement {
    readonly originX: number;
    readonly originY: number;
    readonly scaleX: number;
    readonly scaleY: number;
    readonly visibleArea: FramePickRect;
  }

  const childDocumentPlacement = (frame: HTMLIFrameElement): ChildDocumentPlacement => {
    const box = frame.getBoundingClientRect();
    const style = getComputedStyle(frame);
    const { sx, sy } = transformScale(frame, box);
    const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
    const paddingTop = Number.parseFloat(style.paddingTop) || 0;
    const paddingRight = Number.parseFloat(style.paddingRight) || 0;
    const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
    const originX = box.left + (frame.clientLeft + paddingLeft) * sx;
    const originY = box.top + (frame.clientTop + paddingTop) * sy;
    const contentBox = {
      x: originX,
      y: originY,
      width: (frame.clientWidth - paddingLeft - paddingRight) * sx,
      height: (frame.clientHeight - paddingTop - paddingBottom) * sy,
    };
    return {
      originX,
      originY,
      scaleX: sx,
      scaleY: sy,
      visibleArea: intersect(contentBox, visibleAreaFor(frame)),
    };
  };

  const placeRect = (rect: FramePickRect, placement: ChildDocumentPlacement): FramePickRect =>
    intersect(
      {
        x: placement.originX + rect.x * placement.scaleX,
        y: placement.originY + rect.y * placement.scaleY,
        width: rect.width * placement.scaleX,
        height: rect.height * placement.scaleY,
      },
      placement.visibleArea,
    );
  const placeSize = (size: FramePickSize, placement: ChildDocumentPlacement): FramePickSize => ({
    width: size.width * placement.scaleX,
    height: size.height * placement.scaleY,
  });

  const placeValidHit = (hit: unknown, placement: ChildDocumentPlacement): FramePickHit | null => {
    const candidate = hit as Partial<FramePickHit> | null;
    if (!candidate || typeof candidate !== "object" || typeof candidate.label !== "string")
      return null;
    if (!isRect(candidate.visibleRect) || !isSize(candidate.unclippedSize)) return null;
    return {
      id: typeof candidate.id === "string" ? candidate.id : null,
      label: candidate.label,
      visibleRect: placeRect(candidate.visibleRect, placement),
      unclippedSize: placeSize(candidate.unclippedSize, placement),
    };
  };

  const placeValidBoxes = (
    boxes: unknown,
    placement: ChildDocumentPlacement,
  ): FramePickElementBox[] | null => {
    if (!Array.isArray(boxes)) return null;
    return boxes.flatMap((entry: unknown) => {
      const candidate = entry as Partial<FramePickElementBox> | null;
      if (!candidate || typeof candidate.id !== "string") return [];
      if (!isRect(candidate.visibleRect) || !isSize(candidate.unclippedSize)) return [];
      return [
        {
          id: candidate.id,
          visibleRect: placeRect(candidate.visibleRect, placement),
          unclippedSize: placeSize(candidate.unclippedSize, placement),
        },
      ];
    });
  };

  const placeChildMessage = (
    up: FramePickUp,
    placement: ChildDocumentPlacement,
  ): FramePickUp | null => {
    if (up.kind === "pointer") {
      if (!isNumber(up.x) || !isNumber(up.y)) return null;
      return {
        ...up,
        x: placement.originX + up.x * placement.scaleX,
        y: placement.originY + up.y * placement.scaleY,
        hit: placeValidHit(up.hit, placement),
      };
    }
    if (up.kind === "rects") {
      const rects = placeValidBoxes(up.rects, placement);
      return rects ? { kind: "rects", rects } : null;
    }
    return up;
  };

  const sendUp = (
    up: FramePickUp,
    framePathsOutermostFirst: ReadonlyArray<string> = [],
    senderDocumentToken: string | null = documentToken,
  ): void => {
    const delivery = { up, framePathsOutermostFirst, senderDocumentToken };
    if (deliver) deliver(delivery);
    else post(window.parent, delivery);
  };

  const sendDown = (frame: HTMLIFrameElement, down: FramePickDown): void =>
    post(frame.contentWindow, { down });

  const broadcast = (down: FramePickDown): void => {
    for (const frame of down.kind === "refresh" ? childFrames() : scanFrames())
      sendDown(frame, down);
  };

  const register = (element: Element): string => {
    const known = idsByElement.get(element);
    if (known && elementsById.get(known) === element) return known;
    lastId += 1;
    const id = String(lastId);
    idsByElement.set(element, id);
    elementsById.set(id, element);
    return id;
  };

  const hitAt = (x: number, y: number, selecting: boolean): FramePickHit | null => {
    const element = document
      .elementsFromPoint(x, y)
      .find((candidate) => candidate !== document.documentElement && candidate !== document.body);
    if (!element) return null;
    return {
      id: selecting ? register(element) : null,
      label: describe(element),
      ...elementBox(element),
    };
  };

  const reportRects = (): void => {
    if (elementsById.size === 0) return;
    sendUp({
      kind: "rects",
      rects: Array.from(elementsById, ([id, element]) => ({ id, ...elementBox(element) })),
    });
  };

  const styleTarget = (id: string): HTMLElement | SVGElement | null => {
    const element = elementsById.get(id);
    return element instanceof HTMLElement || element instanceof SVGElement ? element : null;
  };

  const restore = (id: string): void => {
    const element = styleTarget(id);
    if (!element || !styleAttributeBeforeFirstEdit.has(id)) return;
    const original = styleAttributeBeforeFirstEdit.get(id) ?? null;
    if (original === null) element.removeAttribute("style");
    else element.setAttribute("style", original);
    styleAttributeBeforeFirstEdit.delete(id);
    reportRects();
  };

  const applyStyle = (id: string, property: string, value: string): void => {
    const element = styleTarget(id);
    if (!element) return;
    if (!styleAttributeBeforeFirstEdit.has(id))
      styleAttributeBeforeFirstEdit.set(id, element.getAttribute("style"));
    element.style.setProperty(property, value, "important");
    reportRects();
  };

  const computedStyles = (element: Element): Record<string, string> => {
    const computed = getComputedStyle(element);
    return Object.fromEntries(
      styleProperties.map((property) => [property, computed.getPropertyValue(property)]),
    );
  };

  const captureWithFreshRect = (element: Element): FramePickCapture => {
    reportRects();
    return {
      selector: cssPath(element),
      htmlPreview: element.outerHTML.slice(0, 500),
      tagName: element.tagName.toLowerCase(),
    };
  };

  const runCommand = (command: FramePickCommand): unknown => {
    if (command.kind === "style") {
      applyStyle(command.id, command.property, command.value);
      return null;
    }
    if (command.kind === "restore") {
      restore(command.id);
      return null;
    }
    const element = elementsById.get(command.id);
    if (!element) return null;
    return command.kind === "describe" ? computedStyles(element) : captureWithFreshRect(element);
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

  const escapeEndsTheSessionThroughMainOnly = (pressed: string): boolean => pressed === "Escape";

  const onKey = (event: KeyboardEvent): void => {
    if (!event.isTrusted || event.isComposing || event.metaKey || event.ctrlKey || event.altKey)
      return;
    if (!toolKeys.has(event.key)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!escapeEndsTheSessionThroughMainOnly(event.key)) sendUp({ kind: "key", key: event.key });
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
    for (const id of Array.from(styleAttributeBeforeFirstEdit.keys())) restore(id);
    elementsById.clear();
    idsByElement = new WeakMap();
  };

  const route = (down: FramePickDown): void => {
    if (!deliver) {
      if (down.kind === "start") activate();
      else if (down.kind === "stop") deactivate();
      else reportRects();
    }
    broadcast(down);
    // Main injects a fresh agent into every frame when the next session starts.
    if (down.kind === "stop") relay.dispose();
  };

  const senderFrame = (source: MessageEventSource | null): HTMLIFrameElement | undefined => {
    const isSender = (frame: HTMLIFrameElement): boolean => frame.contentWindow === source;
    return childFrames().find(isSender) ?? scanFrames().find(isSender);
  };

  const relayChildMessage = (
    event: MessageEvent,
    envelope: {
      up: FramePickUp;
      framePathsOutermostFirst?: unknown;
      senderDocumentToken?: unknown;
    },
  ): void => {
    const frame = senderFrame(event.source);
    if (!frame) return;
    if (envelope.up.kind === "hello") {
      if (deliver || active) sendDown(frame, { kind: "start" });
      return;
    }
    const placed = placeChildMessage(envelope.up, childDocumentPlacement(frame));
    if (!placed) return;
    const innerPaths = Array.isArray(envelope.framePathsOutermostFirst)
      ? envelope.framePathsOutermostFirst.filter((path): path is string => typeof path === "string")
      : [];
    sendUp(
      placed,
      [cssPath(frame), ...innerPaths],
      typeof envelope.senderDocumentToken === "string" ? envelope.senderDocumentToken : null,
    );
  };

  const onMessage = (event: MessageEvent): void => {
    const envelope = (event.data as Record<string, unknown> | null)?.[key] as
      | {
          up?: FramePickUp;
          down?: { kind?: unknown };
          framePathsOutermostFirst?: unknown;
          senderDocumentToken?: unknown;
        }
      | undefined;
    if (!envelope || typeof envelope !== "object") return;
    if (envelope.up && typeof envelope.up === "object") {
      relayChildMessage(event, { ...envelope, up: envelope.up });
      return;
    }
    if (envelope.down && !deliver && event.source === window.parent) {
      const kind = envelope.down.kind;
      if (kind === "start" || kind === "stop" || kind === "refresh") route({ kind });
    }
  };

  window.addEventListener("message", onMessage);
  const relay: FramePickRelay = {
    send: (down) => route(down),
    dispose: () => {
      window.removeEventListener("message", onMessage);
      if (deliver) return;
      deactivate();
      if (registry[key] === relay) delete registry[key];
    },
    runCommandForDocument: (token, command) =>
      documentToken !== null && token === documentToken && active ? runCommand(command) : null,
  };
  if (!deliver) {
    Object.defineProperty(registry, key, { value: relay, configurable: true });
    sendUp({ kind: "hello" });
  }
  return relay;
}
