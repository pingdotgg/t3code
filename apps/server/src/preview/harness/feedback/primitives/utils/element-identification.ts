// =============================================================================
// Element Identification Utilities
// =============================================================================

// =============================================================================
// Shadow DOM Helpers
// =============================================================================

/**
 * Gets the parent element, crossing shadow DOM boundaries.
 * When inside a shadow root with no parentElement, returns the shadow host.
 */
function getParentElement(element: Element): Element | null {
  if (element.parentElement) {
    return element.parentElement;
  }
  const root = element.getRootNode();
  if (root instanceof ShadowRoot) {
    return root.host;
  }
  return null;
}

/**
 * Finds the closest ancestor matching a selector, crossing shadow DOM boundaries.
 */
export function closestCrossingShadow(element: Element, selector: string): Element | null {
  let current: Element | null = element;
  while (current) {
    if (current.matches(selector)) return current;
    current = getParentElement(current);
  }
  return null;
}

/**
 * Checks if an element is inside a shadow DOM
 */
export function isInShadowDOM(element: Element): boolean {
  return element.getRootNode() instanceof ShadowRoot;
}

/**
 * Gets the shadow host for an element, or null if not in shadow DOM
 */
export function getShadowHost(element: Element): Element | null {
  const root = element.getRootNode();
  if (root instanceof ShadowRoot) {
    return root.host;
  }
  return null;
}

// =============================================================================
// Element Path Utilities
// =============================================================================

/**
 * Gets a readable path for an element (e.g., "article > section > p")
 * Supports elements inside shadow DOM by crossing shadow boundaries.
 */
export function getElementPath(target: HTMLElement, maxDepth = 4): string {
  const parts: string[] = [];
  let current: HTMLElement | null = target;
  let depth = 0;

  while (current && depth < maxDepth) {
    const tag = current.tagName.toLowerCase();

    // Skip generic wrappers
    if (tag === "html" || tag === "body") break;

    // Get identifier
    let identifier = tag;
    if (current.id) {
      identifier = `#${current.id}`;
    } else if (current.className && typeof current.className === "string") {
      const meaningfulClass = current.className
        .split(/\s+/)
        .find((c) => c.length > 2 && !c.match(/^[a-z]{1,2}$/) && !c.match(/[A-Z0-9]{5,}/));
      if (meaningfulClass) {
        identifier = `.${meaningfulClass.split("_")[0]}`;
      }
    }

    // Mark shadow boundary crossings
    const nextParent = getParentElement(current);
    if (!current.parentElement && nextParent) {
      identifier = `⟨shadow⟩ ${identifier}`;
    }

    parts.unshift(identifier);
    current = nextParent as HTMLElement | null;
    depth++;
  }

  return parts.join(" > ");
}

/**
 * Identifies an element and returns a human-readable name + path
 */
export function identifyElement(target: HTMLElement): { name: string; path: string } {
  const path = getElementPath(target);

  if (target.dataset.element) {
    return { name: target.dataset.element, path };
  }

  const tag = target.tagName.toLowerCase();

  // SVG elements
  if (["path", "circle", "rect", "line", "g"].includes(tag)) {
    // Try to find parent SVG context (crossing shadow boundaries)
    const svg = closestCrossingShadow(target, "svg");
    if (svg) {
      const parent = getParentElement(svg);
      if (parent instanceof HTMLElement) {
        const parentName = identifyElement(parent).name;
        return { name: `graphic in ${parentName}`, path };
      }
    }
    return { name: "graphic element", path };
  }
  if (tag === "svg") {
    const parent = getParentElement(target);
    if (parent?.tagName.toLowerCase() === "button") {
      const btnText = parent.textContent?.trim();
      return { name: btnText ? `icon in "${btnText}" button` : "button icon", path };
    }
    return { name: "icon", path };
  }

  // Interactive elements
  if (tag === "button") {
    const text = target.textContent?.trim();
    const ariaLabel = target.getAttribute("aria-label");
    if (ariaLabel) return { name: `button [${ariaLabel}]`, path };
    return { name: text ? `button "${text.slice(0, 25)}"` : "button", path };
  }
  if (tag === "a") {
    const text = target.textContent?.trim();
    const href = target.getAttribute("href");
    if (text) return { name: `link "${text.slice(0, 25)}"`, path };
    if (href) return { name: `link to ${href.slice(0, 30)}`, path };
    return { name: "link", path };
  }
  if (tag === "input") {
    const type = target.getAttribute("type") || "text";
    const placeholder = target.getAttribute("placeholder");
    const name = target.getAttribute("name");
    if (placeholder) return { name: `input "${placeholder}"`, path };
    if (name) return { name: `input [${name}]`, path };
    return { name: `${type} input`, path };
  }

  // Headings
  if (["h1", "h2", "h3", "h4", "h5", "h6"].includes(tag)) {
    const text = target.textContent?.trim();
    return { name: text ? `${tag} "${text.slice(0, 35)}"` : tag, path };
  }

  // Text elements
  if (tag === "p") {
    const text = target.textContent?.trim();
    if (text)
      return { name: `paragraph: "${text.slice(0, 40)}${text.length > 40 ? "..." : ""}"`, path };
    return { name: "paragraph", path };
  }
  if (tag === "span" || tag === "label") {
    const text = target.textContent?.trim();
    if (text && text.length < 40) return { name: `"${text}"`, path };
    return { name: tag, path };
  }
  if (tag === "li") {
    const text = target.textContent?.trim();
    if (text && text.length < 40) return { name: `list item: "${text.slice(0, 35)}"`, path };
    return { name: "list item", path };
  }
  if (tag === "blockquote") return { name: "blockquote", path };
  if (tag === "code") {
    const text = target.textContent?.trim();
    if (text && text.length < 30) return { name: `code: \`${text}\``, path };
    return { name: "code", path };
  }
  if (tag === "pre") return { name: "code block", path };

  // Media
  if (tag === "img") {
    const alt = target.getAttribute("alt");
    return { name: alt ? `image "${alt.slice(0, 30)}"` : "image", path };
  }
  if (tag === "video") return { name: "video", path };

  // Containers - try to infer meaningful name
  if (["div", "section", "article", "nav", "header", "footer", "aside", "main"].includes(tag)) {
    const className = target.className;
    const role = target.getAttribute("role");
    const ariaLabel = target.getAttribute("aria-label");

    if (ariaLabel) return { name: `${tag} [${ariaLabel}]`, path };
    if (role) return { name: `${role}`, path };

    if (typeof className === "string" && className) {
      const words = className
        .split(/[\s_-]+/)
        .map((c) => c.replace(/[A-Z0-9]{5,}.*$/, "")) // Remove CSS module hashes
        .filter((c) => c.length > 2 && !/^[a-z]{1,2}$/.test(c))
        .slice(0, 2);
      if (words.length > 0) return { name: words.join(" "), path };
    }

    return { name: tag === "div" ? "container" : tag, path };
  }

  return { name: tag, path };
}

/**
 * Gets text content from element and siblings for context
 */
export function getNearbyText(element: HTMLElement): string {
  const texts: string[] = [];

  // Own text
  const ownText = element.textContent?.trim();
  if (ownText && ownText.length < 100) {
    texts.push(ownText);
  }

  // Previous sibling text
  const prev = element.previousElementSibling;
  if (prev) {
    const prevText = prev.textContent?.trim();
    if (prevText && prevText.length < 50) {
      texts.unshift(`[before: "${prevText.slice(0, 40)}"]`);
    }
  }

  // Next sibling text
  const next = element.nextElementSibling;
  if (next) {
    const nextText = next.textContent?.trim();
    if (nextText && nextText.length < 50) {
      texts.push(`[after: "${nextText.slice(0, 40)}"]`);
    }
  }

  return texts.join(" ");
}

/**
 * Simplified element identifier for animation feedback (less verbose)
 */
export function identifyAnimationElement(target: HTMLElement): string {
  // Allow explicit labeling via data attribute
  if (target.dataset.element) return target.dataset.element;

  const tag = target.tagName.toLowerCase();

  // SVG elements
  if (tag === "path") return "path";
  if (tag === "circle") return "circle";
  if (tag === "rect") return "rectangle";
  if (tag === "line") return "line";
  if (tag === "ellipse") return "ellipse";
  if (tag === "polygon") return "polygon";
  if (tag === "g") return "group";
  if (tag === "svg") return "svg";

  // Interactive elements
  if (tag === "button") {
    const text = target.textContent?.trim();
    return text ? `button "${text}"` : "button";
  }
  if (tag === "input") {
    const type = target.getAttribute("type") || "text";
    return `input (${type})`;
  }

  // Text elements
  if (tag === "span" || tag === "p" || tag === "label") {
    const text = target.textContent?.trim();
    if (text && text.length < 30) return `"${text}"`;
    return "text";
  }

  // Containers - try to infer purpose from class name
  if (tag === "div") {
    const className = target.className;
    if (typeof className === "string" && className) {
      const words = className
        .split(/[\s_-]+/)
        .map((c) => c.replace(/[A-Z0-9]{5,}.*$/, ""))
        .filter((c) => c.length > 2 && !/^[a-z]{1,2}$/.test(c))
        .slice(0, 2);
      if (words.length > 0) {
        return words.join(" ");
      }
    }
    return "container";
  }

  return tag;
}

/**
 * Gets nearby sibling elements for structural context.
 * Supports elements inside shadow DOM.
 */
export function getNearbyElements(element: HTMLElement): string {
  const parent = getParentElement(element);
  if (!parent) return "";

  // Get siblings from the correct source
  const elementRoot = element.getRootNode();
  const children =
    elementRoot instanceof ShadowRoot && element.parentElement
      ? Array.from(element.parentElement.children)
      : Array.from(parent.children);

  const siblings = children.filter(
    (child) => child !== element && child instanceof HTMLElement,
  ) as HTMLElement[];

  if (siblings.length === 0) return "";

  // Get concise identifiers for up to 4 nearby siblings
  const siblingIds = siblings.slice(0, 4).map((sib) => {
    const tag = sib.tagName.toLowerCase();
    const className = sib.className;

    // Get first meaningful class
    let cls = "";
    if (typeof className === "string" && className) {
      const meaningful = className
        .split(/\s+/)
        .map((c) => c.replace(/[_][a-zA-Z0-9]{5,}.*$/, "")) // Remove module hashes
        .find((c) => c.length > 2 && !/^[a-z]{1,2}$/.test(c));
      if (meaningful) cls = `.${meaningful}`;
    }

    // For buttons/links, include short text
    if (tag === "button" || tag === "a") {
      const text = sib.textContent?.trim().slice(0, 15);
      if (text) return `${tag}${cls} "${text}"`;
    }

    return `${tag}${cls}`;
  });

  // Add parent context
  const parentTag = parent.tagName.toLowerCase();
  let parentId = parentTag;
  if (typeof parent.className === "string" && parent.className) {
    const parentCls = parent.className
      .split(/\s+/)
      .map((c) => c.replace(/[_][a-zA-Z0-9]{5,}.*$/, ""))
      .find((c) => c.length > 2 && !/^[a-z]{1,2}$/.test(c));
    if (parentCls) parentId = `.${parentCls}`;
  }

  const total = parent.children.length;
  const suffix = total > siblingIds.length + 1 ? ` (${total} total in ${parentId})` : "";

  return siblingIds.join(", ") + suffix;
}

/**
 * Gets CSS class names from an element (cleaned of module hashes)
 */
export function getElementClasses(target: HTMLElement): string {
  const className = target.className;
  if (typeof className !== "string" || !className) return "";

  // Split and clean class names (remove module hashes like _abc123)
  const classes = className
    .split(/\s+/)
    .filter((c) => c.length > 0)
    .map((c) => {
      // Keep the meaningful part before the hash
      const match = c.match(/^([a-zA-Z][a-zA-Z0-9_-]*?)(?:_[a-zA-Z0-9]{5,})?$/);
      return match ? match[1] : c;
    })
    .filter((c, i, arr) => arr.indexOf(c) === i); // dedupe

  return classes.join(", ");
}

/**
 * Gets key computed styles for an element (useful for styling issues)
 */
export function getComputedStylesSnapshot(target: HTMLElement): string {
  if (typeof window === "undefined") return "";

  const styles = window.getComputedStyle(target);
  const parts: string[] = [];

  // Color & text
  const color = styles.color;
  const bg = styles.backgroundColor;
  if (color && color !== "rgb(0, 0, 0)") parts.push(`color: ${color}`);
  if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") parts.push(`bg: ${bg}`);

  // Typography
  const fontSize = styles.fontSize;
  const fontWeight = styles.fontWeight;
  if (fontSize) parts.push(`font: ${fontSize}`);
  if (fontWeight && fontWeight !== "400" && fontWeight !== "normal")
    parts.push(`weight: ${fontWeight}`);

  // Spacing
  const padding = styles.padding;
  const margin = styles.margin;
  if (padding && padding !== "0px") parts.push(`padding: ${padding}`);
  if (margin && margin !== "0px") parts.push(`margin: ${margin}`);

  // Layout
  const display = styles.display;
  const position = styles.position;
  if (display && display !== "block" && display !== "inline") parts.push(`display: ${display}`);
  if (position && position !== "static") parts.push(`position: ${position}`);

  // Border
  const borderRadius = styles.borderRadius;
  if (borderRadius && borderRadius !== "0px") parts.push(`radius: ${borderRadius}`);

  return parts.join(", ");
}

// Values to filter out when collecting computed styles (browser defaults / uninteresting)
const DEFAULT_STYLE_VALUES = new Set([
  "none",
  "normal",
  "auto",
  "0px",
  "rgba(0, 0, 0, 0)",
  "transparent",
  "static",
  "visible",
]);

// Element type categories for style property selection
const TEXT_ELEMENTS = new Set([
  "p",
  "span",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "label",
  "li",
  "td",
  "th",
  "blockquote",
  "figcaption",
  "caption",
  "legend",
  "dt",
  "dd",
  "pre",
  "code",
  "em",
  "strong",
  "b",
  "i",
  "a",
  "time",
  "cite",
  "q",
]);
const FORM_INPUT_ELEMENTS = new Set(["input", "textarea", "select"]);
const MEDIA_ELEMENTS = new Set(["img", "video", "canvas", "svg"]);
const CONTAINER_ELEMENTS = new Set([
  "div",
  "section",
  "article",
  "nav",
  "header",
  "footer",
  "aside",
  "main",
  "ul",
  "ol",
  "form",
  "fieldset",
]);

/**
 * Gets key computed styles for the annotation popup display.
 * Returns different properties based on element type to show the most relevant
 * CSS properties for debugging (e.g., typography for text, layout for containers).
 */
export function getDetailedComputedStyles(target: HTMLElement): Record<string, string> {
  if (typeof window === "undefined") return {};

  const styles = window.getComputedStyle(target);
  const result: Record<string, string> = {};
  const tag = target.tagName.toLowerCase();

  // Select relevant properties based on element type
  let properties: string[];

  if (TEXT_ELEMENTS.has(tag)) {
    // Typography-focused for text elements
    properties = ["color", "fontSize", "fontWeight", "fontFamily", "lineHeight"];
  } else if (tag === "button" || (tag === "a" && target.getAttribute("role") === "button")) {
    // Appearance and spacing for interactive elements
    properties = ["backgroundColor", "color", "padding", "borderRadius", "fontSize"];
  } else if (FORM_INPUT_ELEMENTS.has(tag)) {
    // Form styling
    properties = ["backgroundColor", "color", "padding", "borderRadius", "fontSize"];
  } else if (MEDIA_ELEMENTS.has(tag)) {
    // Dimensions for media
    properties = ["width", "height", "objectFit", "borderRadius"];
  } else if (CONTAINER_ELEMENTS.has(tag)) {
    // Layout-focused for containers
    properties = ["display", "padding", "margin", "gap", "backgroundColor"];
  } else {
    // Default fallback
    properties = ["color", "fontSize", "margin", "padding", "backgroundColor"];
  }

  for (const prop of properties) {
    const cssPropertyName = prop.replace(/([A-Z])/g, "-$1").toLowerCase();
    const value = styles.getPropertyValue(cssPropertyName);
    if (value && !DEFAULT_STYLE_VALUES.has(value)) {
      result[prop] = value;
    }
  }

  return result;
}

// Comprehensive list of CSS properties for forensic output
const FORENSIC_PROPERTIES = [
  // Colors
  "color",
  "backgroundColor",
  "borderColor",
  // Typography
  "fontSize",
  "fontWeight",
  "fontFamily",
  "lineHeight",
  "letterSpacing",
  "textAlign",
  // Box model
  "width",
  "height",
  "padding",
  "margin",
  "border",
  "borderRadius",
  // Layout & positioning
  "display",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "zIndex",
  "flexDirection",
  "justifyContent",
  "alignItems",
  "gap",
  // Visual effects
  "opacity",
  "visibility",
  "overflow",
  "boxShadow",
  // Transform
  "transform",
];

/**
 * Gets full computed styles for forensic output.
 * Returns a comprehensive semicolon-separated string of all relevant CSS properties
 * for maximum debugging detail in the forensic output format.
 */
export function getForensicComputedStyles(target: HTMLElement): string {
  if (typeof window === "undefined") return "";

  const styles = window.getComputedStyle(target);
  const parts: string[] = [];

  for (const prop of FORENSIC_PROPERTIES) {
    const cssPropertyName = prop.replace(/([A-Z])/g, "-$1").toLowerCase();
    const value = styles.getPropertyValue(cssPropertyName);
    if (value && !DEFAULT_STYLE_VALUES.has(value)) {
      parts.push(`${cssPropertyName}: ${value}`);
    }
  }

  return parts.join("; ");
}

/**
 * Parses a forensic computed styles string back into a Record.
 * Inverse of getForensicComputedStyles - used when editing annotations.
 */
export function parseComputedStylesString(
  stylesStr: string | undefined,
): Record<string, string> | undefined {
  if (!stylesStr) return undefined;

  const result: Record<string, string> = {};
  const parts = stylesStr
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);

  for (const part of parts) {
    const colonIndex = part.indexOf(":");
    if (colonIndex > 0) {
      const key = part.slice(0, colonIndex).trim();
      const value = part.slice(colonIndex + 1).trim();
      if (key && value) {
        result[key] = value;
      }
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Gets accessibility information for an element
 */
export function getAccessibilityInfo(target: HTMLElement): string {
  const parts: string[] = [];

  const role = target.getAttribute("role");
  const ariaLabel = target.getAttribute("aria-label");
  const ariaDescribedBy = target.getAttribute("aria-describedby");
  const tabIndex = target.getAttribute("tabindex");
  const ariaHidden = target.getAttribute("aria-hidden");

  if (role) parts.push(`role="${role}"`);
  if (ariaLabel) parts.push(`aria-label="${ariaLabel}"`);
  if (ariaDescribedBy) parts.push(`aria-describedby="${ariaDescribedBy}"`);
  if (tabIndex) parts.push(`tabindex=${tabIndex}`);
  if (ariaHidden === "true") parts.push("aria-hidden");

  // Check focusability
  const focusable = target.matches("a, button, input, select, textarea, [tabindex]");
  if (focusable) parts.push("focusable");

  return parts.join(", ");
}

/**
 * Gets full DOM ancestry path (for forensic mode).
 * Supports elements inside shadow DOM by marking shadow boundary crossings.
 */
export function getFullElementPath(target: HTMLElement): string {
  const parts: string[] = [];
  let current: HTMLElement | null = target;

  while (current && current.tagName.toLowerCase() !== "html") {
    const tag = current.tagName.toLowerCase();
    let identifier = tag;

    if (current.id) {
      identifier = `${tag}#${current.id}`;
    } else if (current.className && typeof current.className === "string") {
      const cls = current.className
        .split(/\s+/)
        .map((c) => c.replace(/[_][a-zA-Z0-9]{5,}.*$/, ""))
        .find((c) => c.length > 2);
      if (cls) identifier = `${tag}.${cls}`;
    }

    // Mark shadow boundary crossings
    const nextParent = getParentElement(current);
    if (!current.parentElement && nextParent) {
      identifier = `⟨shadow⟩ ${identifier}`;
    }

    parts.unshift(identifier);
    current = nextParent as HTMLElement | null;
  }

  return parts.join(" > ");
}
