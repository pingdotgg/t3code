import type { ContextMenuItem } from "@t3tools/contracts";

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

/**
 * Imperative DOM-based context menu for non-Electron environments.
 * Supports nested submenus and resolves with the clicked leaf item id.
 */
export function showContextMenuFallback<T extends string>(
  items: readonly ContextMenuItem<T>[],
  position?: { x: number; y: number },
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:9999";

    const menuStack: HTMLDivElement[] = [];

    const cleanup = (result: T | null) => {
      document.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      for (const menu of menuStack) {
        menu.remove();
      }
      resolve(result);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cleanup(null);
      }
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

      const menu = document.createElement("div");
      menu.className =
        "fixed z-[10000] min-w-[160px] rounded-md border border-border bg-popover py-1 shadow-xl animate-in fade-in zoom-in-95";
      menu.style.left = `${preferredLeft}px`;
      menu.style.top = `${preferredTop}px`;
      menu.dataset.level = String(level);

      for (const item of entries) {
        const button = document.createElement("button");
        button.type = "button";
        const hasChildren = Array.isArray(item.children) && item.children.length > 0;
        const isLeafDestructive =
          !hasChildren && (item.destructive === true || item.id === ("delete" as T));
        const isDisabled = item.disabled === true;
        button.disabled = isDisabled;
        button.className = isDisabled
          ? "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-muted-foreground/60 cursor-not-allowed"
          : isLeafDestructive
            ? "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-destructive hover:bg-accent cursor-default"
            : "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] text-popover-foreground hover:bg-accent cursor-default";

        const label = document.createElement("span");
        label.className = "min-w-0 flex-1 truncate";
        label.textContent = item.label;
        button.appendChild(label);

        if (hasChildren) {
          const chevron = document.createElement("span");
          chevron.className = "shrink-0 text-muted-foreground/70";
          chevron.textContent = "›";
          button.appendChild(chevron);
        }

        if (!isDisabled) {
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
            button.addEventListener("click", () => cleanup(item.id));
          }
        }

        menu.appendChild(button);
      }

      menu.addEventListener("mouseenter", () => {
        closeMenusFromLevel(level + 1);
      });

      document.body.appendChild(menu);
      menuStack[level] = menu;

      requestAnimationFrame(() => {
        clampMenuPosition(menu, preferredLeft, preferredTop);
      });
    };

    overlay.addEventListener("mousedown", () => cleanup(null));
    document.addEventListener("keydown", onKeyDown);
    document.body.appendChild(overlay);
    openMenu(items, position?.x ?? 0, position?.y ?? 0, 0);
  });
}
