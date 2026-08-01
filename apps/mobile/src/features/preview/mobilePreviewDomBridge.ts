import type { PreviewReviewSnapshot } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

export type MobilePreviewDomFrame = Pick<
  PreviewReviewSnapshot,
  "loading" | "title" | "url" | "viewport" | "elements"
>;

const MOBILE_PREVIEW_DOM_MESSAGE_KIND = "t3.preview.capture";
const MOBILE_PREVIEW_DOM_MESSAGE_VERSION = 1;
const MAX_MESSAGE_LENGTH = 1024 * 1024;
const MAX_ELEMENTS = 200;
const MAX_SELECTOR_LENGTH = 2_048;
const MAX_NAME_LENGTH = 512;
const MAX_TAG_LENGTH = 64;
const MAX_ROLE_LENGTH = 128;
const MAX_URL_LENGTH = 2_048;
const MAX_TITLE_LENGTH = 512;
const MAX_VIEWPORT_DISTANCE = 100_000;

const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const boundedString = (value: unknown, maximumLength: number): string | null =>
  typeof value === "string" && value.length <= maximumLength ? value : null;

function decodeViewport(value: unknown): MobilePreviewDomFrame["viewport"] | null {
  if (!Predicate.isObject(value)) return null;
  const width = finiteNumber(value["width"]);
  const height = finiteNumber(value["height"]);
  const scrollX = finiteNumber(value["scrollX"]);
  const scrollY = finiteNumber(value["scrollY"]);
  const devicePixelRatio = finiteNumber(value["devicePixelRatio"]);
  if (
    width === null ||
    height === null ||
    scrollX === null ||
    scrollY === null ||
    devicePixelRatio === null ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_VIEWPORT_DISTANCE ||
    height > MAX_VIEWPORT_DISTANCE ||
    Math.abs(scrollX) > MAX_VIEWPORT_DISTANCE ||
    Math.abs(scrollY) > MAX_VIEWPORT_DISTANCE ||
    devicePixelRatio <= 0 ||
    devicePixelRatio > 16
  ) {
    return null;
  }
  return { width, height, scrollX, scrollY, devicePixelRatio };
}

function decodeElement(
  value: unknown,
  viewport: MobilePreviewDomFrame["viewport"],
  index: number,
): MobilePreviewDomFrame["elements"][number] | null {
  if (!Predicate.isObject(value)) return null;
  const tagValue = boundedString(value["tag"], MAX_TAG_LENGTH);
  const roleValue = value["role"] === null ? null : boundedString(value["role"], MAX_ROLE_LENGTH);
  const nameValue = boundedString(value["name"], MAX_NAME_LENGTH);
  const selectorValue = boundedString(value["selector"], MAX_SELECTOR_LENGTH);
  const rectValue = value["rect"];
  if (
    tagValue === null ||
    (value["role"] !== null && roleValue === null) ||
    nameValue === null ||
    selectorValue === null ||
    selectorValue.trim().length === 0 ||
    !Predicate.isObject(rectValue)
  ) {
    return null;
  }
  const x = finiteNumber(rectValue["x"]);
  const y = finiteNumber(rectValue["y"]);
  const width = finiteNumber(rectValue["width"]);
  const height = finiteNumber(rectValue["height"]);
  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) {
    return null;
  }
  const left = Math.max(0, x);
  const top = Math.max(0, y);
  const right = Math.min(viewport.width, x + width);
  const bottom = Math.min(viewport.height, y + height);
  if (right <= left || bottom <= top) return null;
  const tag = tagValue.trim().toLowerCase();
  if (tag.length === 0) return null;
  return {
    id: `mobile-element-${index}`,
    tag,
    role: roleValue?.trim() || null,
    name: nameValue.replace(/\s+/gu, " ").trim(),
    selector: selectorValue.trim(),
    rect: {
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    },
  };
}

/**
 * Messages originate in arbitrary preview pages. Decode them as hostile input
 * and accept only the response for the capture request currently in flight.
 */
export function decodeMobilePreviewDomMessage(
  raw: string,
  expectedRequestId: string,
): MobilePreviewDomFrame | null {
  if (raw.length === 0 || raw.length > MAX_MESSAGE_LENGTH) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !Predicate.isObject(value) ||
    value["kind"] !== MOBILE_PREVIEW_DOM_MESSAGE_KIND ||
    value["version"] !== MOBILE_PREVIEW_DOM_MESSAGE_VERSION ||
    value["requestId"] !== expectedRequestId
  ) {
    return null;
  }
  const url = boundedString(value["url"], MAX_URL_LENGTH);
  const title = boundedString(value["title"], MAX_TITLE_LENGTH);
  const viewport = decodeViewport(value["viewport"]);
  if (
    url === null ||
    title === null ||
    typeof value["loading"] !== "boolean" ||
    !viewport ||
    !Array.isArray(value["elements"])
  ) {
    return null;
  }
  const elements = value["elements"].slice(0, MAX_ELEMENTS).flatMap((element, index) => {
    const decoded = decodeElement(element, viewport, index);
    return decoded ? [decoded] : [];
  });
  return {
    url,
    title,
    loading: value["loading"],
    viewport,
    elements,
  };
}

/**
 * Build a one-shot main-frame script instead of keeping a MutationObserver in
 * every preview. The native view is captured immediately after this response.
 */
export function mobilePreviewDomCaptureScript(requestId: string): string {
  const encodedRequestId = JSON.stringify(requestId);
  return `(() => {
    const requestId = ${encodedRequestId};
    try {
      const selectorFor = (element) => {
        if (element.id) return "#" + CSS.escape(element.id);
        for (const attribute of ["data-testid", "name"]) {
          const value = element.getAttribute(attribute);
          if (value) {
            return element.tagName.toLowerCase() + "[" + attribute + "=" + JSON.stringify(value) + "]";
          }
        }
        const buildParts = (current, parts = []) => {
          if (!current || current.nodeType !== Node.ELEMENT_NODE || parts.length >= 8) {
            return parts;
          }
          const parent = current.parentElement;
          const siblings = parent
            ? Array.from(parent.children).filter((child) => child.tagName === current.tagName)
            : [];
          const base = current.tagName.toLowerCase();
          const part = siblings.length > 1
            ? base + ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")"
            : base;
          return buildParts(parent, [part, ...parts]);
        };
        return buildParts(element).join(" > ");
      };
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden"
          && style.display !== "none"
          && style.opacity !== "0"
          && rect.width > 0
          && rect.height > 0
          && rect.right > 0
          && rect.bottom > 0
          && rect.left < window.innerWidth
          && rect.top < window.innerHeight;
      };
      const elements = Array.from(document.querySelectorAll(
        "a[href],button,input,textarea,select,[role],[tabindex]"
      )).filter(visible).map((element) => {
        const rect = element.getBoundingClientRect();
        const selector = selectorFor(element);
        if (!selector || selector.length > ${MAX_SELECTOR_LENGTH}) return null;
        const rawName = element.getAttribute("aria-label")
          || element.innerText
          || element.getAttribute("name")
          || "";
        return {
          tag: element.tagName.toLowerCase().slice(0, ${MAX_TAG_LENGTH}),
          role: element.getAttribute("role")?.slice(0, ${MAX_ROLE_LENGTH}) ?? null,
          name: String(rawName).replace(/\\s+/g, " ").trim().slice(0, ${MAX_NAME_LENGTH}),
          selector,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        };
      }).filter((element) => element !== null).slice(0, ${MAX_ELEMENTS});
      window.ReactNativeWebView?.postMessage(JSON.stringify({
        kind: ${JSON.stringify(MOBILE_PREVIEW_DOM_MESSAGE_KIND)},
        version: ${MOBILE_PREVIEW_DOM_MESSAGE_VERSION},
        requestId,
        url: location.href.slice(0, ${MAX_URL_LENGTH}),
        title: document.title.slice(0, ${MAX_TITLE_LENGTH}),
        loading: document.readyState !== "complete",
        viewport: {
          width: Math.max(1, window.innerWidth),
          height: Math.max(1, window.innerHeight),
          scrollX: Number.isFinite(window.scrollX) ? window.scrollX : 0,
          scrollY: Number.isFinite(window.scrollY) ? window.scrollY : 0,
          devicePixelRatio: Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
            ? window.devicePixelRatio
            : 1
        },
        elements
      }));
    } catch (error) {
      window.ReactNativeWebView?.postMessage(JSON.stringify({
        kind: "t3.preview.capture-error",
        version: ${MOBILE_PREVIEW_DOM_MESSAGE_VERSION},
        requestId,
        message: String(error).slice(0, 512)
      }));
    }
  })();
  true;`;
}

export function decodeMobilePreviewDomErrorMessage(
  raw: string,
  expectedRequestId: string,
): string | null {
  if (raw.length === 0 || raw.length > MAX_MESSAGE_LENGTH) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !Predicate.isObject(value) ||
    value["kind"] !== "t3.preview.capture-error" ||
    value["version"] !== MOBILE_PREVIEW_DOM_MESSAGE_VERSION ||
    value["requestId"] !== expectedRequestId
  ) {
    return null;
  }
  const message = boundedString(value["message"], 512);
  return message?.trim() || "The page could not be inspected for markup.";
}
