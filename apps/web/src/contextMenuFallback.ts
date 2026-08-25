import type { ContextMenuItem } from "@t3tools/contracts";

const SVG_NS = "http://www.w3.org/2000/svg";

// Inline Lucide-style icon paths (stroke-based, viewBox 0 0 24 24, strokeWidth 2).
const ICON_PATHS: Record<string, ReadonlyArray<{ tag: string; attrs: Record<string, string> }>> = {
  archive: [
    { tag: "rect", attrs: { width: "20", height: "5", x: "2", y: "3", rx: "1" } },
    { tag: "path", attrs: { d: "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" } },
    { tag: "path", attrs: { d: "M10 12h4" } },
  ],
  "chevron-right": [{ tag: "path", attrs: { d: "m9 19 7-7-7-7" } }],
  "circle-check": [
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "10" } },
    { tag: "path", attrs: { d: "m9 12 2 2 4-4" } },
  ],
  clock: [
    { tag: "path", attrs: { d: "M12 6v6l4 2" } },
    { tag: "circle", attrs: { cx: "12", cy: "12", r: "10" } },
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
  trash: [
    { tag: "path", attrs: { d: "M3 6h18" } },
    { tag: "path", attrs: { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" } },
    { tag: "path", attrs: { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" } },
    { tag: "line", attrs: { x1: "10", x2: "10", y1: "11", y2: "17" } },
    { tag: "line", attrs: { x1: "14", x2: "14", y1: "11", y2: "17" } },
  ],
};

function createIconElement(name: string, tone: "neutral" | "destructive"): SVGSVGElement | null {
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
      ? "size-4.5 shrink-0 sm:size-4"
      : "size-4.5 shrink-0 text-muted-foreground sm:size-4",
  );
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
        "dropdown-glass fixed z-[10000] min-w-32 max-w-sm overflow-hidden rounded-lg bg-clip-padding text-popover-foreground outline-none";
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
            "height:1px;margin:0.25rem 0.5rem;background:var(--contrast-border);";
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
        const isLeafDestructive =
          !hasChildren && (item.destructive === true || item.id === ("delete" as T));

        const button = document.createElement("button");
        button.type = "button";
        const isDisabled = item.disabled === true;
        button.disabled = isDisabled;
        const rowBase =
          "flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1 text-left outline-none transition-colors sm:min-h-7 sm:text-sm min-h-8 text-base";
        button.className = isDisabled
          ? `${rowBase} pointer-events-none cursor-not-allowed text-muted-foreground opacity-64`
          : isLeafDestructive
            ? `${rowBase} text-destructive-foreground hover:bg-destructive/10 hover:text-destructive-foreground`
            : `${rowBase} text-foreground hover:bg-accent hover:text-accent-foreground`;
        button.style.cssText =
          "display:flex;width:100%;min-height:1.75rem;align-items:center;gap:0.5rem;border:0;border-radius:var(--radius-sm);background:transparent;padding:0.25rem 0.5rem;color:var(--contrast-foreground);font-family:var(--font-sans,system-ui,sans-serif);font-size:0.875rem;line-height:1.25rem;text-align:left;cursor:default;";
        if (isLeafDestructive) {
          button.style.color = "var(--destructive-foreground)";
        }
        if (isDisabled) {
          button.style.color = "var(--contrast-muted-foreground)";
          button.style.opacity = "0.64";
          button.style.pointerEvents = "none";
        }

        if (typeof item.icon === "string") {
          const icon = createIconElement(item.icon, isLeafDestructive ? "destructive" : "neutral");
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
            button.style.background = isHighlighted
              ? isLeafDestructive
                ? "color-mix(in srgb, var(--destructive) 10%, transparent)"
                : "var(--accent)"
              : "transparent";
            button.style.color = isHighlighted
              ? isLeafDestructive
                ? "var(--destructive-foreground)"
                : "var(--contrast-accent-foreground)"
              : isLeafDestructive
                ? "var(--destructive-foreground)"
                : "var(--contrast-foreground)";
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

    requestAnimationFrame(() => {
      canDismissFromPointer = true;
    });
  });
}
