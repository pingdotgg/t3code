import type { ThreadEnvMode } from "@t3tools/contracts/settings";

/**
 * Surfaces a client can run on, for deriving the default workspace mode of a
 * new thread. The deciding question is whether the user's attention is
 * attached to a local checkout they can see:
 *
 * - `attached-checkout`: the user is looking at the checkout (desktop app on
 *   a local project, browser opened on the same machine as the server). The
 *   agent working elsewhere would be invisible to them, so the default is
 *   the current checkout.
 * - `detached`: no local checkout in front of the user (remote browser,
 *   mobile, relay/SSH environments). Isolation in a fresh worktree is the
 *   only coherent default.
 */
export type ThreadSurface = "attached-checkout" | "detached";

export function surfaceDefaultThreadEnvMode(surface: ThreadSurface): ThreadEnvMode {
  return surface === "attached-checkout" ? "local" : "worktree";
}

/**
 * Resolve the effective workspace mode for a new thread.
 * `deriveFromSurface` (the default) derives the mode from where the client
 * runs; otherwise the explicit `configuredMode` applies everywhere.
 */
export function resolveDefaultThreadEnvMode(input: {
  readonly deriveFromSurface: boolean;
  readonly configuredMode: ThreadEnvMode;
  readonly surface: ThreadSurface;
}): ThreadEnvMode {
  return input.deriveFromSurface
    ? surfaceDefaultThreadEnvMode(input.surface)
    : input.configuredMode;
}
