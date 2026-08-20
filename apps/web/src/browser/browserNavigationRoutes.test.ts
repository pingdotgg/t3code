import { EnvironmentId, type PreviewUrlResolution } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import { afterEach, describe, expect } from "vite-plus/test";

import {
  createBrowserNavigationRoute,
  readBrowserNavigationRouteEnvironmentVersion,
  releaseBrowserNavigationRoute,
  releaseBrowserNavigationRoutesForEnvironmentEffect,
  reserveBrowserNavigationRouteGeneration,
  resetBrowserNavigationRoutesForTests,
} from "./browserNavigationRoutes";

const environmentId = EnvironmentId.make("environment-1");

const sshResolution = (resolvedUrl: string): PreviewUrlResolution => ({
  requestedUrl: "http://localhost:5173",
  resolvedUrl,
  resolutionKind: "ssh-forward",
  environmentId,
});

const makeTrackedScope = Effect.fn("browserNavigationRoutes.test.makeTrackedScope")(function* (
  onClose: () => void,
) {
  const scope = yield* Scope.make();
  yield* Scope.addFinalizer(scope, Effect.sync(onClose));
  return scope;
});

afterEach(async () => {
  await resetBrowserNavigationRoutesForTests();
});

describe("browser navigation routes", () => {
  it.effect("keeps a replaced route alive until its in-flight navigation finishes", () =>
    Effect.gen(function* () {
      let firstCloses = 0;
      let secondCloses = 0;
      const first = createBrowserNavigationRoute({
        environmentId,
        generation: reserveBrowserNavigationRouteGeneration(),
        resolution: sshResolution("http://127.0.0.1:41001"),
        scope: yield* makeTrackedScope(() => firstCloses++),
      });
      const second = createBrowserNavigationRoute({
        environmentId,
        generation: reserveBrowserNavigationRouteGeneration(),
        resolution: sshResolution("http://127.0.0.1:41002"),
        scope: yield* makeTrackedScope(() => secondCloses++),
      });

      yield* Effect.promise(() => first.commit("tab-1"));
      yield* Effect.promise(() => second.commit("tab-1"));
      yield* Effect.promise(() => second.release());

      expect(firstCloses).toBe(0);
      expect(secondCloses).toBe(0);

      yield* Effect.promise(() => first.release());
      expect(firstCloses).toBe(1);

      yield* Effect.promise(() => releaseBrowserNavigationRoute("tab-1"));
      expect(secondCloses).toBe(1);
    }),
  );

  it.effect("does not let an older navigation replace a newer committed route", () =>
    Effect.gen(function* () {
      let olderCloses = 0;
      let newerCloses = 0;
      const olderGeneration = reserveBrowserNavigationRouteGeneration();
      const newerGeneration = reserveBrowserNavigationRouteGeneration();
      const newer = createBrowserNavigationRoute({
        environmentId,
        generation: newerGeneration,
        resolution: sshResolution("http://127.0.0.1:41002"),
        scope: yield* makeTrackedScope(() => newerCloses++),
      });
      const older = createBrowserNavigationRoute({
        environmentId,
        generation: olderGeneration,
        resolution: sshResolution("http://127.0.0.1:41001"),
        scope: yield* makeTrackedScope(() => olderCloses++),
      });

      yield* Effect.promise(() => newer.commit("tab-1"));
      yield* Effect.promise(() => newer.release());
      yield* Effect.promise(() => older.commit("tab-1"));
      yield* Effect.promise(() => older.release());

      expect(olderCloses).toBe(1);
      expect(newerCloses).toBe(0);

      yield* Effect.promise(() => releaseBrowserNavigationRoute("tab-1"));
      expect(newerCloses).toBe(1);
    }),
  );

  it.effect("keeps a removed tab route alive until its in-flight navigation finishes", () =>
    Effect.gen(function* () {
      let closes = 0;
      const route = createBrowserNavigationRoute({
        environmentId,
        generation: reserveBrowserNavigationRouteGeneration(),
        resolution: sshResolution("http://127.0.0.1:41001"),
        scope: yield* makeTrackedScope(() => closes++),
      });
      yield* Effect.promise(() => route.commit("tab-1"));

      yield* Effect.promise(() => releaseBrowserNavigationRoute("tab-1"));
      expect(closes).toBe(0);

      yield* Effect.promise(() => route.release());
      expect(closes).toBe(1);
    }),
  );

  it.effect("closes routes and invalidates acquisitions when an environment is removed", () =>
    Effect.gen(function* () {
      let closes = 0;
      const version = readBrowserNavigationRouteEnvironmentVersion(environmentId);
      const route = createBrowserNavigationRoute({
        environmentId,
        generation: reserveBrowserNavigationRouteGeneration(),
        resolution: sshResolution("http://127.0.0.1:41001"),
        scope: yield* makeTrackedScope(() => closes++),
      });
      yield* Effect.promise(() => route.commit("tab-1"));
      yield* Effect.promise(() => route.release());

      yield* releaseBrowserNavigationRoutesForEnvironmentEffect(environmentId);

      expect(closes).toBe(1);
      expect(readBrowserNavigationRouteEnvironmentVersion(environmentId)).toBe(version + 1);
    }),
  );
});
