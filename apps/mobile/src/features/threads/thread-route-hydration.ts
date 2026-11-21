import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";
import * as Option from "effect/Option";

export function threadRouteIsHydrating(input: {
  readonly isLoadingConnections: boolean;
  readonly environmentRegistered: boolean;
  readonly localCacheRead: boolean;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly shellStatus: EnvironmentShellStatus;
  readonly shellHasError: boolean;
  readonly detailStatus: EnvironmentThreadStatus;
  readonly detailHasError: boolean;
}): boolean {
  if (input.detailStatus === "deleted" || input.shellHasError || input.detailHasError) {
    return false;
  }
  if (input.isLoadingConnections) {
    return true;
  }
  if (!input.environmentRegistered) {
    return false;
  }
  if (!input.localCacheRead) {
    return true;
  }
  // Only a first attempt is worth waiting out; a reconnecting environment has already failed.
  if (
    input.connectionState === "available" ||
    input.connectionState === "offline" ||
    input.connectionState === "reconnecting" ||
    input.connectionState === "error"
  ) {
    return false;
  }
  return (
    input.connectionState === "connecting" ||
    input.shellStatus === "synchronizing" ||
    (input.connectionState === "connected" && input.shellStatus === "empty") ||
    input.detailStatus === "synchronizing" ||
    (input.connectionState === "connected" && input.detailStatus === "empty")
  );
}

/**
 * How long a route whose thread isn't loaded waits for its environment to come up before it shows
 * "Thread unavailable". A link opened on a cold start or a resume usually finds the environment
 * not connected yet; one connection attempt may take up to its 15 s establishment timeout, and
 * the thread's first snapshot follows within a few seconds.
 */
export const THREAD_ROUTE_CONNECT_GRACE_MS = 20_000;

/**
 * A thread missing from the local snapshot may still arrive once the environment connects and the
 * thread is fetched by id, so an environment that is not connected yet, or is retrying, holds the
 * loading screen until the grace period ends. A switched-off or blocked environment won't connect
 * by itself.
 */
export function threadRouteAwaitsConnection(input: {
  readonly connectionState: EnvironmentConnectionPhase;
  readonly environmentEnabled: boolean;
  readonly detailStatus: EnvironmentThreadStatus;
  readonly graceExpired: boolean;
}): boolean {
  if (input.detailStatus === "deleted" || input.graceExpired || !input.environmentEnabled) {
    return false;
  }
  return (
    input.connectionState === "available" ||
    input.connectionState === "offline" ||
    input.connectionState === "reconnecting"
  );
}

/** An offline or backing-off environment retries now rather than after its backoff. */
export function threadRouteStartsConnection(connectionState: EnvironmentConnectionPhase): boolean {
  return connectionState === "offline" || connectionState === "reconnecting";
}

/**
 * Replacing the route with a draft can't be undone, so only a thread this route already showed,
 * and which the environment then reported deleted, opens a new task in its place. A link to a
 * thread the app hasn't loaded shows "Thread unavailable" instead, so the user can reconnect.
 */
export function threadRouteOpensDraft(input: {
  readonly detailStatus: EnvironmentThreadStatus;
  readonly threadWasShown: boolean;
}): boolean {
  return input.detailStatus === "deleted" && input.threadWasShown;
}

/**
 * A thread keeps its sync error until the new connection resubscribes, so the first renders after
 * a reconnect still show the old connection's error. Only an error the live connection reported
 * counts.
 */
export function threadDetailErrorIsCurrent<E>(input: {
  readonly connectionState: EnvironmentConnectionPhase;
  readonly error: Option.Option<E>;
  readonly errorBeforeConnected: Option.Option<E>;
}): boolean {
  return (
    Option.isSome(input.error) &&
    !(input.connectionState === "connected" && input.error === input.errorBeforeConnected)
  );
}
