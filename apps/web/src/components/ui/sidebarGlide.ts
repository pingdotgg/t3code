import { observeResize } from "~/lib/observeResize";

const GLIDE_ID = "sidebar-glide";
const SCOPE = '[data-panel-animations="true"]';
const EDGE = "data-sidebar-glide-edge";
const SETTLE_FRAMES = 2;

type Side = "left" | "right";

interface Edges {
  readonly left: number;
  readonly right: number;
}

interface Snapshot {
  readonly sidebars: ReadonlyMap<HTMLElement, number>;
  readonly roots: readonly HTMLElement[];
  readonly starts: ReadonlyMap<HTMLElement, Edges>;
}

interface Shift {
  readonly offset: number;
  animation?: Animation;
}

interface Plan {
  readonly ends: ReadonlyMap<HTMLElement, Edges>;
  readonly shifts: ReadonlyMap<HTMLElement, Shift>;
  readonly widened: ReadonlyMap<HTMLElement, Edges>;
  readonly lead: Animation | undefined;
}

interface Cover {
  readonly right: number;
  readonly end: number;
}

type Animate = (element: HTMLElement, keyframes: PropertyIndexedKeyframes) => Animation;

let pending = false;
let session = 0;

export function glideSidebarToggle(commit: () => void) {
  if (pending) {
    commit();
    return;
  }
  const snapshot = takeSnapshot();
  commit();
  if (snapshot.sidebars.size === 0 && snapshot.roots.length === 0) return;
  pending = true;
  const current = ++session;
  window.requestAnimationFrame(() => {
    pending = false;
    let plan = play(snapshot, null);
    const settle = () => {
      if (current === session && plan && !atRest(plan)) {
        plan = play(snapshot, plan.lead?.startTime ?? null);
      }
    };
    const stopObserving = observeResize(snapshot.roots, () => queueMicrotask(settle));
    const nextFrame = (frames: number) => {
      if (frames === 0 || current !== session) {
        stopObserving();
        return;
      }
      window.requestAnimationFrame(() => {
        settle();
        nextFrame(frames - 1);
      });
    };
    nextFrame(SETTLE_FRAMES);
  });
}

function takeSnapshot(): Snapshot {
  const sidebars = new Map(
    Array.from(
      document.querySelectorAll<HTMLElement>(`${SCOPE} [data-slot="sidebar-container"]`),
      (element) => [element, element.getBoundingClientRect().left],
    ),
  );
  const roots = Array.from(
    document.querySelectorAll<HTMLElement>(`${SCOPE} [data-slot="sidebar-inset"]`),
  );
  const starts = new Map<HTMLElement, Edges>();
  const visit = (element: HTMLElement) => {
    if (element.hasAttribute(EDGE)) return;
    const rect = element.getBoundingClientRect();
    const onScreen =
      rect.width > 0 &&
      rect.right > 0 &&
      rect.left < window.innerWidth &&
      rect.bottom > 0 &&
      rect.top < window.innerHeight;
    const visible = element.checkVisibility();
    if (onScreen && visible) starts.set(element, visibleEdges(element, rect));
    else if (visible ? clips(getComputedStyle(element)) : !isContents(element)) return;
    for (const child of element.children) if (child instanceof HTMLElement) visit(child);
  };
  for (const root of roots) visit(root);
  return { sidebars, roots, starts };
}

function visibleEdges(element: HTMLElement, rect: DOMRect): Edges {
  let { left, right } = rect;
  for (const edge of element.querySelectorAll<HTMLElement>(
    `:scope > [${EDGE}], :scope > [${EDGE}] > [${EDGE}]`,
  )) {
    const side = edge.getAttribute(EDGE);
    if (side === "left") left = edge.getBoundingClientRect().left;
    if (side === "right") right = edge.getBoundingClientRect().right;
  }
  return { left, right };
}

function atRest(plan: Plan) {
  const shiftOf = (element: HTMLElement) => {
    let total = 0;
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      const shift = plan.shifts.get(node);
      const progress = shift?.animation?.effect?.getComputedTiming().progress ?? 1;
      if (shift) total += shift.offset * (1 - progress);
    }
    return total;
  };
  for (const [element, end] of plan.ends) {
    if (!element.isConnected) continue;
    const rect = element.getBoundingClientRect();
    const shift = shiftOf(element);
    const widened = plan.widened.get(element);
    const left = rect.left - shift + (widened?.left ?? 0);
    const right = rect.right - shift - (widened?.right ?? 0);
    if (Math.abs(left - end.left) > 0.5 || Math.abs(right - end.right) > 0.5) return false;
  }
  return true;
}

function play(snapshot: Snapshot, startTime: CSSNumberish | null): Plan | null {
  for (const animation of document.getAnimations()) {
    if (animation.id === GLIDE_ID) animation.cancel();
  }
  for (const edge of document.querySelectorAll(`[${EDGE}]`)) edge.remove();
  const first = snapshot.roots[0] ?? snapshot.sidebars.keys().next().value;
  if (!first) return null;
  const duration = Number.parseFloat(
    getComputedStyle(first).getPropertyValue("--panel-animation-duration"),
  );
  if (!(duration > 0)) return null;
  let lead: Animation | undefined;
  const animate: Animate = (element, keyframes) => {
    const animation = element.animate(keyframes, { duration, easing: "ease-out", id: GLIDE_ID });
    if (startTime !== null) animation.startTime = startTime;
    lead ??= animation;
    return animation;
  };
  const slide = (element: HTMLElement, from: number, to = 0) =>
    animate(element, { transform: [`translateX(${from}px)`, `translateX(${to}px)`] });
  const writes: (() => void)[] = [];

  for (const [element, start] of snapshot.sidebars) {
    const offset = start - element.getBoundingClientRect().left;
    if (Math.abs(offset) >= 0.5) writes.push(() => slide(element, offset));
  }

  const ends = new Map<HTMLElement, Edges>();
  for (const element of snapshot.starts.keys()) {
    if (element.isConnected) ends.set(element, element.getBoundingClientRect());
  }
  const styles = new Map<HTMLElement, CSSStyleDeclaration>();
  const style = (element: HTMLElement) => {
    const known = styles.get(element);
    if (known) return known;
    const computed = getComputedStyle(element);
    styles.set(element, computed);
    return computed;
  };
  const children = (element: HTMLElement): HTMLElement[] =>
    Array.from(element.children).flatMap((child) =>
      !(child instanceof HTMLElement) ? [] : ends.has(child) ? [child] : children(child),
    );
  const moves = (element: HTMLElement): Edges | null => {
    const start = snapshot.starts.get(element);
    const end = ends.get(element);
    return start && end ? { left: start.left - end.left, right: start.right - end.right } : null;
  };

  const uniform = new Map<HTMLElement, number | null>();
  const sharedShift = (element: HTMLElement): number | null => {
    const known = uniform.get(element);
    if (known !== undefined) return known;
    const moved = moves(element);
    const inner = children(element).map(sharedShift);
    let shift: number | null = null;
    if (moved) {
      const computed = style(element);
      const rigid = Math.abs(moved.left - moved.right) < 0.5;
      const paint = paintOf(element, computed);
      const block =
        computed.display === "table" || (paint !== null && paint !== computed && framed(paint));
      const flows = rigid || (!paint && !scrolls(element, computed));
      const together = inner.every((child) => child !== null && Math.abs(child - moved.left) < 0.5);
      if (block || (flows && together)) shift = moved.left;
    }
    uniform.set(element, shift);
    return shift;
  };

  const shifts = new Map<HTMLElement, Shift>();
  const widened = new Map<HTMLElement, Edges>();
  const translate = (element: HTMLElement, computed: CSSStyleDeclaration, offset: number) => {
    if (Math.abs(offset) < 0.5) return;
    const shift: Shift = { offset };
    shifts.set(element, shift);
    const notch = element.matches('[data-pane-notch=""]');
    const property = computed.transform === "none" ? "transform" : "translate";
    writes.push(() => {
      shift.animation = animate(
        element,
        property === "transform"
          ? { transform: [`translateX(${offset}px)`, "translateX(0)"] }
          : { translate: [`${offset}px 0`, "0 0"] },
      );
      if (notch) animate(element, { anchorName: ["none", "none"] });
    });
  };
  const hideScrollbar = (element: HTMLElement, computed: CSSStyleDeclaration) => {
    if (!["auto", "scroll"].includes(computed.overflowX)) return;
    if (element.scrollWidth > element.clientWidth) return;
    writes.push(() => animate(element, { overflowX: ["hidden", "hidden"] }));
  };
  const place = (
    element: HTMLElement,
    carried: number,
    outer: Cover | null,
    behind: string,
    inside: boolean,
    scrolled: boolean,
  ) => {
    const moved = moves(element);
    const end = ends.get(element);
    if (!moved || !end) return;
    const computed = style(element);
    const shared = sharedShift(element);
    if (shared !== null || Math.abs(moved.left - moved.right) < 0.5) {
      translate(element, computed, (shared ?? moved.left) - carried);
      if (shared !== null) return;
      hideScrollbar(element, computed);
      for (const child of children(element)) {
        place(child, moved.left, null, behind, inside, scrolled || scrolls(element, computed));
      }
      return;
    }
    const left = moved.left - carried;
    const right = moved.right - carried;
    const grows = left > right;
    const scroller = scrolls(element, computed);
    const contained = containsPaint(computed);
    const paint = scroller ? null : paintOf(element, computed);
    const flush = scrolled && paint !== null && hugsRight(element, end);
    if (flush || (scrolled && paint && framed(paint))) {
      translate(element, computed, flush ? right : left);
      return;
    }
    const anchored = paint !== null || scroller || contained;
    const holdsText = children(element).some((child) => style(child).display === "inline");
    const offset = !anchored ? 0 : (grows && !scroller) || holdsText ? left : right;
    translate(element, computed, offset);
    hideScrollbar(element, computed);
    const local = { left: left - offset, right: right - offset };
    const need = { left: Math.max(0, -local.left), right: Math.max(0, local.right) };
    let box: Edges = end;
    const reach = Math.max(need.left, need.right, Math.abs(left - right));
    if (clips(computed)) {
      if (anchored && (need.left >= 0.5 || need.right >= 0.5)) {
        if (scroller || contained) {
          widened.set(element, need);
          box = { left: end.left - need.left, right: end.right + need.right };
          writes.push(widen(element, computed, end.right - end.left, need, animate));
        } else {
          writes.push(() => animate(element, unclip(computed, reach)));
        }
      } else if (!anchored && (inside || need.left >= 0.5 || need.right >= 0.5)) {
        writes.push(() => animate(element, unclip(computed, reach)));
      }
    }
    const reached = carried + offset;
    let covered = outer;
    if (paint) {
      const sides = (["left", "right"] as const).filter(
        (side) =>
          Math.abs(local[side]) >= 0.5 &&
          !(
            side === "right" &&
            outer &&
            Math.abs(outer.right - moved.right) < 0.5 &&
            Math.abs(outer.end - end.right) < 0.5
          ),
      );
      if (sides.length > 0) {
        writes.push(
          glideEdges(element, computed, paint, box, end, local, sides, behind, slide, animate),
        );
      }
      covered = local.right < 0 ? { right: moved.right, end: end.right } : null;
      for (const cut of element.querySelectorAll<HTMLElement>(":scope > [data-pane-cut]")) {
        writes.push(() => animate(cut, { visibility: ["hidden", "hidden"] }));
      }
    }
    const surface = paint && opaque(paint.backgroundColor) ? paint.backgroundColor : behind;
    for (const child of children(element)) {
      place(child, reached, covered, surface, inside || paint !== null, scrolled || scroller);
    }
  };
  for (const root of snapshot.roots) place(root, 0, null, backdrop(root), false, false);

  for (const write of writes) write();
  return { ends, shifts, widened, lead };
}

function backdrop(element: HTMLElement) {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor;
    if (opaque(color)) return color;
  }
  return "transparent";
}

function hugsRight(element: HTMLElement, end: Edges) {
  const parent = element.parentElement;
  if (!parent) return false;
  const style = getComputedStyle(parent);
  const box = parent.getBoundingClientRect();
  const inner = {
    left:
      box.left + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft),
    right:
      box.right - Number.parseFloat(style.borderRightWidth) - Number.parseFloat(style.paddingRight),
  };
  return Math.abs(end.right - inner.right) < 1 && Math.abs(end.left - inner.left) >= 1;
}

function framed(style: CSSStyleDeclaration) {
  return (
    style.boxShadow !== "none" ||
    Number.parseFloat(style.borderLeftWidth) > 0 ||
    Number.parseFloat(style.borderRightWidth) > 0
  );
}

function opaque(color: string) {
  const alpha = /(?:^rgba\(.*,|\/)\s*([\d.]+)%?\s*\)$/.exec(color)?.[1];
  return alpha === undefined ? color !== "transparent" : Number(alpha) > 0;
}

function isContents(element: HTMLElement) {
  return getComputedStyle(element).display === "contents";
}

function inward(side: Side, moved: Edges) {
  return side === "left" ? moved.left > 0 : moved.right < 0;
}

function clips(style: CSSStyleDeclaration) {
  return style.overflowX !== "visible" || style.overflowY !== "visible" || containsPaint(style);
}

function containsPaint(style: CSSStyleDeclaration) {
  return /paint|content|strict/.test(style.contain);
}

function scrolls(element: HTMLElement, style: CSSStyleDeclaration) {
  return (
    [style.overflowX, style.overflowY].some((value) => value === "auto" || value === "scroll") ||
    element.scrollTop > 0 ||
    element.scrollLeft > 0
  );
}

function paintOf(element: HTMLElement, style: CSSStyleDeclaration) {
  if (paints(style)) return style;
  for (const pseudo of ["::after", "::before"]) {
    const layer = getComputedStyle(element, pseudo);
    if (layer.content !== "none" && layer.position === "absolute" && paints(layer)) return layer;
  }
  return null;
}

function paints(style: CSSStyleDeclaration) {
  return opaque(style.backgroundColor) || style.backgroundImage !== "none" || outlines(style);
}

function outlines(style: CSSStyleDeclaration) {
  return (
    style.boxShadow !== "none" ||
    ["top", "right", "bottom", "left"].some(
      (side) => Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0,
    )
  );
}

function widen(
  element: HTMLElement,
  style: CSSStyleDeclaration,
  width: number,
  reach: Edges,
  animate: Animate,
) {
  const px = (value: number) => [`${value}px`, `${value}px`];
  const parent = element.parentElement ? getComputedStyle(element.parentElement) : null;
  const inRow = parent?.display.endsWith("flex") === true && parent.flexDirection.startsWith("row");
  const keyframes: PropertyIndexedKeyframes = {
    boxSizing: ["border-box", "border-box"],
    ...(inRow ? { flex: ["0 0 auto", "0 0 auto"] } : {}),
    minWidth: ["0", "0"],
    maxWidth: ["none", "none"],
    width: px(width + reach.left + reach.right),
    marginLeft: px(Number.parseFloat(style.marginLeft) - reach.left),
    marginRight: px(Number.parseFloat(style.marginRight) - reach.right),
    paddingLeft: px(Number.parseFloat(style.paddingLeft) + reach.left),
    paddingRight: px(Number.parseFloat(style.paddingRight) + reach.right),
  };
  return () => {
    animate(element, keyframes);
  };
}

function unclip(style: CSSStyleDeclaration, reach: number): PropertyIndexedKeyframes {
  if (style.overflowY === "visible") return { overflowX: ["visible", "visible"] };
  const margin = `${Math.ceil(reach)}px`;
  return {
    overflowX: ["clip", "clip"],
    overflowY: ["clip", "clip"],
    overflowClipMargin: [margin, margin],
  };
}

function glideEdges(
  element: HTMLElement,
  style: CSSStyleDeclaration,
  paint: CSSStyleDeclaration,
  box: Edges,
  end: Edges,
  moved: Edges,
  sides: readonly Side[],
  behind: string,
  slide: (element: HTMLElement, from: number, to?: number) => Animation,
  animate: Animate,
) {
  const length = (name: string) => Number.parseFloat(style.getPropertyValue(name)) || 0;
  const radius = Math.max(
    ...["top-left", "top-right", "bottom-left", "bottom-right"].map((corner) =>
      length(`border-${corner}-radius`),
    ),
  );
  const background = [
    "color",
    "image",
    "size",
    "repeat",
    "position",
    "attachment",
    "clip",
    "origin",
  ]
    .map((part) => `background-${part}:${paint.getPropertyValue(`background-${part}`)}`)
    .join(";");
  const top = length("border-top-width");
  const bottom = length("border-bottom-width");
  const frame = `position:absolute;inset:${-top}px ${-length("border-right-width")}px ${-bottom}px ${-length("border-left-width")}px;overflow:hidden;z-index:2147483647;pointer-events:none`;
  const edges = sides.map((side) => {
    const far = side === "left" ? "right" : "left";
    const border = length(`border-${side}-width`);
    const to = end[side] - box[side];
    const reach = Math.abs(moved[side]) + Math.abs(to) + radius + border + 1;
    const outward = !inward(side, moved);
    const css = outward
      ? `position:absolute;top:${-top}px;bottom:${-bottom}px;${side}:${-border}px;width:${reach}px;z-index:-1;${background};border:inherit;border-${far}:none;border-radius:inherit;border-top-${far}-radius:0;border-bottom-${far}-radius:0`
      : `position:absolute;top:0;bottom:0;${side}:0;width:${box.right - box.left + reach}px;border-radius:${style.borderRadius};box-shadow:0 0 0 ${reach}px ${behind}`;
    return { side, css, from: to + moved[side], to, outward };
  });
  const positioned = style.position !== "static";
  return () => {
    if (!positioned) return;
    animate(element, { isolation: ["isolate", "isolate"] });
    for (const { side, css, from, to, outward } of edges) {
      const edge = document.createElement("div");
      edge.setAttribute(EDGE, side);
      edge.style.cssText = `${css};pointer-events:none`;
      let host = edge;
      if (!outward) {
        host = document.createElement("div");
        host.setAttribute(EDGE, "");
        host.style.cssText = frame;
        host.append(edge);
      }
      host.setAttribute("aria-hidden", "true");
      element.append(host);
      slide(edge, from, to).onfinish = () => host.remove();
    }
  };
}
