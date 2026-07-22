import { type Dispatch, type SetStateAction, useCallback, useLayoutEffect, useState } from "react";

interface LayoutScopedOpenState<Layout> {
  readonly layout: Layout;
  readonly open: boolean;
}

export function normalizeLayoutScopedOpenState<Layout>(
  state: LayoutScopedOpenState<Layout>,
  layout: Layout,
): LayoutScopedOpenState<Layout> {
  return Object.is(state.layout, layout) ? state : { layout, open: false };
}

export function readLayoutScopedOpenState<Layout>(
  state: LayoutScopedOpenState<Layout>,
  layout: Layout,
): boolean {
  return Object.is(state.layout, layout) ? state.open : false;
}

/**
 * Controlled open state that closes as soon as its rendered layout changes.
 *
 * Reading a stale layout returns false immediately, while the layout effect
 * records the closed state for the new layout before paint. This prevents an
 * open overlay from reappearing if responsive controls unmount and later mount
 * again in their previous layout.
 */
export function useLayoutScopedOpenState<Layout>(
  layout: Layout,
): readonly [boolean, Dispatch<SetStateAction<boolean>>] {
  const [state, setState] = useState<LayoutScopedOpenState<Layout>>(() => ({
    layout,
    open: false,
  }));
  const open = readLayoutScopedOpenState(state, layout);

  useLayoutEffect(() => {
    setState((current) => normalizeLayoutScopedOpenState(current, layout));
  }, [layout]);

  const setOpen = useCallback<Dispatch<SetStateAction<boolean>>>(
    (nextOpen) => {
      setState((current) => {
        const currentOpen = readLayoutScopedOpenState(current, layout);
        const resolvedOpen = typeof nextOpen === "function" ? nextOpen(currentOpen) : nextOpen;
        if (Object.is(current.layout, layout) && current.open === resolvedOpen) {
          return current;
        }
        return { layout, open: resolvedOpen };
      });
    },
    [layout],
  );

  return [open, setOpen] as const;
}
