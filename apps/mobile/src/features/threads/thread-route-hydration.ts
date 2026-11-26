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
 * Replacing the route with a draft can't be undone, so only a thread this route already showed and
 * the environment then deleted gives up its route. A linked thread that never arrived keeps waiting.
 */
export function threadRouteOpensDraft(input: {
  readonly detailStatus: EnvironmentThreadStatus;
  readonly threadWasShown: boolean;
}): boolean {
  return input.detailStatus === "deleted" && input.threadWasShown;
}

/** Until its environment connects, a thread that hasn't arrived may still exist. */
export function threadRouteConnectionWait(input: {
  readonly environmentActive: boolean;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly detailStatus: EnvironmentThreadStatus;
}): "connecting" | "unreachable" | null {
  if (!input.environmentActive || input.detailStatus === "deleted") {
    return null;
  }
  switch (input.connectionState) {
    case "available":
    case "connecting":
      return "connecting";
    case "offline":
    case "reconnecting":
    case "error":
      return "unreachable";
    case "connected":
    case "unsupported":
      return null;
  }
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
