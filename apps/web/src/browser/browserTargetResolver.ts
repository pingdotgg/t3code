import {
  EnvironmentPortRouter,
  type EnvironmentPortRouteRequest,
} from "@t3tools/client-runtime/preview";
import {
  createRuntimeCommand,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  BrowserNavigationTarget,
  EnvironmentId,
  PreviewUrlResolution,
} from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readPreparedConnection } from "~/state/session";
import {
  createBrowserNavigationRoute,
  isBrowserNavigationRouteEnvironmentVersionCurrent,
  readBrowserNavigationRouteEnvironmentVersion,
  reserveBrowserNavigationRouteGeneration,
  type BrowserNavigationRoute,
} from "./browserNavigationRoutes";

interface AcquiredRoute {
  readonly resolution: PreviewUrlResolution;
  readonly scope: Scope.Closeable;
}

export class BrowserNavigationRouteAcquireInterrupted extends Error {
  override readonly name = "BrowserNavigationRouteAcquireInterrupted";
}

const acquireRouteCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "preview route acquisition",
  execute: ({ connection, target }: EnvironmentPortRouteRequest) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const resolution = yield* EnvironmentPortRouter.pipe(
        Effect.flatMap((router) => router.acquire({ connection, target })),
        Scope.provide(scope),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      );
      return { resolution, scope } satisfies AcquiredRoute;
    }),
});

export async function acquireBrowserNavigationTarget(
  environmentId: EnvironmentId,
  target: BrowserNavigationTarget,
): Promise<BrowserNavigationRoute> {
  const environmentVersion = readBrowserNavigationRouteEnvironmentVersion(environmentId);
  const routeGeneration = reserveBrowserNavigationRouteGeneration();
  const connection = readPreparedConnection(environmentId);
  if (connection === null) {
    throw new Error(`Environment ${environmentId} is not connected.`);
  }
  const result = await acquireRouteCommand.run(appAtomRegistry, { connection, target });
  if (result._tag === "Failure") {
    if (isAtomCommandInterrupted(result)) {
      throw new BrowserNavigationRouteAcquireInterrupted();
    }
    throw squashAtomCommandFailure(result);
  }

  const acquired = result.value;
  if (!isBrowserNavigationRouteEnvironmentVersionCurrent(environmentId, environmentVersion)) {
    await Effect.runPromise(Scope.close(acquired.scope, Exit.void));
    throw new Error(`Environment ${environmentId} disconnected during preview route acquisition.`);
  }
  return createBrowserNavigationRoute({
    environmentId,
    generation: routeGeneration,
    resolution: acquired.resolution,
    scope: acquired.scope,
  });
}

export async function acquireDiscoveredServerRoute(
  environmentId: EnvironmentId,
  rawUrl: string,
): Promise<BrowserNavigationRoute> {
  let url = rawUrl;
  try {
    url = normalizePreviewUrl(rawUrl);
  } catch {
    // Keep malformed input on the preview's normal navigation error path.
  }
  return acquireBrowserNavigationTarget(environmentId, { kind: "url", url });
}

export async function withBrowserNavigationRoute<A>(
  route: BrowserNavigationRoute | undefined,
  use: () => Promise<A>,
): Promise<A> {
  try {
    return await use();
  } finally {
    await route?.release();
  }
}
