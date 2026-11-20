import type { ContextMenuItem } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m } from "./i18n/messages";
import { glyphAttributeName } from "./icons/glyphMarkup";
import { GLYPH_BY_LUCIDE_NAME } from "./icons/glyphs.generated";

const SVG_NS = "http://www.w3.org/2000/svg";

// Menu item icons are Lucide names; they draw the same glyphs as `lucide-react`.

function createIconElement(name: string, tone: "neutral" | "destructive"): SVGSVGElement | null {
  const glyph = GLYPH_BY_LUCIDE_NAME[name];
  if (!glyph || typeof document.createElementNS !== "function") {
    return null;
  }
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute(
    "class",
    tone === "destructive"
      ? "size-4.5 shrink-0 sm:size-4"
      : "size-4.5 shrink-0 text-muted-foreground sm:size-4",
  );
  for (const [tag, attrs] of glyph) {
    const child = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
      child.setAttribute(glyphAttributeName(key), value);
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

let activeContextMenuDismiss: ((restoreFocus?: boolean) => void) | null = null;

export function isContextMenuOpen(): boolean {
  return activeContextMenuDismiss !== null;
}

export function dismissContextMenu(restoreFocus = true): void {
  activeContextMenuDismiss?.(restoreFocus);
  activeContextMenuDismiss = null;
}

export function showContextMenuFallback<T extends string>(
  items: readonly ContextMenuItem<T>[],
  position?: { x: number; y: number },
): Promise<T | null> {
  dismissContextMenu();
  return new Promise<T | null>((resolve) => {
    let focusedElement = document.activeElement;
    while (focusedElement?.shadowRoot?.activeElement) {
      focusedElement = focusedElement.shadowRoot.activeElement;
    }
    const previouslyFocusedElement = focusedElement instanceof HTMLElement ? focusedElement : null;
    const menuStack: HTMLDivElement[] = [];
    const submenuTriggerStack: Array<HTMLButtonElement | undefined> = [];
    let isDisposed = false;
    let canDismissFromPointer = false;

    const dismiss = (restoreFocus = true) => cleanup(null, restoreFocus);

    const cleanup = (result: T | null, restoreFocus = true) => {
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
      document.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("blur", onWindowBlur);
      const shouldRestoreFocus =
        restoreFocus && isNodeWithinMenuStack(document.activeElement, menuStack);
      for (const menu of menuStack) {
        menu.remove();
      }
      if (shouldRestoreFocus && previouslyFocusedElement?.isConnected) {
        previouslyFocusedElement.focus({ preventScroll: true });
      }
      resolve(result);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      )
        return;
      const level = menuStack.findIndex((menu) =>
        isNodeWithinMenuStack(document.activeElement, [menu]),
      );
      if (level < 0) return;
      const menu = menuStack[level]!;
      const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button")].filter(
        (button) => !button.disabled,
      );
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      let target: HTMLButtonElement | undefined;
      switch (event.key) {
        case "ArrowDown":
          target = buttons[(index + 1) % buttons.length];
          break;
        case "ArrowUp":
          target =
            buttons[(index < 0 ? buttons.length - 1 : index - 1 + buttons.length) % buttons.length];
          break;
        case "Home":
          target = buttons[0];
          break;
        case "End":
          target = buttons.at(-1);
          break;
        case "ArrowRight":
          if (buttons[index]?.getAttribute("aria-haspopup") !== "menu") return;
          buttons[index]?.click();
          break;
        case " ":
        case "Enter":
          // Keyboard activation must not depend on the opening pointer gesture's frame.
          canDismissFromPointer = true;
          buttons[index]?.click();
          break;
        case "ArrowLeft":
          if (level === 0) return;
        // Fall through to cancel this submenu only.
        case "Escape": {
          const parent = submenuTriggerStack[level];
          if (parent) {
            parent.focus({ preventScroll: true });
            closeMenusFromLevel(level);
          } else cleanup(null);
          break;
        }
        case "Tab":
          // Tab closes the menu and continues from the element that opened it.
          cleanup(null);
          return;
        default:
          return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (target && target !== submenuTriggerStack[level + 1]) closeMenusFromLevel(level + 1);
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "nearest" });
    };

    const onFocusIn = (event: FocusEvent) => {
      if (!isNodeWithinMenuStack(event.target, menuStack)) cleanup(null, false);
    };
    const onWindowBlur = () => cleanup(null, false);

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
        "dropdown-glass fixed z-[10000] min-w-32 max-w-sm overflow-hidden rounded-xl bg-clip-padding text-popover-foreground outline-none";
      menu.style.cssText =
        "position:fixed;z-index:10000;min-width:8rem;max-width:24rem;overflow:hidden;border-radius:var(--radius-lg);background-clip:padding-box;color:var(--contrast-popover-foreground);outline:none;pointer-events:auto;";
      menu.style.left = `${preferredLeft}px`;
      menu.style.top = `${preferredTop}px`;
      menu.dataset.level = String(level);
      menu.dataset.contextMenu = "true";
      menu.setAttribute("role", "menu");
      menu.setAttribute("aria-label", parentTrigger?.textContent ?? m(msg("Context menu")));
      menu.tabIndex = -1;

      const inner = document.createElement("div");
      inner.className =
        "max-h-[calc(100vh-0.5rem)] min-w-0 max-w-sm overflow-y-auto overflow-x-hidden p-1";
      inner.style.cssText =
        "max-height:calc(100vh - 0.5rem);min-width:0;max-width:24rem;overflow-x:hidden;overflow-y:auto;padding:0.25rem;";

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
        button.tabIndex = -1;
        button.setAttribute("role", "menuitem");
        button.setAttribute("aria-disabled", String(isDisabled));
        const rowBase =
          "flex w-full cursor-default select-none items-center gap-2 rounded-lg px-2 py-1 text-left outline-none transition-colors sm:min-h-7 sm:text-sm min-h-8 text-base";
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

        if (typeof item.checked === "boolean") {
          button.setAttribute("role", "menuitemradio");
          button.setAttribute("aria-checked", item.checked ? "true" : "false");
          const check = item.checked ? createIconElement("check", "neutral") : null;
          if (check) {
            button.appendChild(check);
          } else {
            const spacer = document.createElement("span");
            spacer.className = "size-4.5 shrink-0 sm:size-4";
            spacer.style.cssText = "display:inline-block;width:1rem;height:1rem;flex-shrink:0;";
            spacer.setAttribute("aria-hidden", "true");
            button.appendChild(spacer);
          }
        } else if (typeof item.icon === "string") {
          const icon = createIconElement(item.icon, isLeafDestructive ? "destructive" : "neutral");
          if (icon) {
            button.appendChild(icon);
          }
        }

        const label = document.createElement("span");
        label.className = "min-w-0 flex-1 truncate";
        label.textContent = item.label;
        button.appendChild(label);

        if (item.detail) {
          // The comma gives screen readers a pause between label and detail.
          button.setAttribute("aria-label", `${item.label}, ${item.detail}`);
          const detail = document.createElement("span");
          detail.className = "ms-auto shrink-0 ps-4 text-muted-foreground text-xs";
          detail.style.cssText =
            "margin-inline-start:auto;flex-shrink:0;padding-inline-start:1rem;color:var(--contrast-muted-foreground);font-size:0.75rem;";
          detail.textContent = item.detail;
          button.appendChild(detail);
        }

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
      // Like a native menu, take thumb Back/Forward presses instead of letting Chromium
      // run the app router's history underneath.
      const swallowThumbButton = (event: MouseEvent) => {
        if (event.button === 3 || event.button === 4) event.preventDefault();
      };
      menu.addEventListener("mousedown", swallowThumbButton);
      menu.addEventListener("mouseup", swallowThumbButton);

      document.body.appendChild(menu);
      menuStack[level] = menu;
      submenuTriggerStack[level] = parentTrigger;

      requestAnimationFrame(() => {
        if (!parentTrigger) {
          clampMenuPosition(menu, preferredLeft, preferredTop);
          return;
        }
        // A fixed menu near the right edge shrinks to the space left; measure its real width.
        menu.style.width = "max-content";
        menu.style.maxWidth = "min(24rem, calc(100vw - 0.5rem))";
        const { width } = menu.getBoundingClientRect();
        const roomLeft = parentTrigger.getBoundingClientRect().left - 4;
        const roomRight = window.innerWidth - preferredLeft;
        const flipLeft = width > roomRight && roomLeft > roomRight;
        clampMenuPosition(menu, flipLeft ? roomLeft - width : preferredLeft, preferredTop);
      });
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("contextmenu", onContextMenu, true);
    openMenu(items, position?.x ?? 0, position?.y ?? 0, 0);
    activeContextMenuDismiss = dismiss;
    // A keyboard-opened menu starts on its first action, a pointer-opened one on the menu itself.
    // Text fields always match :focus-visible, so they say nothing about how the menu opened.
    const firstAction =
      previouslyFocusedElement?.matches(":focus-visible") &&
      !previouslyFocusedElement.matches('input, textarea, select, [contenteditable="true"]')
        ? menuStack[0]?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        : null;
    (firstAction ?? menuStack[0])?.focus({ preventScroll: true });
    document.addEventListener("focusin", onFocusIn);
    window.addEventListener("blur", onWindowBlur);

    requestAnimationFrame(() => {
      canDismissFromPointer = true;
    });
  });
}
