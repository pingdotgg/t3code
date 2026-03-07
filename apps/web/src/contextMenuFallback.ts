import type { ContextMenuItem } from "@t3tools/contracts";

/**
 * Imperative DOM-based context menu used for browser and desktop renderer surfaces.
 * Shows a positioned dropdown and returns a promise that resolves
 * with the clicked item id, or null if dismissed.
 */
export function showContextMenuFallback<T extends string>(
  items: readonly ContextMenuItem<T>[],
  position?: { x: number; y: number },
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const menu = document.createElement("div");
    menu.className =
      "fixed z-[10000] min-w-32 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg/5";
    menu.style.visibility = "hidden";

    const x = position?.x ?? 0;
    const y = position?.y ?? 0;
    menu.style.top = `${y}px`;
    menu.style.left = `${x}px`;
    let outsidePressEnabled = false;
    let enableOutsidePressFrame = 0;

    function cleanup(result: T | null) {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
      cancelAnimationFrame(enableOutsidePressFrame);
      menu.remove();
      resolve(result);
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup(null);
      }
    }

    function onPointerDown(event: PointerEvent) {
      if (!outsidePressEnabled) return;
      const target = event.target;
      if (target instanceof Node && menu.contains(target)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      cleanup(null);
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);

    let hasInsertedDestructiveSeparator = false;
    for (const item of items) {
      const isDestructiveAction = item.destructive === true || item.id === "delete";
      if (isDestructiveAction && !hasInsertedDestructiveSeparator && menu.childElementCount > 0) {
        const separator = document.createElement("div");
        separator.className = "mx-2 my-1 h-px bg-border";
        menu.appendChild(separator);
        hasInsertedDestructiveSeparator = true;
      }

      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = item.label;
      btn.style.appearance = "none";
      btn.style.setProperty("-webkit-appearance", "none");
      btn.style.border = "0";
      btn.style.background = "transparent";
      btn.style.boxShadow = "none";
      btn.style.outline = "none";
      btn.style.font = "inherit";
      btn.style.margin = "0";
      btn.className = isDestructiveAction
        ? "flex min-h-8 w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1 text-left text-base text-destructive outline-none hover:bg-accent hover:text-accent-foreground sm:min-h-7 sm:text-sm"
        : "flex min-h-8 w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1 text-left text-base text-foreground outline-none hover:bg-accent hover:text-accent-foreground sm:min-h-7 sm:text-sm";
      btn.addEventListener("click", () => cleanup(item.id));
      menu.appendChild(btn);
    }

    document.body.appendChild(menu);
    // Position the menu before revealing it so edge clamping does not cause a visible jump.
    enableOutsidePressFrame = requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        menu.style.left = `${window.innerWidth - rect.width - 4}px`;
      }
      if (rect.bottom > window.innerHeight) {
        menu.style.top = `${window.innerHeight - rect.height - 4}px`;
      }
      menu.classList.add("animate-in", "fade-in", "zoom-in-95");
      menu.style.visibility = "visible";
      outsidePressEnabled = true;
    });
  });
}
