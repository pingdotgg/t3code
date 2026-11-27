/** Input points for mobile:metrics' perf windows; null unless the env-gated behavior probe loaded. */
export interface PerfProbe {
  readonly touchStart: () => void;
  readonly touchEnd: () => void;
  /** A native menu item's JS handler ran: the first point JS sees of a tap inside a native menu. */
  readonly menuAction: () => void;
  /** The composer's text changed: one key. */
  readonly key: () => void;
  /** A thread's timeline rows became visible. */
  readonly contentShown: (thread: string) => void;
}

// behavior-probe-entry runs before the app's modules in index.ts, so this is read after it installs.
export const perfProbe: PerfProbe | null =
  (globalThis as { __t3PerfProbe?: PerfProbe }).__t3PerfProbe ?? null;
