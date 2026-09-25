// @effect-diagnostics globalTimers:off - Display timing for React hooks, outside an Effect runtime.

/** How long a status must last before a client shows it. */
export const STATUS_SHOW_DELAY_MS = 400;
/** How long a shown status stays up, so it cannot flash at the show delay. */
export const STATUS_MIN_VISIBLE_MS = 400;

/** The status a client should show, and the key it belongs to. */
export interface ShownStatus<A> {
  readonly key: string;
  readonly value: A;
}

export interface DelayedStatus<A> {
  /** Reports the real status for `key`. A new key drops the shown status at once. */
  readonly update: (key: string, value: A | null) => void;
  /** Cancels pending timers. A later `update` starts again from the real status. */
  readonly dispose: () => void;
}

/**
 * Turns a real status (for example the thread sync phase) into the status a
 * client shows. A status that clears within `STATUS_SHOW_DELAY_MS` is never
 * shown. A shown status stays for at least `STATUS_MIN_VISIBLE_MS`. Values
 * compare by identity, so use strings or other stable values.
 *
 * Web and mobile wrap this in a small `useDelayedStatus` hook.
 */
export function createDelayedStatus<A>(
  onChange: (shown: ShownStatus<A> | null) => void,
): DelayedStatus<A> {
  let key = "";
  let latest: A | null = null;
  let shown: A | null = null;
  // While hidden, this is the show delay. While shown, the minimum visible time.
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const setShown = (value: A | null) => {
    shown = value;
    onChange(value === null ? null : { key, value });
  };

  return {
    update: (nextKey, value) => {
      if (nextKey !== key) {
        key = nextKey;
        clearTimer();
        if (shown !== null) setShown(null);
      }
      latest = value;

      if (shown === null) {
        if (value === null) {
          clearTimer();
        } else if (timer === undefined) {
          timer = setTimeout(() => {
            setShown(latest);
            timer = setTimeout(() => {
              timer = undefined;
              if (latest === null) setShown(null);
            }, STATUS_MIN_VISIBLE_MS);
          }, STATUS_SHOW_DELAY_MS);
        }
        return;
      }

      if (value !== null) {
        if (value !== shown) setShown(value);
      } else if (timer === undefined) {
        setShown(null);
      }
    },
    dispose: clearTimer,
  };
}
