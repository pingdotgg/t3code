const STYLE_KEYS = [
  "display",
  "position",
  "color",
  "backgroundColor",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "padding",
  "margin",
  "border",
  "borderRadius",
] as const;

function getParentElement(element: Element): Element | null {
  if (element.parentElement) {
    return element.parentElement;
  }
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}...` : value;
}

function isMeaningfulClassToken(value: string): boolean {
  if (value.length < 3) {
    return false;
  }
  if (/^[a-z]{1,2}$/i.test(value)) {
    return false;
  }
  if (/^(?=.*\d)[a-z0-9]+$/i.test(value) && value.length >= 5) {
    return false;
  }
  if (/^[a-f0-9]{6,}$/i.test(value)) {
    return false;
  }
  return true;
}

function getMeaningfulClassTokens(className: string): string[] {
  return Array.from(
    new Set(
      className
        .split(/\s+/)
        .flatMap((name) => name.split(/[_-]+/))
        .map((token) => token.trim())
        .filter(isMeaningfulClassToken),
    ),
  ).slice(0, 6);
}

function getPathSegment(element: HTMLElement): string {
  const tagName = element.tagName.toLowerCase();
  if (element.id) {
    return `#${element.id}`;
  }
  const classes = getMeaningfulClassTokens(element.className);
  if (classes[0]) {
    return `.${classes[0]}`;
  }
  return tagName;
}

function getTextValue(element: HTMLElement): string | null {
  const text = element.textContent?.replace(/\s+/g, " ").trim() ?? "";
  return text.length > 0 ? text : null;
}

function getElementSummary(element: HTMLElement): string {
  const tagName = element.tagName.toLowerCase();
  const text = getTextValue(element);
  if (tagName === "button" && text) {
    return `button "${truncate(text, 24)}"`;
  }
  if ((tagName === "span" || tagName === "label") && text && text.length < 36) {
    return `"${text}"`;
  }
  return tagName;
}

export function getElementPath(target: HTMLElement, maxDepth = 4): string {
  const parts: string[] = [];
  let current: HTMLElement | null = target;
  let depth = 0;

  while (current && depth < maxDepth) {
    const tagName = current.tagName.toLowerCase();
    if (tagName === "html" || tagName === "body") {
      break;
    }
    parts.unshift(getPathSegment(current));
    current = getParentElement(current) as HTMLElement | null;
    depth += 1;
  }

  return parts.join(" > ");
}

export function getFullElementPath(target: HTMLElement): string | null {
  const parts: string[] = [];
  let current: HTMLElement | null = target;

  while (current) {
    const tagName = current.tagName.toLowerCase();
    parts.unshift(tagName);
    if (tagName === "html") {
      break;
    }
    current = getParentElement(current) as HTMLElement | null;
  }

  return parts.length > 0 ? parts.join(" > ") : null;
}

export function identifyElement(target: HTMLElement): { name: string; path: string } {
  const path = getElementPath(target);
  if (target.dataset.element) {
    return { name: target.dataset.element, path };
  }

  const tagName = target.tagName.toLowerCase();
  const text = getTextValue(target);
  const ariaLabel = target.getAttribute("aria-label");

  if (tagName === "button") {
    return {
      name: ariaLabel
        ? `button [${ariaLabel}]`
        : text
          ? `button "${truncate(text, 25)}"`
          : "button",
      path,
    };
  }
  if (tagName === "a") {
    const href = target.getAttribute("href");
    return {
      name: text ? `link "${truncate(text, 25)}"` : href ? `link to ${truncate(href, 30)}` : "link",
      path,
    };
  }
  if (tagName === "input") {
    const type = target.getAttribute("type") || "text";
    const placeholder = target.getAttribute("placeholder");
    const name = target.getAttribute("name");
    return {
      name: placeholder ? `input "${placeholder}"` : name ? `input [${name}]` : `${type} input`,
      path,
    };
  }
  if (/^h[1-6]$/.test(tagName)) {
    return { name: text ? `${tagName} "${truncate(text, 35)}"` : tagName, path };
  }
  if (tagName === "p") {
    return {
      name: text ? `paragraph: "${truncate(text, 40)}"` : "paragraph",
      path,
    };
  }
  if (tagName === "span" || tagName === "label") {
    return { name: text && text.length < 40 ? `"${text}"` : tagName, path };
  }
  if (tagName === "li") {
    return { name: text ? `list item: "${truncate(text, 35)}"` : "list item", path };
  }
  if (tagName === "img") {
    const alt = target.getAttribute("alt");
    return { name: alt ? `image "${truncate(alt, 30)}"` : "image", path };
  }
  if (["div", "section", "article", "nav", "header", "footer", "aside", "main"].includes(tagName)) {
    const role = target.getAttribute("role");
    if (ariaLabel) {
      return { name: `${tagName} [${ariaLabel}]`, path };
    }
    if (role) {
      return { name: role, path };
    }
    const classes = getMeaningfulClassTokens(target.className);
    return {
      name: classes.length > 0 ? classes.join(" ") : tagName === "div" ? "container" : tagName,
      path,
    };
  }

  return { name: tagName, path };
}

export function getNearbyText(element: HTMLElement): string | null {
  const texts: string[] = [];
  const ownText = getTextValue(element);

  if (ownText && ownText.length < 100) {
    texts.push(ownText);
  }

  const previousText = element.previousElementSibling?.textContent?.replace(/\s+/g, " ").trim();
  if (previousText && previousText.length < 50) {
    texts.unshift(`[before: "${truncate(previousText, 40)}"]`);
  }

  const nextText = element.nextElementSibling?.textContent?.replace(/\s+/g, " ").trim();
  if (nextText && nextText.length < 50) {
    texts.push(`[after: "${truncate(nextText, 40)}"]`);
  }

  return texts.length > 0 ? texts.join(" ") : null;
}

export function getNearbyElements(element: HTMLElement): string | null {
  const siblings = [element.previousElementSibling, element.nextElementSibling]
    .filter((candidate): candidate is HTMLElement => candidate instanceof HTMLElement)
    .map((candidate) => getElementSummary(candidate));

  return siblings.length > 0 ? siblings.join(", ") : null;
}

export function getElementClasses(target: HTMLElement): string | null {
  if (typeof target.className !== "string" || target.className.trim().length === 0) {
    return null;
  }
  const classes = getMeaningfulClassTokens(target.className);
  return classes.length > 0 ? classes.join(", ") : null;
}

export function getDetailedComputedStyles(target: HTMLElement): Record<string, string> {
  const styles = window.getComputedStyle(target);
  const result: Record<string, string> = {};

  for (const key of STYLE_KEYS) {
    const value = styles[key];
    if (!value || value === "normal" || value === "none" || value === "0px none rgb(0, 0, 0)") {
      continue;
    }
    result[key] = value;
  }

  return result;
}

export function getAccessibilityInfo(target: HTMLElement): string | null {
  const entries: string[] = [];
  const role = target.getAttribute("role");
  const ariaLabel = target.getAttribute("aria-label");
  const ariaLabelledBy = target.getAttribute("aria-labelledby");
  const type = target.getAttribute("type");
  const name = target.getAttribute("name");

  if (role) {
    entries.push(`role: ${role}`);
  }
  if (ariaLabel) {
    entries.push(`aria-label="${ariaLabel}"`);
  }
  if (ariaLabelledBy) {
    entries.push(`aria-labelledby="${ariaLabelledBy}"`);
  }
  if (type) {
    entries.push(`type="${type}"`);
  }
  if (name) {
    entries.push(`name="${name}"`);
  }
  if ((target as HTMLInputElement).required) {
    entries.push("required");
  }
  if ((target as HTMLInputElement).disabled) {
    entries.push("disabled");
  }

  return entries.length > 0 ? entries.join("; ") : null;
}
