import {
  EnvironmentPortRouter,
  type EnvironmentPortRouteRequest,
} from "@t3tools/client-runtime/preview";
import {
  createRuntimeCommand,
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

interface AcquiredRoute {
  readonly resolution: PreviewUrlResolution;
  readonly scope: Scope.Closeable;
}

export interface BrowserNavigationRoute {
  readonly resolution: PreviewUrlResolution;
  readonly commit: (tabId: string) => Promise<void>;
  readonly release: () => Promise<void>;
}

const activeRoutes = new Map<string, Scope.Closeable>();

const closeRouteScope = (scope: Scope.Closeable): Promise<void> =>
  Effect.runPromise(Scope.close(scope, Exit.void));

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
  const connection = readPreparedConnection(environmentId);
  if (connection === null) {
    throw new Error(`Environment ${environmentId} is not connected.`);
  }
  const result = await acquireRouteCommand.run(appAtomRegistry, { connection, target });
  if (result._tag === "Failure") {
    throw squashAtomCommandFailure(result);
  }

  const acquired = result.value;
  let ownership: "pending" | "committed" | "released" = "pending";
  return {
    resolution: acquired.resolution,
    commit: async (tabId) => {
      if (ownership !== "pending") return;
      ownership = "committed";
      const previous = activeRoutes.get(tabId);
      if (acquired.resolution.resolutionKind === "ssh-forward") {
        activeRoutes.set(tabId, acquired.scope);
      } else {
        activeRoutes.delete(tabId);
        await closeRouteScope(acquired.scope);
      }
      if (previous !== undefined && previous !== acquired.scope) {
        await closeRouteScope(previous);
      }
    },
    release: async () => {
      if (ownership !== "pending") return;
      ownership = "released";
      await closeRouteScope(acquired.scope);
    },
  };
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

export async function releaseBrowserNavigationRoute(tabId: string): Promise<void> {
  const scope = activeRoutes.get(tabId);
  if (scope === undefined) return;
  activeRoutes.delete(tabId);
  await closeRouteScope(scope);
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

export async function resetBrowserNavigationRoutesForTests(): Promise<void> {
  const scopes = [...activeRoutes.values()];
  activeRoutes.clear();
  await Promise.all(scopes.map(closeRouteScope));
}
