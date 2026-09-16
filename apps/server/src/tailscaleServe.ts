/**
 * Ownership rules for the Tailscale Serve mapping a server publishes.
 *
 * The mapping is tailnet-wide state keyed only by HTTPS port, so every server
 * that starts with `tailscaleServeEnabled` competes for the same slot — a
 * second desktop instance lands on the next free backend port and would
 * otherwise repoint the tailnet URL away from the healthy first one. The rule
 * is therefore: claim the mapping when it is free, ours, or stale, and never
 * when it still reaches a live server.
 */
import {
  disableTailscaleServe,
  ensureTailscaleServe,
  readTailscaleServeTarget,
  type TailscaleServeTarget,
} from "@t3tools/tailscale";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { probeEnvironmentDescriptor } from "./environmentProbe.ts";
import { formatHostForUrl, isLoopbackHost } from "./startupAccess.ts";

/** A mapping this server wrote, and is therefore allowed to remove again. */
export interface OwnedTailscaleServeMapping {
  readonly servePort: number;
  readonly localPort: number;
}

// The server always publishes itself on loopback, so a loopback target on our
// port is our own mapping - persisted by tailscale across a restart, or just
// written by us.
const isOwnMapping = (target: TailscaleServeTarget, localPort: number): boolean =>
  target.localPort === localPort && isLoopbackHost(target.localHost);

const targetOrigin = (target: TailscaleServeTarget): string =>
  `http://${formatHostForUrl(target.localHost)}:${String(target.localPort)}`;

/**
 * Points the serve mapping at this server unless something live already holds
 * it. Returns the mapping to remove on shutdown, or null when this server does
 * not own one.
 */
export const acquireTailscaleServe = Effect.fn("server.tailscaleServe.acquire")(function* (input: {
  readonly localPort: number;
  readonly servePort: number;
}): Effect.fn.Return<
  OwnedTailscaleServeMapping | null,
  never,
  ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
> {
  const { localPort, servePort } = input;
  const existing = yield* readTailscaleServeTarget({ servePort }).pipe(
    // An unreadable mapping is treated as unclaimed, which is what this did
    // before there was a check at all.
    Effect.catch((cause) =>
      Effect.logWarning("Could not read the Tailscale Serve mapping; treating it as unclaimed", {
        cause,
        servePort,
      }).pipe(Effect.as(null)),
    ),
  );

  if (existing !== null) {
    if (isOwnMapping(existing, localPort)) {
      yield* Effect.logInfo("Tailscale Serve already maps to this server", {
        localPort,
        servePort,
      });
      return { localPort, servePort };
    }
    const occupant = yield* probeEnvironmentDescriptor(targetOrigin(existing));
    if (occupant._tag !== "unreachable") {
      yield* Effect.logWarning(
        "Tailscale Serve already fronts a live server on another port; leaving it in place",
        {
          localPort,
          servePort,
          existingLocalPort: existing.localPort,
          ...(occupant._tag === "descriptor"
            ? { existingEnvironmentId: occupant.descriptor.environmentId }
            : {}),
        },
      );
      return null;
    }
    yield* Effect.logInfo("Reclaiming a Tailscale Serve mapping whose target is gone", {
      localPort,
      servePort,
      staleLocalPort: existing.localPort,
    });
  }

  return yield* ensureTailscaleServe({ localPort, servePort, localHost: "127.0.0.1" }).pipe(
    Effect.as({ localPort, servePort }),
    Effect.tap(() => Effect.logInfo("Tailscale Serve configured", { localPort, servePort })),
    Effect.catch((cause) =>
      Effect.logWarning("Failed to configure Tailscale Serve", {
        cause,
        localPort,
        servePort,
      }).pipe(Effect.as(null)),
    ),
  );
});

/**
 * Removes the mapping on shutdown, but only while it still points at us: a
 * server that started later may have taken it over legitimately, and tearing
 * that down would strand the tailnet URL.
 */
export const releaseTailscaleServe = (
  owned: OwnedTailscaleServeMapping | null,
): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> => {
  if (owned === null) {
    return Effect.void;
  }
  return Effect.gen(function* () {
    const current = yield* readTailscaleServeTarget({ servePort: owned.servePort }).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (current !== null && !isOwnMapping(current, owned.localPort)) {
      yield* Effect.logInfo("Tailscale Serve now points elsewhere; leaving it in place", {
        servePort: owned.servePort,
        currentLocalPort: current.localPort,
      });
      return;
    }
    yield* disableTailscaleServe({ servePort: owned.servePort }).pipe(
      Effect.tap(() => Effect.logInfo("Tailscale Serve disabled", { servePort: owned.servePort })),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to disable Tailscale Serve", {
          cause,
          servePort: owned.servePort,
        }),
      ),
    );
  });
};
