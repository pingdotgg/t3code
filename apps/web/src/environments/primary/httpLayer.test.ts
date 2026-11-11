import { PRIMARY_LOCAL_ENVIRONMENT_ID, type DesktopBridge } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { HttpClient } from "effect/http";

import { __resetDesktopPrimaryAuthForTests } from "./desktopAuth";
import * as PrimaryEnvironmentHttpLayer from "./httpLayer";

function primaryBootstrap(port: number) {
  return {
    id: PRIMARY_LOCAL_ENVIRONMENT_ID,
    label: "Local environment",
    runningDistro: null,
    httpBaseUrl: `http://127.0.0.1:${port}/`,
    wsBaseUrl: `ws://127.0.0.1:${port}/`,
    bootstrapToken: "desktop-bootstrap-token",
  };
}

function createSignal<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("primary environment HTTP layer", { concurrent: false }, () => {
  afterEach(() => {
    __resetDesktopPrimaryAuthForTests();
    Reflect.deleteProperty(globalThis, "window");
    vi.unstubAllGlobals();
  });

  it.effect("uses cookie credentials for browser primary environments", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          href: "http://127.0.0.1:3773/settings",
          origin: "http://127.0.0.1:3773",
        },
      },
    });

    return Effect.gen(function* () {
      yield* HttpClient.get("http://127.0.0.1:3773/api/auth/session");

      const request = new Request(fetchMock.mock.calls[0]?.[0], fetchMock.mock.calls[0]?.[1]);
      expect(request.credentials).toBe("include");
      expect(request.headers.get("authorization")).toBeNull();
    }).pipe(Effect.provide(PrimaryEnvironmentHttpLayer.layerForCurrentOrigin()));
  });

  it.effect("uses bearer auth without cookies for desktop-managed primaries", () => {
    const requested = createSignal<void>();
    const bearerToken = createSignal<string>();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "t3code://app" },
        desktopBridge: {
          getLocalEnvironmentBootstraps: () => [primaryBootstrap(3773)],
          getLocalEnvironmentBearerToken: () => {
            requested.resolve(undefined);
            return bearerToken.promise;
          },
        } as unknown as DesktopBridge,
      },
    });

    return Effect.gen(function* () {
      const requestFiber = yield* HttpClient.get(
        "http://127.0.0.1:3773/api/connect/link-state",
      ).pipe(Effect.forkChild);
      yield* Effect.promise(() => requested.promise);
      expect(fetchMock).not.toHaveBeenCalled();
      bearerToken.resolve("desktop-bearer-token");
      yield* Fiber.join(requestFiber);

      const request = new Request(fetchMock.mock.calls[0]?.[0], fetchMock.mock.calls[0]?.[1]);
      expect(request.credentials).not.toBe("include");
      expect(request.headers.get("authorization")).toBe("Bearer desktop-bearer-token");
    }).pipe(Effect.provide(PrimaryEnvironmentHttpLayer.layerForCurrentOrigin()));
  });

  it.effect("reloads instead of sending the bearer when the backend moved ports after load", () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const reloaded = createSignal<void>();
    const requested = createSignal<void>();
    const bearerToken = createSignal<string>();
    let port = 3774;
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "t3code://app", reload: () => reloaded.resolve(undefined) },
        desktopBridge: {
          getLocalEnvironmentBootstraps: () => [primaryBootstrap(port)],
          getLocalEnvironmentBearerToken: () => {
            requested.resolve(undefined);
            return bearerToken.promise;
          },
        } as unknown as DesktopBridge,
      },
    });

    return Effect.gen(function* () {
      yield* HttpClient.get("http://127.0.0.1:3774/api/auth/session").pipe(Effect.forkChild);
      yield* Effect.promise(() => requested.promise);
      port = 3775;
      bearerToken.resolve("desktop-bearer-token");
      yield* Effect.promise(() => reloaded.promise);
      expect(fetchMock).not.toHaveBeenCalled();
    }).pipe(Effect.provide(PrimaryEnvironmentHttpLayer.layerForCurrentOrigin()));
  });
});
