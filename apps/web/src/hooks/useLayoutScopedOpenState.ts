import { type Dispatch, type SetStateAction, useCallback, useLayoutEffect, useState } from "react";

interface LayoutScopedState<Layout, Value> {
  readonly layout: Layout;
  readonly value: Value;
}

export function normalizeLayoutScopedState<Layout, Value>(
  state: LayoutScopedState<Layout, Value>,
  layout: Layout,
  initialValue: Value,
): LayoutScopedState<Layout, Value> {
  return Object.is(state.layout, layout) ? state : { layout, value: initialValue };
}

export function readLayoutScopedState<Layout, Value>(
  state: LayoutScopedState<Layout, Value>,
  layout: Layout,
  initialValue: Value,
): Value {
  return Object.is(state.layout, layout) ? state.value : initialValue;
}

export function updateLayoutScopedState<Layout, Value>(
  state: LayoutScopedState<Layout, Value>,
  layout: Layout,
  nextValue: SetStateAction<Value>,
): LayoutScopedState<Layout, Value> {
  if (!Object.is(state.layout, layout)) {
    return state;
  }
  const resolvedValue =
    typeof nextValue === "function"
      ? (nextValue as (current: Value) => Value)(state.value)
      : nextValue;
  return Object.is(state.value, resolvedValue) ? state : { layout, value: resolvedValue };
}

/**
 * State that resets as soon as its rendered layout changes.
 *
 * Reading a stale layout returns the initial value immediately, while the
 * layout effect records that value for the new layout before paint. This
 * prevents responsive controls from restoring stale state if they later mount
 * again in a previous layout.
 */
export function useLayoutScopedState<Layout, Value>(
  layout: Layout,
  initialValue: Value,
): readonly [Value, Dispatch<SetStateAction<Value>>] {
  const [state, setState] = useState<LayoutScopedState<Layout, Value>>(() => ({
    layout,
    value: initialValue,
  }));
  const value = readLayoutScopedState(state, layout, initialValue);

  useLayoutEffect(() => {
    setState((current) => normalizeLayoutScopedState(current, layout, initialValue));
  }, [initialValue, layout]);

  const setValue = useCallback<Dispatch<SetStateAction<Value>>>(
    (nextValue) => {
      setState((current) => updateLayoutScopedState(current, layout, nextValue));
    },
    [layout],
  );

  return [value, setValue] as const;
}

/** Controlled open state that closes when its rendered layout changes. */
export function useLayoutScopedOpenState<Layout>(
  layout: Layout,
): readonly [boolean, Dispatch<SetStateAction<boolean>>] {
  return useLayoutScopedState(layout, false);
}
