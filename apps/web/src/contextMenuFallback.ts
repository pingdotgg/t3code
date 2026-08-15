import type { ContextMenuItem } from "@t3tools/contracts";

const SVG_NS = "http://www.w3.org/2000/svg";

// Inline Lucide-style icon paths (stroke-based, viewBox 0 0 24 24, strokeWidth 2).
const ICON_PATHS: Record<string, ReadonlyArray<{ tag: string; attrs: Record<string, string> }>> = {
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
  if (!paths) {
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
    tone === "destructive" ? "size-3.5 shrink-0" : "size-3.5 shrink-0 text-muted-foreground",
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

export function contextMenuAcceleratorAction<T extends string>(
  items: readonly ContextMenuItem<T>[],
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "isComposing" | "key" | "metaKey" | "shiftKey">,
): T | null {
  if (event.isComposing) return null;
  for (const item of items) {
    if (item.disabled) continue;
    if (item.children) {
      const childAction = contextMenuAcceleratorAction(item.children, event);
      if (childAction !== null) return childAction;
    }
    if (!item.accelerator) continue;

    const parts = item.accelerator.toLowerCase().split("+");
    const key = parts.at(-1);
    if (
      event.key.toLowerCase() === key &&
      event.altKey === parts.includes("alt") &&
      event.ctrlKey === parts.includes("ctrl") &&
      event.metaKey === (parts.includes("command") || parts.includes("cmd")) &&
      event.shiftKey === parts.includes("shift")
    ) {
      return item.id;
    }
  }
  return null;
}

/**
 * Imperative DOM-based context menu for non-Electron environments.
 * Supports nested submenus and resolves with the clicked leaf item id.
 */
export function showContextMenuFallback<T extends string>(
  items: readonly ContextMenuItem<T>[],
  position?: { x: number; y: number },
  options?: { readonly signal?: AbortSignal },
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    if (options?.signal?.aborted) {
      resolve(null);
      return;
    }
    const menuStack: HTMLDivElement[] = [];
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
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("contextmenu", onContextMenu, true);
      document.removeEventListener("wheel", onWheel, true);
      options?.signal?.removeEventListener("abort", onAbort);
      for (const menu of menuStack) {
        menu.remove();
      }
      resolve(result);
    };

    const onAbort = () => cleanup(null);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        cleanup(null);
        return;
      }
      const acceleratorAction = contextMenuAcceleratorAction(items, event);
      if (acceleratorAction !== null) {
        event.preventDefault();
        event.stopPropagation();
        cleanup(acceleratorAction);
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

    const onWheel = (event: WheelEvent) => {
      if (isNodeWithinMenuStack(event.target, menuStack)) {
        return;
      }
      cleanup(null);
    };

    const closeMenusFromLevel = (level: number) => {
      while (menuStack.length > level) {
        menuStack.pop()?.remove();
      }
    };

    const openMenu = (
      entries: readonly ContextMenuItem<T>[],
      preferredLeft: number,
      preferredTop: number,
      level: number,
    ) => {
      closeMenusFromLevel(level);

      const usesCompactShortcutLayout = entries.some((item) => item.accelerator);
      const menu = document.createElement("div");
      menu.className = `dropdown-glass fixed z-[10000] max-w-sm overflow-hidden bg-clip-padding text-popover-foreground outline-none ${
        usesCompactShortcutLayout ? "min-w-[14.25rem] rounded-[11px]" : "min-w-32 rounded-lg"
      }`;
      menu.style.cssText = `position:fixed;z-index:10000;min-width:${
        usesCompactShortcutLayout ? "min(14.25rem,calc(100vw - 0.75rem))" : "8rem"
      };max-width:24rem;overflow:hidden;border-radius:${
        usesCompactShortcutLayout ? "0.6875rem" : "var(--radius-lg)"
      };background-clip:padding-box;color:var(--popover-foreground);outline:none;pointer-events:auto;`;
      menu.style.left = `${preferredLeft}px`;
      menu.style.top = `${preferredTop}px`;
      menu.dataset.level = String(level);

      const inner = document.createElement("div");
      inner.className =
        "max-h-[min(24rem,70vh)] min-w-0 max-w-sm overflow-y-auto overflow-x-hidden p-1 data-[compact=true]:p-[5px]";
      inner.dataset.compact = String(usesCompactShortcutLayout);
      inner.style.cssText = `max-height:min(24rem,70vh);min-width:0;max-width:24rem;overflow-x:hidden;overflow-y:auto;padding:${
        usesCompactShortcutLayout ? "0.3125rem" : "0.25rem"
      };`;

      for (const item of entries) {
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
        const rowBase = usesCompactShortcutLayout
          ? "flex min-h-[2.125rem] w-full cursor-default select-none items-center gap-[9px] rounded-[7px] px-2 py-1.5 text-left text-xs outline-none transition-colors"
          : "flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1 text-left outline-none transition-colors sm:min-h-7 sm:text-sm min-h-8 text-base";
        button.className = isDisabled
          ? `${rowBase} pointer-events-none cursor-not-allowed text-muted-foreground ${
              usesCompactShortcutLayout ? "opacity-52" : "opacity-64"
            }`
          : isLeafDestructive
            ? `${rowBase} text-destructive-foreground hover:bg-destructive/10 hover:text-destructive-foreground`
            : `${rowBase} text-foreground hover:bg-accent hover:text-accent-foreground`;
        button.style.cssText = `display:flex;width:100%;min-height:${
          usesCompactShortcutLayout ? "2.125rem" : "1.75rem"
        };align-items:center;gap:${usesCompactShortcutLayout ? "0.5625rem" : "0.5rem"};border:0;border-radius:${
          usesCompactShortcutLayout ? "0.4375rem" : "var(--radius-sm)"
        };background:transparent;padding:${
          usesCompactShortcutLayout ? "0.375rem 0.5rem" : "0.25rem 0.5rem"
        };color:var(--foreground);font-family:var(--font-sans,system-ui,sans-serif);font-size:${
          usesCompactShortcutLayout ? "0.75rem" : "0.875rem"
        };font-weight:${usesCompactShortcutLayout ? "450" : "400"};line-height:1.25rem;text-align:left;cursor:default;`;
        if (isLeafDestructive) {
          button.style.color = "var(--destructive-foreground)";
        }
        if (isDisabled) {
          button.style.color = "var(--muted-foreground)";
          button.style.opacity = usesCompactShortcutLayout ? "0.52" : "0.64";
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

        if (item.accelerator) {
          const accelerator = document.createElement("kbd");
          accelerator.className =
            "ms-auto shrink-0 rounded border border-border/70 bg-muted/70 px-[5px] font-mono text-[10px] text-muted-foreground leading-[1.55]";
          accelerator.style.cssText =
            "margin-inline-start:auto;flex-shrink:0;border:1px solid color-mix(in srgb,var(--border) 70%,transparent);border-radius:0.25rem;background:color-mix(in srgb,var(--muted) 70%,transparent);padding:0 0.3125rem;color:var(--muted-foreground);font-family:var(--font-mono,monospace);font-size:0.625rem;line-height:1.55;";
          accelerator.textContent = item.accelerator.replace(/^Command\+/u, "⌘");
          button.appendChild(accelerator);
        }

        if (hasChildren) {
          const chevron = document.createElement("span");
          chevron.className = "ms-auto shrink-0 text-muted-foreground/80 text-sm leading-none";
          chevron.textContent = ">";
          button.appendChild(chevron);
        }

        if (!isDisabled) {
          button.addEventListener("mouseenter", () => {
            button.style.background = isLeafDestructive
              ? "color-mix(in srgb, var(--destructive) 10%, transparent)"
              : "var(--accent)";
            button.style.color = isLeafDestructive
              ? "var(--destructive-foreground)"
              : "var(--accent-foreground)";
          });
          button.addEventListener("mouseleave", () => {
            button.style.background = "transparent";
            button.style.color = isLeafDestructive
              ? "var(--destructive-foreground)"
              : "var(--foreground)";
          });

          if (hasChildren) {
            button.addEventListener("mouseenter", () => {
              const rect = button.getBoundingClientRect();
              const nextLeft = rect.right + 4;
              const nextTop = rect.top;
              openMenu(item.children!, nextLeft, nextTop, level + 1);

              const childMenu = menuStack[level + 1];
              if (!childMenu) {
                return;
              }
              const childRect = childMenu.getBoundingClientRect();
              if (childRect.right > window.innerWidth) {
                clampMenuPosition(childMenu, rect.left - childRect.width - 4, rect.top);
              }
            });
            button.addEventListener("click", (event) => {
              event.preventDefault();
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

      requestAnimationFrame(() => {
        clampMenuPosition(menu, preferredLeft, preferredTop);
      });
    };

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("wheel", onWheel, { capture: true, passive: true });
    options?.signal?.addEventListener("abort", onAbort, { once: true });
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
