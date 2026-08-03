import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as Option from "effect/Option";

export type EnvironmentThreadStatus = "empty" | "cached" | "synchronizing" | "live" | "deleted";

/**
 * Pagination state for a windowed thread. Present only when the loaded thread
 * is a window (the server returned `page` metadata); absent means the thread is
 * fully loaded — either the server predates pagination or the window reached
 * the top.
 */
export interface EnvironmentThreadPageState {
  /** Opaque exclusive cursor for the next older slice; null when fully loaded. */
  readonly beforeCursor: string | null;
  readonly hasMore: boolean;
  /** True while an older page fetch is in flight. */
  readonly loadingOlder: boolean;
}

export interface EnvironmentThreadState {
  readonly data: Option.Option<OrchestrationV2ThreadProjection>;
  readonly status: EnvironmentThreadStatus;
  readonly error: Option.Option<string>;
  readonly page: Option.Option<EnvironmentThreadPageState>;
}

export const EMPTY_ENVIRONMENT_THREAD_STATE: EnvironmentThreadState = {
  data: Option.none(),
  status: "empty",
  error: Option.none(),
  page: Option.none(),
};

/** Whether the thread has older turns that can be loaded with more pages. */
export function threadHasOlderTurns(state: EnvironmentThreadState): boolean {
  return Option.match(state.page, {
    onNone: () => false,
    onSome: (page) => page.hasMore,
  });
}
