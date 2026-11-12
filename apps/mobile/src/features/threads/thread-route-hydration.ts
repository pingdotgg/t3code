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
  /** The open thread's family read can still bring the row of a thread the shell left out. */
  readonly familyPending: boolean;
}): boolean {
  if (input.detailStatus === "deleted" || input.shellHasError) {
    return false;
  }
  if (input.detailHasError) {
    return input.connectionState === "connected" && input.familyPending;
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
 * Replacing the route with a draft can't be undone, so a thread that may still arrive keeps its
 * route: a reconnecting environment often delivers it moments later, and Reconnect starts a
 * fresh connecting attempt.
 */
export function threadRouteOpensDraft(input: {
  readonly connectionState: EnvironmentConnectionPhase;
  readonly detailStatus: EnvironmentThreadStatus;
}): boolean {
  if (input.detailStatus === "deleted") {
    return true;
  }
  return input.connectionState !== "reconnecting" && input.connectionState !== "connecting";
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

/**
 * What the screen of a chat the workspace reopened by itself does while no shell row proves the
 * chat. Only its detail can say it was archived or deleted, and cached detail can predate an
 * unarchive on another client, so that closes the chat only when no synced read is coming. A chat
 * with a page the user opened on it or in it is left alone: closing would take that page along.
 */
export function reopenedThreadOutcome(input: {
  readonly alone: boolean;
  readonly isLoadingConnections: boolean;
  readonly environmentRegistered: boolean;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly detailStatus: EnvironmentThreadStatus;
  readonly detailHasError: boolean;
  readonly thread: {
    readonly archivedAt: string | null;
    readonly deletedAt: string | null;
  } | null;
}): "keep" | "wait" | "close" {
  const gone =
    input.thread === null
      ? input.detailStatus === "deleted"
      : input.thread.archivedAt !== null || input.thread.deletedAt !== null;
  if (!gone || !input.alone) return "keep";
  const synced = input.thread === null || input.detailStatus === "live";
  const syncComing =
    !input.detailHasError &&
    (input.isLoadingConnections ||
      (input.environmentRegistered &&
        (input.connectionState === "connecting" || input.connectionState === "connected")));
  return !synced && syncComing ? "wait" : "close";
}
