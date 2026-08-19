import type { ThemeColorRole } from "../../themePalette";

export type ThemePaintKind = "background" | "border" | "foreground";

export type ThemeElementInspection = Readonly<{
  element: Element;
  role: ThemeColorRole;
}>;

const THEME_PAINT_KIND_ORDER: ReadonlyArray<ThemePaintKind> = [
  "background",
  "border",
  "foreground",
];

export const THEME_INSPECTOR_MATCH_ATTRIBUTE = "data-theme-inspector-match";

const THEME_HOVER_ID = "theme-inspector-hover";

type ThemeRoleMapping = ThemeColorRole | ReadonlyArray<ThemeColorRole>;

const THEME_UTILITY_ROLES: Readonly<Partial<Record<string, ThemeRoleMapping>>> = {
  background: "canvas",
  foreground: "text",
  card: "surface",
  "card-foreground": ["text", "surface"],
  popover: "surfaceOverlay",
  "popover-foreground": ["text", "surfaceOverlay"],
  "surface-raised": "surfaceRaised",
  primary: "messageAction",
  "primary-foreground": "messageAction",
  secondary: "secondary",
  "secondary-foreground": ["text", "secondary"],
  muted: "secondary",
  "muted-foreground": "mutedForeground",
  placeholder: ["mutedForeground", "surfaceRaised"],
  "secondary-label": "mutedForeground",
  "icon-muted": "mutedForeground",
  accent: "accentSurface",
  "accent-foreground": ["text", "accentSurface"],
  destructive: "error",
  "destructive-foreground": ["error", "canvas"],
  error: "error",
  "error-foreground": ["error", "canvas"],
  "error-surface": ["error", "canvas"],
  warning: "warning",
  "warning-foreground": ["warning", "canvas"],
  "warning-surface": ["warning", "canvas"],
  update: "accent",
  "update-foreground": ["accent", "canvas"],
  "update-surface": ["accent", "canvas"],
  message: "messageSurface",
  "message-foreground": ["text", "messageSurface"],
  "message-action": "messageAction",
  "message-action-foreground": "messageAction",
  "message-action-hover": ["messageAction", "text"],
  sidebar: "sidebar",
  "sidebar-foreground": ["text", "sidebar"],
  "sidebar-muted-foreground": ["mutedForeground", "sidebar"],
  "sidebar-control-surface": "sidebarControlSurface",
  "sidebar-row-hover": ["sidebar", "sidebarRowSelected"],
  "sidebar-row-active": ["sidebar", "sidebarRowSelected"],
  "sidebar-row-selected": "sidebarRowSelected",
  "sidebar-border": "border",
  border: "border",
  input: "input",
  ring: "accent",
};

const THEME_CLASS_ROLES: Readonly<Partial<Record<string, ThemeRoleMapping>>> = {
  "surface-glass": "canvas",
  "dialog-glass": ["canvas", "text"],
  "alert-glass": "canvas",
  "chat-markdown-codeblock": ["codeBackground", "text"],
  "file-preview-virtualizer": ["codeBackground", "text"],
  // StyledDiffCodeView deliberately aliases its code surface to the app canvas.
  "diff-render-surface": ["canvas", "text"],
};

const THEME_UTILITY_PREFIXES: Readonly<Record<ThemePaintKind, ReadonlyArray<string>>> = {
  background: ["bg-"],
  border: ["border-", "outline-", "ring-"],
  foreground: ["text-", "caret-", "fill-", "stroke-"],
};

const THEME_RESPONSIVE_VARIANTS: Readonly<Record<string, number>> = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  "2xl": 1536,
};

function themeUtilityVariantIsActive(element: Element, variant: string): boolean {
  if (variant === "dark") return document.documentElement.classList.contains("dark");
  const breakpoint = THEME_RESPONSIVE_VARIANTS[variant];
  if (breakpoint !== undefined) return window.matchMedia(`(min-width: ${breakpoint}px)`).matches;

  const dataAttribute = /^data-\[([^=\]]+)=([^\]]+)\]$/.exec(variant);
  if (dataAttribute) return element.getAttribute(`data-${dataAttribute[1]}`) === dataAttribute[2];
  if (variant.startsWith("data-")) return element.hasAttribute(variant);
  if (variant.startsWith("aria-")) {
    return element.getAttribute(variant) === "true";
  }

  try {
    return element.matches(`:${variant}`);
  } catch {
    // Unknown compound variants are omitted rather than highlighting a token
    // that the browser is not currently painting.
    return false;
  }
}

function themeUtilityIsActive(element: Element, className: string): boolean {
  const variants = className.split(":").slice(0, -1);
  return variants.every((variant) => themeUtilityVariantIsActive(element, variant));
}

function clearThemeInspectorAttribute(attribute: string): void {
  document
    .querySelectorAll(`[${attribute}]`)
    .forEach((element) => element.removeAttribute(attribute));
}

export function clearThemeInspectorHighlights(): void {
  clearThemeInspectorAttribute(THEME_INSPECTOR_MATCH_ATTRIBUTE);
}

export function clearThemeInspectorHover(): void {
  document.getElementById(THEME_HOVER_ID)?.remove();
}

function spotlightRect(element: Element): {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
} | null {
  const bounds = element.getBoundingClientRect();
  if (
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    bounds.right < 0 ||
    bounds.bottom < 0 ||
    bounds.left > window.innerWidth ||
    bounds.top > window.innerHeight
  ) {
    return null;
  }

  const padding = 5;
  // Keep the true bounds when an element is partially offscreen. Clamping its
  // rectangle to the viewport would draw a fake glow edge along the crop.
  const x = bounds.left - padding;
  const y = bounds.top - padding;
  const elementRadius =
    Number.parseFloat(window.getComputedStyle(element).borderTopLeftRadius) || 0;
  return {
    x,
    y,
    width: bounds.width + padding * 2,
    height: bounds.height + padding * 2,
    radius: Math.min(18, Math.max(7, elementRadius + padding)),
  };
}

export function showThemeInspectorHover(inspection: ThemeElementInspection, label: string): void {
  const rectangle = spotlightRect(inspection.element);
  if (!rectangle) {
    clearThemeInspectorHover();
    return;
  }

  let hover = document.getElementById(THEME_HOVER_ID);
  if (!hover) {
    hover = document.createElement("div");
    hover.id = THEME_HOVER_ID;
    hover.setAttribute("aria-hidden", "true");
    const tokenLabel = document.createElement("span");
    tokenLabel.dataset.themeInspectorHoverLabel = "";
    hover.append(tokenLabel);
    document.body.append(hover);
  }

  hover.style.left = `${rectangle.x}px`;
  hover.style.top = `${rectangle.y}px`;
  hover.style.width = `${rectangle.width}px`;
  hover.style.height = `${rectangle.height}px`;
  hover.style.borderRadius = `${rectangle.radius}px`;
  hover.dataset.placement = rectangle.y < 32 ? "below" : "above";
  const tokenLabel = hover.querySelector<HTMLElement>("[data-theme-inspector-hover-label]");
  if (tokenLabel) tokenLabel.textContent = label;
}

function themeInspectorCandidates(): ReadonlyArray<Element> {
  return [document.body, ...document.body.querySelectorAll("*")].filter(
    (element) =>
      !element.closest("[data-theme-editor-panel]") && !element.closest(`#${THEME_HOVER_ID}`),
  );
}

function themeRoles(mapping: ThemeRoleMapping | undefined): ReadonlyArray<ThemeColorRole> {
  if (!mapping) return [];
  return typeof mapping === "string" ? [mapping] : mapping;
}

function themeRolesFromUtilityClass(
  element: Element,
  className: string,
  kind: ThemePaintKind,
  includeVariants: boolean,
): ReadonlyArray<ThemeColorRole> {
  if (!includeVariants && className.includes(":")) return [];
  if (!themeUtilityIsActive(element, className)) return [];
  const utility = className.split(":").at(-1) ?? className;
  for (const prefix of THEME_UTILITY_PREFIXES[kind]) {
    if (!utility.startsWith(prefix)) continue;
    const colorName = utility.slice(prefix.length).split("/", 1)[0] ?? "";
    return themeRoles(THEME_UTILITY_ROLES[colorName]);
  }
  return [];
}

function themeRolesFromUtilities(
  element: Element,
  includeVariants: boolean,
): ReadonlySet<ThemeColorRole> {
  const roles = new Set<ThemeColorRole>();
  if (element.classList.contains("alert-glass")) {
    if (element.getAttribute("data-variant") === "error") roles.add("error");
    if (element.getAttribute("data-variant") === "warning") roles.add("warning");
  }
  if (element.closest("[data-chat-header]")) {
    if (
      element.matches(
        ':is([data-slot="button"], [data-slot="menu-trigger"], [data-toolbar-control])',
      )
    ) {
      // These controls are painted by the themed chat-header bridge instead
      // of semantic utility classes. Keep background first for click-to-pick.
      roles.add("secondary");
      roles.add("border");
      roles.add("text");
    }
    if (element.matches('[data-slot="separator"]')) roles.add("border");
  }
  for (const className of element.classList) {
    for (const role of themeRoles(THEME_CLASS_ROLES[className])) roles.add(role);
  }
  if (element.hasAttribute("data-theme-terminal-surface")) {
    roles.add("terminalBackground");
    roles.add("text");
  }
  if (element.hasAttribute("data-theme-code-surface")) {
    roles.add("codeBackground");
    roles.add("text");
  }
  for (const kind of THEME_PAINT_KIND_ORDER) {
    for (const className of element.classList) {
      for (const role of themeRolesFromUtilityClass(element, className, kind, includeVariants)) {
        roles.add(role);
      }
    }
  }
  return roles;
}

function elementUsesThemeRole(
  element: Element,
  selectedRoles: ReadonlySet<ThemeColorRole>,
): boolean {
  for (const role of themeRolesFromUtilities(element, true)) {
    if (selectedRoles.has(role)) return true;
  }
  return false;
}

function themeRoleFromUtilities(element: Element): ThemeColorRole | null {
  return themeRolesFromUtilities(element, false).values().next().value ?? null;
}

function themeInspectionCandidates(initialElement: Element): ReadonlyArray<Element> {
  const candidates: Array<Element> = [];
  let element: Element | null = initialElement;
  while (element && element !== document.documentElement) {
    if (!element.closest("[data-theme-editor-panel]")) candidates.push(element);
    element = element.parentElement;
  }
  return candidates;
}

export function inspectThemeRoleFromUtilitiesAtElement(
  initialElement: Element,
): ThemeElementInspection | null {
  if (initialElement.closest("[data-theme-editor-panel]")) return null;
  for (const candidate of themeInspectionCandidates(initialElement)) {
    const role = themeRoleFromUtilities(candidate);
    if (role) return { element: candidate, role };
  }
  return null;
}

/** Highlights semantic utility uses without mutating the live theme. */
export function highlightThemeRoleUsage(roles: ReadonlyArray<ThemeColorRole>): number {
  clearThemeInspectorAttribute(THEME_INSPECTOR_MATCH_ATTRIBUTE);
  const candidates = themeInspectorCandidates();
  const selectedRoles = new Set(roles);
  const matches = candidates.filter((element) => elementUsesThemeRole(element, selectedRoles));

  const highlightedElements = new Set<Element>();
  for (const element of matches) {
    highlightedElements.add(
      element instanceof SVGElement ? (element.closest("svg") ?? element) : element,
    );
  }
  for (const element of highlightedElements) {
    element.setAttribute(THEME_INSPECTOR_MATCH_ATTRIBUTE, "");
  }
  return highlightedElements.size;
}

/** Resolves the nearest semantic color utility at a touched element. */
export function inspectThemeRoleAtElement(initialElement: Element): ThemeElementInspection | null {
  return inspectThemeRoleFromUtilitiesAtElement(initialElement);
}
