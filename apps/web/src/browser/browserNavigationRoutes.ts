import type { EnvironmentId, PreviewUrlResolution } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

export interface BrowserNavigationRoute {
  readonly resolution: PreviewUrlResolution;
  readonly commit: (tabId: string) => Promise<void>;
  readonly release: () => Promise<void>;
}

type RoutePhase = "pending" | "active" | "retired" | "closed";

interface ManagedRoute {
  readonly environmentId: EnvironmentId;
  readonly generation: number;
  readonly resolution: PreviewUrlResolution;
  readonly scope: Scope.Closeable;
  readonly closeDeferred: Deferred.Deferred<void>;
  closeStarted: boolean;
  phase: RoutePhase;
  tabId: string | null;
  useFinished: boolean;
}

const activeRoutes = new Map<string, ManagedRoute>();
const latestRouteGenerationByTab = new Map<string, number>();
const environmentVersions = new Map<EnvironmentId, number>();
const routes = new Set<ManagedRoute>();
let nextRouteGeneration = 0;

const closeRoute = (route: ManagedRoute): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (route.closeStarted) return Deferred.await(route.closeDeferred);
    route.closeStarted = true;
    route.phase = "closed";
    routes.delete(route);
    if (route.tabId !== null && activeRoutes.get(route.tabId) === route) {
      activeRoutes.delete(route.tabId);
    }
    return Scope.close(route.scope, Exit.void).pipe(
      Effect.onExit((exit) => Deferred.done(route.closeDeferred, exit)),
    );
  });

const retireRoute = (route: ManagedRoute): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (route.phase === "closed") return closeRoute(route);
    route.phase = "retired";
    return route.useFinished ? closeRoute(route) : Effect.void;
  });

export function readBrowserNavigationRouteEnvironmentVersion(environmentId: EnvironmentId): number {
  return environmentVersions.get(environmentId) ?? 0;
}

export function isBrowserNavigationRouteEnvironmentVersionCurrent(
  environmentId: EnvironmentId,
  version: number,
): boolean {
  return readBrowserNavigationRouteEnvironmentVersion(environmentId) === version;
}

export function reserveBrowserNavigationRouteGeneration(): number {
  return ++nextRouteGeneration;
}

/**
 * Keeps a committed SSH route alive for its tab. Newer navigation wins, while
 * an older in-flight navigation keeps its own route until that use finishes.
 */
export function createBrowserNavigationRoute(input: {
  readonly environmentId: EnvironmentId;
  readonly generation: number;
  readonly resolution: PreviewUrlResolution;
  readonly scope: Scope.Closeable;
}): BrowserNavigationRoute {
  const route: ManagedRoute = {
    environmentId: input.environmentId,
    generation: input.generation,
    resolution: input.resolution,
    scope: input.scope,
    closeDeferred: Deferred.makeUnsafe(),
    closeStarted: false,
    phase: "pending",
    tabId: null,
    useFinished: false,
  };
  routes.add(route);

  return {
    resolution: route.resolution,
    commit: async (tabId) => {
      if (route.phase !== "pending") return;
      route.tabId = tabId;
      const latestGeneration = latestRouteGenerationByTab.get(tabId) ?? 0;
      if (route.generation < latestGeneration) {
        await Effect.runPromise(retireRoute(route));
        return;
      }

      latestRouteGenerationByTab.set(tabId, route.generation);
      const previous = activeRoutes.get(tabId);
      if (route.resolution.resolutionKind === "ssh-forward") {
        route.phase = "active";
        activeRoutes.set(tabId, route);
      } else {
        route.phase = "retired";
        activeRoutes.delete(tabId);
      }
      if (previous !== undefined && previous !== route) {
        await Effect.runPromise(retireRoute(previous));
      }
    },
    release: async () => {
      if (route.phase === "closed") return;
      route.useFinished = true;
      if (route.phase === "active") return;
      await Effect.runPromise(closeRoute(route));
    },
  };
}

const releaseBrowserNavigationRouteEffect = Effect.fn("web.browserNavigationRoutes.releaseTab")(
  function* (tabId: string) {
    latestRouteGenerationByTab.set(tabId, ++nextRouteGeneration);
    const matchingRoutes = [...routes].filter((route) => route.tabId === tabId);
    activeRoutes.delete(tabId);
    yield* Effect.forEach(matchingRoutes, retireRoute, {
      concurrency: "unbounded",
      discard: true,
    });
  },
);

export function releaseBrowserNavigationRoute(tabId: string): Promise<void> {
  return Effect.runPromise(releaseBrowserNavigationRouteEffect(tabId));
}

export const releaseBrowserNavigationRoutesForEnvironmentEffect = Effect.fn(
  "web.browserNavigationRoutes.releaseEnvironment",
)(function* (environmentId: EnvironmentId) {
  environmentVersions.set(
    environmentId,
    readBrowserNavigationRouteEnvironmentVersion(environmentId) + 1,
  );
  const matchingRoutes = [...routes].filter((route) => route.environmentId === environmentId);
  for (const route of matchingRoutes) {
    if (route.tabId !== null) {
      latestRouteGenerationByTab.set(route.tabId, ++nextRouteGeneration);
      if (activeRoutes.get(route.tabId) === route) {
        activeRoutes.delete(route.tabId);
      }
    }
  }
  yield* Effect.forEach(matchingRoutes, closeRoute, {
    concurrency: "unbounded",
    discard: true,
  });
});

export function resetBrowserNavigationRoutesForTests(): Promise<void> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const existingRoutes = [...routes];
      activeRoutes.clear();
      latestRouteGenerationByTab.clear();
      environmentVersions.clear();
      yield* Effect.forEach(existingRoutes, closeRoute, {
        concurrency: "unbounded",
        discard: true,
      });
      nextRouteGeneration = 0;
    }),
  );
}
