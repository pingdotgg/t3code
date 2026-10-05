import type { PreviewAutomationSnapshot } from "@t3tools/contracts";

export type SnapshotPage = Pick<
  PreviewAutomationSnapshot,
  | "url"
  | "title"
  | "loading"
  | "visibleText"
  | "viewportText"
  | "scroll"
  | "truncated"
  | "interactiveElements"
>;

function collectSnapshotPage(): SnapshotPage {
  const maxTextLength = 20_000;
  const maxElements = 200;
  const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  type Bounds = typeof viewport;
  const intersects = (rect: Bounds, clip: Bounds) =>
    rect.right > clip.left &&
    rect.left < clip.right &&
    rect.bottom > clip.top &&
    rect.top < clip.bottom;
  const selectorTargets = new Map<string, Element | null>();
  const uniquelyTargets = (selector: string, element: Element) => {
    if (!selectorTargets.has(selector)) {
      const matches = document.querySelectorAll(selector);
      selectorTargets.set(selector, matches.length === 1 ? matches[0]! : null);
    }
    return selectorTargets.get(selector) === element;
  };
  const selectorFor = (element: Element): string => {
    if (element.id) {
      const selector = "#" + CSS.escape(element.id);
      if (uniquelyTargets(selector, element)) return selector;
    }
    for (const attribute of ["data-testid", "name"]) {
      const value = element.getAttribute(attribute);
      if (value) {
        const selector =
          element.tagName.toLowerCase() + "[" + attribute + "=" + CSS.escape(value) + "]";
        if (uniquelyTargets(selector, element)) return selector;
      }
    }
    const parts: string[] = [];
    for (let current: Element | null = element; current; current = current.parentElement) {
      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter(
            (child) => child.tagName === current.tagName,
          )
        : [];
      parts.push(
        (current === document.documentElement ? ":root" : current.tagName.toLowerCase()) +
          (siblings.length > 1 ? ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")" : ""),
      );
    }
    return parts.toReversed().join(" > ");
  };
  const containers: Array<NonNullable<SnapshotPage["scroll"]>["containers"][number]> = [];
  let containersTruncated = false;
  const clips = new Map<Element, Bounds | null>();
  const paintClips = new Map<Element, Bounds | null>();
  const unsupportedClips = new Set<Element>();
  const unsupportedOverflowClips = new Set<Element>();
  const transformedClips = new Map<Element, boolean>();
  let unsupportedClip = false;
  const styles = new Map<Element, CSSStyleDeclaration>();
  const styleFor = (element: Element) => {
    let style = styles.get(element);
    if (!style) {
      style = getComputedStyle(element);
      styles.set(element, style);
    }
    return style;
  };
  const unsupportedTransform = (style: CSSStyleDeclaration) => {
    if (style.perspective && style.perspective !== "none") return true;
    if (
      style.scale &&
      style.scale !== "none" &&
      style.scale.split(/\s+/).some((value) => Number.parseFloat(value) <= 0)
    )
      return true;
    if (style.rotate && style.rotate !== "none") {
      const angle = /([+-]?(?:\d+(?:\.\d*)?|\.\d+))(deg|rad|grad|turn)$/.exec(style.rotate);
      const period =
        angle?.[2] === "deg"
          ? 360
          : angle?.[2] === "rad"
            ? 2 * Math.PI
            : angle?.[2] === "grad"
              ? 400
              : 1;
      if (!angle || Math.abs(Number(angle[1]) % period) > 1e-8) return true;
    }
    if (!style.transform || style.transform === "none") return false;
    const values = new DOMMatrixReadOnly(style.transform).toFloat64Array();
    return (
      values[0]! <= 0 ||
      values[5]! <= 0 ||
      values[15] !== 1 ||
      values.some(
        (value, index) => ![0, 5, 10, 12, 13, 14, 15].includes(index) && Math.abs(value) > 1e-8,
      )
    );
  };
  const paintClipFor = (element: Element): Bounds | null => {
    const pending: Element[] = [];
    let ancestor: Element | null = element;
    while (ancestor && !paintClips.has(ancestor)) {
      pending.push(ancestor);
      ancestor = ancestor.parentElement;
    }
    let clip = ancestor ? (paintClips.get(ancestor) ?? null) : viewport;
    let unsupported = ancestor ? unsupportedClips.has(ancestor) : false;
    let transformed = ancestor ? (transformedClips.get(ancestor) ?? false) : false;
    for (let index = pending.length - 1; index >= 0; index--) {
      const current = pending[index]!;
      const style = styleFor(current);
      transformed ||= unsupportedTransform(style);
      transformedClips.set(current, transformed);
      if (clip && style.display !== "contents") {
        const paint =
          /\b(paint|content|strict)\b/.test(style.contain) &&
          !/^(inline$|table-(?!cell$|caption$)|ruby(?:$|-))/.test(style.display);
        const path = style.clipPath && style.clipPath !== "none";
        if (paint || path) {
          if (transformed) {
            unsupportedClip = true;
            unsupported = true;
            unsupportedClips.add(current);
            clip = null;
            paintClips.set(current, clip);
            continue;
          }
          const rect = current.getBoundingClientRect();
          const scaleX =
            current instanceof HTMLElement && current.offsetWidth
              ? rect.width / current.offsetWidth
              : 1;
          const scaleY =
            current instanceof HTMLElement && current.offsetHeight
              ? rect.height / current.offsetHeight
              : 1;
          let left = rect.left;
          let top = rect.top;
          let right = rect.right;
          let bottom = rect.bottom;
          if (paint) {
            const margin = /^(?:padding-box )?(\d+(?:\.\d+)?|\.\d+)px$/.exec(
              style.overflowClipMargin || "0px",
            );
            if (!margin) {
              unsupportedClip = true;
              unsupported = true;
              unsupportedClips.add(current);
              clip = null;
              paintClips.set(current, clip);
              continue;
            }
            const outset = Number.parseFloat(margin[1]!);
            left += (current.clientLeft - outset) * scaleX;
            top += (current.clientTop - outset) * scaleY;
            right -= (Number.parseFloat(style.borderRightWidth) - outset) * scaleX;
            bottom -= (Number.parseFloat(style.borderBottomWidth) - outset) * scaleY;
          }
          if (path) {
            const values = /^inset\(([^()]+)\)$/.exec(style.clipPath)?.[1]?.trim().split(/\s+/);
            if (
              !values ||
              values.length > 4 ||
              values.some((value) => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:px|%)?$/.test(value))
            ) {
              unsupportedClip = true;
              unsupported = true;
              unsupportedClips.add(current);
              clip = null;
              paintClips.set(current, clip);
              continue;
            }
            const offsets = [
              values[0]!,
              values[1] ?? values[0]!,
              values[2] ?? values[0]!,
              values[3] ?? values[1] ?? values[0]!,
            ].map(
              (value, side) =>
                Number.parseFloat(value) *
                (value.endsWith("%")
                  ? (side % 2 === 0 ? rect.height : rect.width) / 100
                  : side % 2 === 0
                    ? scaleY
                    : scaleX),
            );
            left = paint ? Math.max(left, rect.left + offsets[3]!) : rect.left + offsets[3]!;
            top = paint ? Math.max(top, rect.top + offsets[0]!) : rect.top + offsets[0]!;
            right = paint ? Math.min(right, rect.right - offsets[1]!) : rect.right - offsets[1]!;
            bottom = paint
              ? Math.min(bottom, rect.bottom - offsets[2]!)
              : rect.bottom - offsets[2]!;
          }
          clip = {
            left: Math.max(clip.left, left),
            top: Math.max(clip.top, top),
            right: Math.min(clip.right, right),
            bottom: Math.min(clip.bottom, bottom),
          };
          if (clip.right <= clip.left || clip.bottom <= clip.top) clip = null;
        }
      }
      if (unsupported) unsupportedClips.add(current);
      paintClips.set(current, clip);
    }
    return paintClips.get(element)!;
  };
  const clipFor = (element: Element): Bounds | null => {
    const pending: Element[] = [];
    let ancestor: Element | null = element;
    while (ancestor && !clips.has(ancestor)) {
      pending.push(ancestor);
      ancestor =
        ancestor instanceof HTMLElement && /^(absolute|fixed)$/.test(styleFor(ancestor).position)
          ? ancestor.offsetParent
          : ancestor.parentElement;
    }
    let parentClip: Bounds | null = ancestor ? (clips.get(ancestor) ?? null) : viewport;
    let unsupportedOverflow = ancestor ? unsupportedOverflowClips.has(ancestor) : false;
    for (let index = pending.length - 1; index >= 0; index--) {
      const current = pending[index]!;
      const style = styleFor(current);
      if (
        style.display === "none" ||
        style.opacity === "0" ||
        style.contentVisibility === "hidden"
      ) {
        clips.set(current, null);
        parentClip = null;
        continue;
      }
      const clip = { ...(parentClip ?? viewport) };
      const paintClip = paintClipFor(current);
      if (paintClip) {
        clip.left = Math.max(clip.left, paintClip.left);
        clip.top = Math.max(clip.top, paintClip.top);
        clip.right = Math.min(clip.right, paintClip.right);
        clip.bottom = Math.min(clip.bottom, paintClip.bottom);
      }
      const rootStyle = styleFor(document.documentElement);
      const viewportBody =
        current === document.body &&
        style.contain === "none" &&
        rootStyle.contain === "none" &&
        style.contentVisibility === "visible" &&
        rootStyle.contentVisibility === "visible" &&
        rootStyle.overflowX === "visible" &&
        rootStyle.overflowY === "visible";
      if (current !== document.documentElement && !viewportBody && style.display !== "contents") {
        const clipsX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX);
        const clipsY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
        if (clipsX || clipsY) {
          const rect = current.getBoundingClientRect();
          const quirksBody =
            current === document.body &&
            current instanceof HTMLElement &&
            document.compatMode === "BackCompat";
          const clientWidth = quirksBody
            ? Math.max(
                0,
                current.offsetWidth -
                  current.clientLeft -
                  Number.parseFloat(style.borderRightWidth),
              )
            : current.clientWidth;
          const clientHeight = quirksBody
            ? Math.max(
                0,
                current.offsetHeight -
                  current.clientTop -
                  Number.parseFloat(style.borderBottomWidth),
              )
            : current.clientHeight;
          const scaleX =
            current instanceof HTMLElement && current.offsetWidth
              ? rect.width / current.offsetWidth
              : 1;
          const scaleY =
            current instanceof HTMLElement && current.offsetHeight
              ? rect.height / current.offsetHeight
              : 1;
          if (clipsX) {
            clip.left = Math.max(clip.left, rect.left + current.clientLeft * scaleX);
            clip.right = Math.min(
              clip.right,
              rect.left + (current.clientLeft + clientWidth) * scaleX,
            );
          }
          if (clipsY) {
            clip.top = Math.max(clip.top, rect.top + current.clientTop * scaleY);
            clip.bottom = Math.min(
              clip.bottom,
              rect.top + (current.clientTop + clientHeight) * scaleY,
            );
          }
          const scrollable =
            (/^(auto|scroll)$/.test(style.overflowX) && current.scrollWidth > clientWidth) ||
            (/^(auto|scroll)$/.test(style.overflowY) && current.scrollHeight > clientHeight);
          if (transformedClips.get(current)) {
            unsupportedClip = true;
            unsupportedOverflow = true;
          }
          if (scrollable && (unsupportedClips.has(current) || unsupportedOverflow))
            containersTruncated = true;
          if (
            scrollable &&
            !unsupportedOverflow &&
            parentClip &&
            paintClip &&
            clip.right > clip.left &&
            clip.bottom > clip.top &&
            intersects(rect, clip)
          ) {
            const selector = containers.length < 20 ? selectorFor(current) : null;
            if (selector !== null && selector.length <= 1_000) {
              containers.push({
                selector,
                x: current.scrollLeft,
                y: current.scrollTop,
                width: clientWidth,
                height: clientHeight,
                scrollWidth: current.scrollWidth,
                scrollHeight: current.scrollHeight,
              });
            } else containersTruncated = true;
          }
        }
      }
      if (unsupportedOverflow) unsupportedOverflowClips.add(current);
      parentClip =
        !unsupportedOverflow &&
        parentClip &&
        paintClip &&
        clip.right > clip.left &&
        clip.bottom > clip.top
          ? clip
          : null;
      clips.set(current, parentClip);
    }
    return clips.get(element)!;
  };
  const rendered = (element: Element) => {
    const style = styleFor(element);
    let box = element;
    while (styleFor(box).display === "contents" && box.parentElement) box = box.parentElement;
    return (
      style.visibility !== "hidden" &&
      style.visibility !== "collapse" &&
      style.display !== "none" &&
      box.checkVisibility({
        checkOpacity: true,
        contentVisibilityAuto: true,
      })
    );
  };
  const inViewport = (element: Element, rect: DOMRect) => {
    if (!intersects(rect, viewport)) return false;
    const clip = clipFor(element);
    return clip !== null && intersects(rect, clip);
  };
  const currentElements: Element[] = [];
  const otherElements: Element[] = [];
  let elementCount = 0;
  let controlsOmitted = false;
  for (const element of document.querySelectorAll(
    "a[href],button,input,textarea,select,[role],[tabindex]",
  )) {
    if (!rendered(element)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    paintClipFor(element);
    const current = inViewport(element, rect);
    if (unsupportedClips.has(element) || unsupportedOverflowClips.has(element)) {
      controlsOmitted = true;
      continue;
    }
    elementCount++;
    const target = current ? currentElements : otherElements;
    if (target.length < maxElements) target.push(element);
  }
  const interactiveElements = [...currentElements, ...otherElements]
    .slice(0, maxElements)
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        name: (
          element.getAttribute("aria-label") ||
          (element instanceof HTMLElement ? element.innerText : "") ||
          element.getAttribute("name") ||
          ""
        ).slice(0, 200),
        selector: selectorFor(element),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        inViewport: currentElements.includes(element),
      };
    });
  let viewportText = "";
  let viewportTextTruncated = false;
  let rangeReads = 0;
  let nodeText = "";
  const range = document.createRange();
  const appendText = (value: string) => {
    const normalized = value.replace(/\s+/g, " ");
    if (!normalized.trim()) return;
    const separator =
      viewportText && !viewportText.endsWith(" ") && !normalized.startsWith(" ") ? " " : "";
    const remaining = maxTextLength - viewportText.length;
    const addition = separator + normalized;
    viewportText += addition.slice(0, remaining);
    if (addition.length > remaining) viewportTextTruncated = true;
  };
  const readText = (node: Text, start: number, end: number, clip: Bounds) => {
    if (viewportTextTruncated || start === end) return;
    range.setStart(node, start);
    range.setEnd(node, end);
    const bounds = range.getBoundingClientRect();
    if (!intersects(bounds, clip)) return;
    if (++rangeReads > 4_096) {
      viewportTextTruncated = true;
      return;
    }
    if (
      bounds.left >= clip.left &&
      bounds.right <= clip.right &&
      bounds.top >= clip.top &&
      bounds.bottom <= clip.bottom
    ) {
      nodeText += node.data.slice(start, end);
      return;
    }
    if (!Array.from(range.getClientRects()).some((rect) => intersects(rect, clip))) return;
    if (end - start === 1) {
      nodeText += node.data.slice(start, end);
      return;
    }
    const middle = start + Math.floor((end - start) / 2);
    readText(node, start, middle, clip);
    readText(node, middle, end, clip);
  };
  if (document.body) {
    if (rendered(document.body)) clipFor(document.body);
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    );
    let node = walker.nextNode();
    let visited = 0;
    while (node) {
      if (++visited > 100_000) {
        viewportTextTruncated = true;
        containersTruncated = true;
        break;
      }
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element;
        const style = styleFor(element);
        if (/^(auto|scroll)$/.test(style.overflowX) || /^(auto|scroll)$/.test(style.overflowY)) {
          if (rendered(element) && intersects(element.getBoundingClientRect(), viewport))
            clipFor(element);
        }
        node = walker.nextNode();
        continue;
      }
      const parent = node.parentElement;
      if (
        !viewportTextTruncated &&
        parent &&
        !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName) &&
        rendered(parent)
      ) {
        const clip = clipFor(parent);
        if (clip) {
          nodeText = "";
          readText(node as Text, 0, (node as Text).length, clip);
          appendText(nodeText);
        }
      }
      node = walker.nextNode();
    }
  }
  const visibleText = document.body?.innerText || "";
  const root = document.scrollingElement ?? document.documentElement;
  return {
    url: location.href,
    title: document.title,
    loading: document.readyState !== "complete",
    visibleText: visibleText.slice(0, maxTextLength),
    viewportText: viewportText.trim(),
    interactiveElements,
    scroll: {
      x: scrollX,
      y: scrollY,
      width: innerWidth,
      height: innerHeight,
      scrollWidth: root.scrollWidth,
      scrollHeight: root.scrollHeight,
      containers,
      containersTruncated,
    },
    truncated: {
      visibleText: visibleText.length > maxTextLength,
      viewportText: viewportTextTruncated || unsupportedClip,
      interactiveElements: elementCount > maxElements || controlsOmitted,
    },
  };
}

export const snapshotPageExpression = () => `(${collectSnapshotPage.toString()})()`;
