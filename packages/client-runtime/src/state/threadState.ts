import type { OrchestrationThread } from "@t3tools/contracts";
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
  readonly data: Option.Option<OrchestrationThread>;
  readonly status: EnvironmentThreadStatus;
  readonly error: Option.Option<string>;
  readonly page: Option.Option<EnvironmentThreadPageState>;
  /** True once the thread's detail stream has attached this session; distinguishes a mid-session drop (detached) from a cold start (connecting). */
  readonly wasLive: boolean;
}

export const EMPTY_ENVIRONMENT_THREAD_STATE: EnvironmentThreadState = {
  data: Option.none(),
  status: "empty",
  error: Option.none(),
  page: Option.none(),
  wasLive: false,
};

/** Whether the thread has older turns that can be loaded with more pages. */
export function threadHasOlderTurns(state: EnvironmentThreadState): boolean {
  return Option.match(state.page, {
    onNone: () => false,
    onSome: (page) => page.hasMore,
  });
}

export type EnvironmentThreadStreamHealth = "live" | "connecting" | "detached" | "deleted";

/**
 * Whether turn activity may render as healthy live work: "Working" may only
 * render while the detail stream that would deliver the turn completion is
 * alive. Pure and dependency-free so the web and mobile clients can share it.
 * A state that attached this session (wasLive) reads detached once it stops
 * being live — dropped-after-attach never masquerades as a cold start, matching
 * the sidebar shell's wasLive-latched health vocabulary.
 */
export function environmentThreadStreamHealth(
  state: EnvironmentThreadState,
): EnvironmentThreadStreamHealth {
  if (state.status === "deleted") return "deleted";
  if (Option.isSome(state.error)) return "detached";
  if (state.status === "live") return "live";
  return state.wasLive ? "detached" : "connecting";
}
