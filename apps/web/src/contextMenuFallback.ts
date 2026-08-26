import type { ContextMenuItem } from "@t3tools/contracts";

import { toastManager } from "./components/ui/toast";

const SVG_NS = "http://www.w3.org/2000/svg";

// Inline Lucide-style icon paths (stroke-based, viewBox 0 0 24 24, strokeWidth 2).
const ICON_PATHS: Record<string, ReadonlyArray<{ tag: string; attrs: Record<string, string> }>> = {
  "alarm-clock-off": [
    { tag: "path", attrs: { d: "M6.87 6.87a8 8 0 1 0 11.26 11.26" } },
    { tag: "path", attrs: { d: "M19.9 14.25a8 8 0 0 0-9.15-9.15" } },
    { tag: "path", attrs: { d: "m22 6-3-3" } },
    { tag: "path", attrs: { d: "M6.26 18.67 4 21" } },
    { tag: "path", attrs: { d: "m2 2 20 20" } },
    { tag: "path", attrs: { d: "M4 4 2 6" } },
  ],
  archive: [
    { tag: "rect", attrs: { width: "20", height: "5", x: "2", y: "3", rx: "1" } },
    { tag: "path", attrs: { d: "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" } },
    { tag: "path", attrs: { d: "M10 12h4" } },
  ],
  check: [{ tag: "path", attrs: { d: "M20 6 9 17l-5-5" } }],
  "check-check": [
    { tag: "path", attrs: { d: "M18 6 7 17l-5-5" } },
    { tag: "path", attrs: { d: "m22 10-7.5 7.5L13 16" } },
  ],
  "chevron-right": [{ tag: "path", attrs: { d: "m9 19 7-7-7-7" } }],
  "circle-check": [
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "10" } },
    { tag: "path", attrs: { d: "m9 12 2 2 4-4" } },
  ],
  clipboard: [
    { tag: "rect", attrs: { width: "8", height: "4", x: "8", y: "2", rx: "1", ry: "1" } },
    {
      tag: "path",
      attrs: { d: "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" },
    },
  ],
  clock: [
    { tag: "path", attrs: { d: "M12 6v6l4 2" } },
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "10" } },
  ],
  copy: [
    { tag: "rect", attrs: { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2" } },
    { tag: "path", attrs: { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" } },
  ],
  folder: [
    {
      tag: "path",
      attrs: {
        d: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
      },
    },
  ],
  "folder-tree": [
    {
      tag: "path",
      attrs: {
        d: "M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z",
      },
    },
    {
      tag: "path",
      attrs: {
        d: "M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z",
      },
    },
    { tag: "path", attrs: { d: "M3 5a2 2 0 0 0 2 2h3" } },
    { tag: "path", attrs: { d: "M3 3v13a2 2 0 0 0 2 2h3" } },
  ],
  "git-branch": [
    { tag: "line", attrs: { x1: "6", x2: "6", y1: "3", y2: "15" } },
    { tag: "circle", attrs: { cx: "18", cy: "6", r: "3" } },
    { tag: "circle", attrs: { cx: "6", cy: "18", r: "3" } },
    { tag: "path", attrs: { d: "M18 9a9 9 0 0 1-9 9" } },
  ],
  hash: [
    { tag: "line", attrs: { x1: "4", x2: "20", y1: "9", y2: "9" } },
    { tag: "line", attrs: { x1: "4", x2: "20", y1: "15", y2: "15" } },
    { tag: "line", attrs: { x1: "10", x2: "8", y1: "3", y2: "21" } },
    { tag: "line", attrs: { x1: "16", x2: "14", y1: "3", y2: "21" } },
  ],
  mail: [
    { tag: "path", attrs: { d: "m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7" } },
    { tag: "rect", attrs: { x: "2", y: "4", width: "20", height: "16", rx: "2" } },
  ],
  "mail-open": [
    {
      tag: "path",
      attrs: {
        d: "M21.2 8.4c.5.38.8.97.8 1.6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 .8-1.6l8-6a2 2 0 0 1 2.4 0l8 6Z",
      },
    },
    { tag: "path", attrs: { d: "m22 10-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 10" } },
  ],
  "message-square-plus": [
    {
      tag: "path",
      attrs: {
        d: "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z",
      },
    },
    { tag: "path", attrs: { d: "M12 8v6" } },
    { tag: "path", attrs: { d: "M9 11h6" } },
  ],
  pencil: [
    {
      tag: "path",
      attrs: {
        d: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",
      },
    },
    { tag: "path", attrs: { d: "m15 5 4 4" } },
  ],
  pin: [
    { tag: "path", attrs: { d: "M12 17v5" } },
    {
      tag: "path",
      attrs: {
        d: "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z",
      },
    },
  ],
  "pin-off": [
    { tag: "path", attrs: { d: "M12 17v5" } },
    { tag: "path", attrs: { d: "M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89" } },
    { tag: "path", attrs: { d: "m2 2 20 20" } },
    {
      tag: "path",
      attrs: {
        d: "M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11",
      },
    },
  ],
  "refresh-cw": [
    { tag: "path", attrs: { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" } },
    { tag: "path", attrs: { d: "M21 3v5h-5" } },
    { tag: "path", attrs: { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" } },
    { tag: "path", attrs: { d: "M8 16H3v5" } },
  ],
  scissors: [
    { tag: "circle", attrs: { cx: "6", cy: "6", r: "3" } },
    { tag: "circle", attrs: { cx: "6", cy: "18", r: "3" } },
    { tag: "line", attrs: { x1: "20", x2: "8.12", y1: "4", y2: "15.88" } },
    { tag: "line", attrs: { x1: "14.47", x2: "20", y1: "14.48", y2: "20" } },
    { tag: "line", attrs: { x1: "8.12", x2: "12", y1: "8.12", y2: "12" } },
  ],
  sparkles: [
    {
      tag: "path",
      attrs: {
        d: "M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z",
      },
    },
    { tag: "path", attrs: { d: "M20 2v4" } },
    { tag: "path", attrs: { d: "M22 4h-4" } },
    { tag: "circle", attrs: { cx: "4", cy: "20", r: "2" } },
  ],
  trash: [
    { tag: "path", attrs: { d: "M3 6h18" } },
    { tag: "path", attrs: { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" } },
    { tag: "path", attrs: { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" } },
    { tag: "line", attrs: { x1: "10", x2: "10", y1: "11", y2: "17" } },
    { tag: "line", attrs: { x1: "14", x2: "14", y1: "11", y2: "17" } },
  ],
  "undo-2": [
    { tag: "path", attrs: { d: "M9 14 4 9l5-5" } },
    {
      tag: "path",
      attrs: { d: "M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" },
    },
  ],
};

export type ContextMenuTone = "neutral" | "destructive" | "warning";

export function resolveItemTone<T extends string>(item: ContextMenuItem<T>): ContextMenuTone {
  if (item.destructive === true || item.tone === "destructive" || item.id === "delete") {
    return "destructive";
  }
  if (item.tone === "warning") {
    return "warning";
  }
  return "neutral";
}

function createIconElement(name: string, tone: ContextMenuTone): SVGSVGElement | null {
  const paths = ICON_PATHS[name];
  if (!paths || typeof document.createElementNS !== "function") {
    return null;
  }
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute(
    "class",
    tone === "destructive"
      ? "size-4.5 shrink-0 text-destructive-foreground sm:size-4"
      : tone === "warning"
        ? "size-4.5 shrink-0 text-warning-foreground sm:size-4"
        : "size-4.5 shrink-0 text-muted-foreground sm:size-4",
  );
  svg.style.cssText = "pointer-events:none;";
  for (const node of paths) {
    const child = document.createElementNS(SVG_NS, node.tag);
    for (const [key, value] of Object.entries(node.attrs)) {
      child.setAttribute(key, value);
    }
    svg.appendChild(child);
  }
  return svg;
}

function clampMenuPosition(menu: HTMLDivElement, preferredLeft: number, preferredTop: number) {
  const rect = menu.getBoundingClientRect();
  const left = Math.min(
    Math.max(4, preferredLeft),
    Math.max(4, window.innerWidth - rect.width - 4),
  );
  const top = Math.min(
    Math.max(4, preferredTop),
    Math.max(4, window.innerHeight - rect.height - 4),
  );
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function isNodeWithinMenuStack(target: EventTarget | null, menuStack: readonly HTMLDivElement[]) {
  if (typeof Node !== "undefined" && target instanceof Node) {
    return menuStack.some((menu) => menu.contains(target));
  }
  if (!target || typeof target !== "object") {
    return false;
  }

  let current: unknown = target;
  while (current && typeof current === "object") {
    if (menuStack.includes(current as HTMLDivElement)) {
      return true;
    }
    current = (current as { parent?: unknown }).parent;
  }
  return false;
}

function findContentEditableHost(element: HTMLElement): HTMLElement | null {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const contentEditable = current.getAttribute("contenteditable");
    if (contentEditable !== null) {
      return contentEditable.toLowerCase() === "false" || !current.isContentEditable
        ? null
        : current;
    }
  }
  return null;
}

// Only one fallback menu exists at a time in the renderer; the active one is
// tracked so a state change (for example a terminal selection clearing) can
// dismiss it with the same result as an outside click or Escape.
let activeContextMenuDismiss: (() => void) | null = null;

/**
 * Closes the currently open fallback context menu, resolving its show() with
 * null (the same result as dismissing by outside click or Escape). No-op when
 * no fallback menu is open.
 */
export function dismissContextMenu(): void {
  activeContextMenuDismiss?.();
  activeContextMenuDismiss = null;
}

/**
 * Imperative DOM-based context menu for non-Electron environments.
 * Supports nested submenus and resolves with the clicked leaf item id.
 */
export function showContextMenuFallback<T extends string>(
  items: readonly ContextMenuItem<T>[],
  position?: { x: number; y: number },
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const previouslyFocusedElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const menuStack: HTMLDivElement[] = [];
    const submenuTriggerStack: Array<HTMLButtonElement | undefined> = [];
    let isDisposed = false;
    let canDismissFromPointer = false;

    const dismiss = () => cleanup(null);

    const focusMenuItem = (direction: 1 | -1): boolean => {
      const menu = menuStack.at(-1);
      if (!menu) {
        return false;
      }
      const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button")].filter(
        (button) => !button.disabled,
      );
      if (buttons.length === 0) {
        return false;
      }
      const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const nextIndex =
        currentIndex < 0
          ? direction === 1
            ? 0
            : buttons.length - 1
          : (currentIndex + direction + buttons.length) % buttons.length;
      buttons[nextIndex]?.focus({
        preventScroll: true,
      });
      return true;
    };

    const cleanup = (result: T | null) => {
      if (isDisposed) {
        return;
      }
      isDisposed = true;
      if (activeContextMenuDismiss === dismiss) {
        activeContextMenuDismiss = null;
      }
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("contextmenu", onContextMenu, true);
      const shouldRestoreFocus = isNodeWithinMenuStack(document.activeElement, menuStack);
      for (const menu of menuStack) {
        menu.remove();
      }
      if (shouldRestoreFocus && previouslyFocusedElement?.isConnected) {
        previouslyFocusedElement.focus({ preventScroll: true });
      }
      resolve(result);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cleanup(null);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (focusMenuItem(event.key === "ArrowDown" ? 1 : -1)) {
          event.preventDefault();
        }
      } else if (event.key === "ArrowLeft" && menuStack.length > 1) {
        const parentTrigger = submenuTriggerStack.at(-1);
        closeMenusFromLevel(menuStack.length - 1);
        parentTrigger?.focus({ preventScroll: true });
        event.preventDefault();
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      if (!canDismissFromPointer || isNodeWithinMenuStack(event.target, menuStack)) {
        return;
      }
      cleanup(null);
    };

    const onContextMenu = (event: MouseEvent) => {
      if (!canDismissFromPointer || isNodeWithinMenuStack(event.target, menuStack)) {
        return;
      }
      event.preventDefault();
      cleanup(null);
    };

    const closeMenusFromLevel = (level: number) => {
      while (menuStack.length > level) {
        submenuTriggerStack.pop()?.setAttribute("aria-expanded", "false");
        menuStack.pop()?.remove();
      }
    };

    const openMenu = (
      entries: readonly ContextMenuItem<T>[],
      preferredLeft: number,
      preferredTop: number,
      level: number,
      parentTrigger?: HTMLButtonElement,
    ) => {
      closeMenusFromLevel(level);

      const menu = document.createElement("div");
      menu.className =
        "dropdown-glass fixed z-[10000] min-w-32 max-w-sm overflow-hidden rounded-lg bg-clip-padding text-popover-foreground shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] outline-none dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]";
      menu.style.cssText =
        "position:fixed;z-index:10000;min-width:8rem;max-width:24rem;overflow:hidden;border-radius:var(--radius-lg);background-clip:padding-box;color:var(--contrast-popover-foreground);outline:none;pointer-events:auto;";
      menu.style.left = `${preferredLeft}px`;
      menu.style.top = `${preferredTop}px`;
      menu.dataset.level = String(level);

      const inner = document.createElement("div");
      inner.className =
        "max-h-[min(24rem,70vh)] min-w-0 max-w-sm overflow-y-auto overflow-x-hidden p-1";
      inner.style.cssText =
        "max-height:min(24rem,70vh);min-width:0;max-width:24rem;overflow-x:hidden;overflow-y:auto;padding:0.25rem;";

      for (const item of entries) {
        if (item.separatorBefore === true && inner.children.length > 0) {
          const separator = document.createElement("div");
          separator.className = "mx-2 my-1 h-px bg-border";
          separator.style.cssText =
            "height:1px;margin:0.25rem 0.5rem;background:var(--contrast-border,color-mix(in srgb, var(--contrast-foreground) 10%, transparent));";
          separator.dataset.contextMenuSeparator = "true";
          separator.setAttribute("role", "separator");
          inner.appendChild(separator);
        }

        if (item.header === true) {
          const header = document.createElement("div");
          header.className = "px-2 py-1.5 font-medium text-muted-foreground text-xs";
          header.textContent = item.label;
          inner.appendChild(header);
          continue;
        }

        const hasChildren = Array.isArray(item.children) && item.children.length > 0;
        const itemTone = hasChildren ? "neutral" : resolveItemTone(item);

        const button = document.createElement("button");
        button.type = "button";
        const isDisabled = item.disabled === true;
        button.disabled = isDisabled;
        const rowBase =
          "flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1 text-left outline-none transition-colors sm:min-h-7 sm:text-sm min-h-8 text-base";
        button.className = isDisabled
          ? `${rowBase} pointer-events-none cursor-not-allowed text-muted-foreground opacity-64`
          : itemTone === "destructive"
            ? `${rowBase} text-destructive-foreground hover:bg-destructive/10 hover:text-destructive-foreground`
            : itemTone === "warning"
              ? `${rowBase} text-warning-foreground hover:bg-warning/10 hover:text-warning-foreground`
              : `${rowBase} text-foreground hover:bg-accent hover:text-accent-foreground`;
        button.style.cssText =
          "display:flex;width:100%;min-height:1.75rem;align-items:center;gap:0.5rem;border:0;border-radius:var(--radius-sm);background:transparent;padding:0.25rem 0.5rem;color:var(--contrast-foreground);font-family:var(--font-sans,system-ui,sans-serif);font-size:0.875rem;line-height:1.25rem;text-align:left;cursor:default;";
        if (itemTone === "destructive") {
          button.style.color = "var(--destructive-foreground)";
        } else if (itemTone === "warning") {
          button.style.color = "var(--warning-foreground)";
        }
        if (isDisabled) {
          button.style.color = "var(--contrast-muted-foreground)";
          button.style.opacity = "0.64";
          button.style.pointerEvents = "none";
        }

        if (typeof item.icon === "string") {
          const icon = createIconElement(item.icon, isDisabled ? "neutral" : itemTone);
          if (icon) {
            button.appendChild(icon);
          }
        }

        const label = document.createElement("span");
        label.className = "min-w-0 flex-1 truncate";
        label.textContent = item.label;
        button.appendChild(label);

        if (hasChildren) {
          button.setAttribute("aria-haspopup", "menu");
          button.setAttribute("aria-expanded", "false");
          const chevron = createIconElement("chevron-right", "neutral");
          if (chevron) {
            chevron.setAttribute(
              "class",
              "-me-0.5 ms-auto size-4.5 shrink-0 text-muted-foreground opacity-80 sm:size-4",
            );
            chevron.style.cssText = "pointer-events:none;";
            chevron.setAttribute("aria-hidden", "true");
            chevron.dataset.contextMenuChevron = "true";
            button.appendChild(chevron);
          }
        }

        if (!isDisabled) {
          let isHovered = false;
          let isFocused = false;
          const updateHighlight = () => {
            const isHighlighted = isHovered || isFocused;
            if (isHighlighted) {
              if (itemTone === "destructive") {
                button.style.background = "color-mix(in srgb, var(--destructive) 10%, transparent)";
                button.style.color = "var(--destructive-foreground)";
              } else if (itemTone === "warning") {
                button.style.background = "color-mix(in srgb, var(--warning) 12%, transparent)";
                button.style.color = "var(--warning-foreground)";
              } else {
                button.style.background = "var(--accent)";
                button.style.color = "var(--contrast-accent-foreground)";
              }
            } else {
              button.style.background = "transparent";
              if (itemTone === "destructive") {
                button.style.color = "var(--destructive-foreground)";
              } else if (itemTone === "warning") {
                button.style.color = "var(--warning-foreground)";
              } else {
                button.style.color = "var(--contrast-foreground)";
              }
            }
          };
          button.addEventListener("mouseenter", () => {
            button.focus({ preventScroll: true });
            isHovered = true;
            updateHighlight();
          });
          button.addEventListener("mouseleave", () => {
            isHovered = false;
            updateHighlight();
          });
          button.addEventListener("focus", () => {
            isFocused = true;
            updateHighlight();
          });
          button.addEventListener("blur", () => {
            isFocused = false;
            updateHighlight();
          });
          button.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              button.click();
            }
          });

          if (hasChildren) {
            const openSubmenu = (focusFirstItem = false) => {
              const rect = button.getBoundingClientRect();
              const nextLeft = rect.right + 4;
              const nextTop = rect.top;
              openMenu(item.children!, nextLeft, nextTop, level + 1, button);
              button.setAttribute("aria-expanded", "true");

              const childMenu = menuStack[level + 1];
              if (!childMenu) {
                return;
              }
              const childRect = childMenu.getBoundingClientRect();
              if (childRect.right > window.innerWidth) {
                clampMenuPosition(childMenu, rect.left - childRect.width - 4, rect.top);
              }
              if (focusFirstItem) {
                [...childMenu.querySelectorAll<HTMLButtonElement>("button")]
                  .find((childButton) => !childButton.disabled)
                  ?.focus();
              }
            };
            button.addEventListener("keydown", (event) => {
              if (event.key !== "ArrowRight") {
                return;
              }
              event.preventDefault();
              openSubmenu(true);
            });
            button.addEventListener("mouseenter", () => {
              openSubmenu();
            });
            button.addEventListener("click", (event) => {
              event.preventDefault();
              openSubmenu(true);
            });
          } else {
            button.addEventListener("mouseenter", () => {
              closeMenusFromLevel(level + 1);
            });
            button.addEventListener("click", () => {
              if (canDismissFromPointer) cleanup(item.id);
            });
          }
        }

        inner.appendChild(button);
      }

      menu.appendChild(inner);

      menu.addEventListener("mouseenter", () => {
        closeMenusFromLevel(level + 1);
      });

      document.body.appendChild(menu);
      menuStack[level] = menu;
      submenuTriggerStack[level] = parentTrigger;

      requestAnimationFrame(() => {
        clampMenuPosition(menu, preferredLeft, preferredTop);
      });
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("contextmenu", onContextMenu, true);
    openMenu(items, position?.x ?? 0, position?.y ?? 0, 0);
    // Only one fallback menu can be open at a time: a new show must dismiss
    // any prior one, or its DOM and listeners leak and close() can only ever
    // reach the newest menu.
    if (activeContextMenuDismiss) {
      activeContextMenuDismiss();
    }
    activeContextMenuDismiss = dismiss;

    Array.from(menuStack[0]?.querySelectorAll<HTMLButtonElement>("button") ?? [])
      .find((button) => !button.disabled)
      ?.focus({ preventScroll: true });

    requestAnimationFrame(() => {
      canDismissFromPointer = true;
    });
  });
}

/**
 * Installs a global context menu listener that captures unhandled right-clicks
 * on text inputs, textareas, contenteditable elements, or selected text,
 * and presents the styled HTML context menu (Cut, Copy, Paste, Select all).
 */
export function installGlobalTextContextMenu(): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const handleContextMenu = (event: MouseEvent) => {
    // If another handler already called preventDefault(), do not intercept.
    if (event.defaultPrevented) {
      return;
    }

    const target = event.target;
    const isInputElement =
      target instanceof HTMLInputElement &&
      ["text", "search", "url", "tel", "password"].includes(target.type);
    if (target instanceof HTMLInputElement && !isInputElement) {
      return;
    }
    const isTextAreaElement = target instanceof HTMLTextAreaElement;
    const contentEditableHost =
      target instanceof HTMLElement ? findContentEditableHost(target) : null;
    const isContentEditable = contentEditableHost !== null;
    const isEditable = isInputElement || isTextAreaElement || isContentEditable;
    const canReadClipboard =
      typeof navigator !== "undefined" && typeof navigator.clipboard?.readText === "function";

    const selection = window.getSelection();
    const selectedText = selection?.toString() ?? "";
    const selectionRanges = selection
      ? Array.from({ length: selection.rangeCount }, (_, index) =>
          selection.getRangeAt(index).cloneRange(),
        )
      : [];
    const restoreWindowSelection = () => {
      if (!selection || selectionRanges.length === 0) {
        return;
      }
      selection.removeAllRanges();
      for (const range of selectionRanges) {
        selection.addRange(range);
      }
    };
    const hasWindowSelection = selectedText.trim().length > 0;

    let hasInputSelection = false;
    let isReadOnly = false;
    let hasValue = false;
    let inputSelection: { start: number; end: number } | null = null;

    if (isInputElement || isTextAreaElement) {
      const input = target as HTMLInputElement | HTMLTextAreaElement;
      isReadOnly = input.readOnly || input.disabled;
      // selectionStart throws InvalidStateError on number/date/range inputs.
      try {
        const start = input.selectionStart ?? 0;
        const end = input.selectionEnd ?? 0;
        inputSelection = { start, end };
        hasInputSelection = end > start;
      } catch {
        hasInputSelection = false;
      }
      hasValue = input.value.length > 0;
    } else if (contentEditableHost) {
      hasValue = (contentEditableHost.textContent ?? "").length > 0;
    }

    const hasSelection = isEditable
      ? isInputElement || isTextAreaElement
        ? hasInputSelection
        : hasWindowSelection
      : hasWindowSelection;

    // Only show our menu if right-clicking an editable element OR there is text selected.
    if (!isEditable && !hasSelection) {
      return;
    }

    event.preventDefault();

    const items: ContextMenuItem<string>[] = [];

    if (isEditable) {
      items.push(
        {
          id: "cut",
          label: "Cut",
          icon: "scissors",
          disabled: !hasSelection || isReadOnly,
        },
        {
          id: "copy",
          label: "Copy",
          icon: "copy",
          disabled: !hasSelection,
        },
        {
          id: "paste",
          label: "Paste",
          icon: "clipboard",
          disabled: isReadOnly || !canReadClipboard,
        },
        {
          id: "select-all",
          label: "Select all",
          icon: "check-check",
          separatorBefore: true,
          disabled: !hasValue && !hasWindowSelection,
        },
      );
    } else if (hasSelection) {
      items.push(
        {
          id: "copy",
          label: "Copy",
          icon: "copy",
        },
        {
          id: "select-all",
          label: "Select all",
          icon: "check-check",
          separatorBefore: true,
        },
      );
    }

    if (items.length === 0) {
      return;
    }

    void (async () => {
      const clicked = await showContextMenuFallback(items, {
        x: event.clientX,
        y: event.clientY,
      });

      if (!clicked) {
        return;
      }

      if (clicked === "cut") {
        if (isInputElement || isTextAreaElement) {
          const input = target as HTMLInputElement | HTMLTextAreaElement;
          try {
            const start = inputSelection?.start ?? input.selectionStart ?? 0;
            const end = inputSelection?.end ?? input.selectionEnd ?? 0;
            const text = input.value.slice(start, end);
            if (text) {
              try {
                await navigator.clipboard.writeText(text);
              } catch {
                document.execCommand("copy");
              }
              input.setRangeText("", start, end, "end");
              input.dispatchEvent(new Event("input", { bubbles: true }));
            }
          } catch {
            document.execCommand("cut");
          }
        } else {
          restoreWindowSelection();
          document.execCommand("cut");
        }
      } else if (clicked === "copy") {
        if (isInputElement || isTextAreaElement) {
          const input = target as HTMLInputElement | HTMLTextAreaElement;
          try {
            const start = inputSelection?.start ?? input.selectionStart ?? 0;
            const end = inputSelection?.end ?? input.selectionEnd ?? 0;
            const text = input.value.slice(start, end);
            if (text) {
              try {
                await navigator.clipboard.writeText(text);
              } catch {
                document.execCommand("copy");
              }
            }
          } catch {
            document.execCommand("copy");
          }
        } else {
          restoreWindowSelection();
          const text = selectedText;
          if (text) {
            try {
              await navigator.clipboard.writeText(text);
            } catch {
              document.execCommand("copy");
            }
          }
        }
      } else if (clicked === "paste") {
        try {
          const text = await navigator.clipboard.readText();
          if (isInputElement || isTextAreaElement) {
            const input = target as HTMLInputElement | HTMLTextAreaElement;
            try {
              const start = inputSelection?.start ?? input.selectionStart ?? input.value.length;
              const end = inputSelection?.end ?? input.selectionEnd ?? input.value.length;
              input.setRangeText(text, start, end, "end");
            } catch {
              // Fallback for inputs that don't support setRangeText.
              input.value += text;
            }
            input.dispatchEvent(new Event("input", { bubbles: true }));
          } else {
            restoreWindowSelection();
            document.execCommand("insertText", false, text);
          }
        } catch {
          if (contentEditableHost) {
            restoreWindowSelection();
          }
          try {
            if (!document.execCommand("paste")) {
              toastManager.add({
                type: "error",
                title: "Unable to paste",
                description: "Clipboard access was denied.",
              });
            }
          } catch {
            toastManager.add({
              type: "error",
              title: "Unable to paste",
              description: "Clipboard access was denied.",
            });
          }
        }
      } else if (clicked === "select-all") {
        if (isInputElement || isTextAreaElement) {
          (target as HTMLInputElement | HTMLTextAreaElement).select();
        } else if (contentEditableHost) {
          // Scope selection to the contenteditable container, not the whole page.
          const range = document.createRange();
          range.selectNodeContents(contentEditableHost);
          selection?.removeAllRanges();
          selection?.addRange(range);
        } else {
          document.execCommand("selectAll");
        }
      }
    })();
  };

  window.addEventListener("contextmenu", handleContextMenu);
  return () => {
    window.removeEventListener("contextmenu", handleContextMenu);
  };
}
