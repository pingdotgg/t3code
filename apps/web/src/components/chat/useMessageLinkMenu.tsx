import { useCallback, useEffect, useRef, useState } from "react";

import { Menu, MenuItem, MenuPopup } from "../ui/menu";

interface LinkMenuItem {
  id: string;
  label: string;
}

interface LinkMenuState {
  items: readonly LinkMenuItem[];
  trigger: HTMLElement;
  position: { x: number; y: number };
}

/** Keeps message link focus and menu focus in the same accessibility tree. */
export function useMessageLinkMenu() {
  const [state, setState] = useState<LinkMenuState | null>(null);
  const pending = useRef<((value: string | null) => void) | null>(null);
  const complete = useCallback((value: string | null) => {
    const resolve = pending.current;
    pending.current = null;
    setState(null);
    resolve?.(value);
  }, []);

  useEffect(() => () => pending.current?.(null), []);

  const show = useCallback(
    <T extends string>(
      items: readonly { id: T; label: string }[],
      position: { x: number; y: number },
      trigger: HTMLElement,
    ): Promise<T | null> => {
      pending.current?.(null);
      pending.current = null;
      if (items.length === 0) {
        setState(null);
        return Promise.resolve(null);
      }
      if (position.x === 0 && position.y === 0) {
        const bounds = trigger.getBoundingClientRect();
        position = { x: bounds.left, y: bounds.bottom };
      }
      return new Promise((resolve) => {
        pending.current = (value) => resolve(value as T | null);
        setState({ items, position, trigger });
      });
    },
    [],
  );

  const menu = state && (
    <Menu
      defaultOpen
      onOpenChange={(open) => {
        if (!open) complete(null);
      }}
    >
      <MenuPopup
        align="start"
        sideOffset={0}
        anchor={{
          getBoundingClientRect: () => new DOMRect(state.position.x, state.position.y, 0, 0),
        }}
        aria-label="Link options"
        finalFocus={() => state.trigger}
        onFocus={(event) => {
          if (event.target === event.currentTarget) {
            event.currentTarget.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
          }
        }}
      >
        {state.items.map((item) => (
          <MenuItem key={item.id} onClick={() => complete(item.id)}>
            {item.label}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );

  return { show, menu };
}
