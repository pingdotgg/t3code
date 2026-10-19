// @effect-diagnostics globalTimers:off - Display timing for React hooks, outside an Effect runtime.

export const STATUS_SHOW_DELAY_MS = 400;
export const STATUS_MIN_VISIBLE_MS = 400;

export interface ShownStatus<A> {
  readonly key: string;
  readonly value: A;
}

export interface DelayedStatus<A> {
  readonly update: (key: string, value: A | null) => void;
  readonly dispose: () => void;
}

/**
 * Values compare by identity, so use strings or other stable values.
 */
export function createDelayedStatus<A>(
  onChange: (shown: ShownStatus<A> | null) => void,
): DelayedStatus<A> {
  let key = "";
  let latest: A | null = null;
  let shown: A | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const hide = () => {
    shown = null;
    onChange(null);
  };
  const show = (value: A) => {
    shown = value;
    onChange({ key, value });
    clearTimer();
    timer = setTimeout(() => {
      timer = undefined;
      if (latest === null) hide();
    }, STATUS_MIN_VISIBLE_MS);
  };

  return {
    update: (nextKey, value) => {
      if (nextKey !== key) {
        key = nextKey;
        clearTimer();
        if (shown !== null) hide();
      }
      latest = value;

      if (shown === null) {
        if (value === null) {
          clearTimer();
        } else if (timer === undefined) {
          timer = setTimeout(() => {
            timer = undefined;
            if (latest !== null) show(latest);
          }, STATUS_SHOW_DELAY_MS);
        }
        return;
      }

      if (value !== null) {
        if (value !== shown) show(value);
      } else if (timer === undefined) {
        hide();
      }
    },
    dispose: clearTimer,
  };
}
