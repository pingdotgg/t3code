import {
  EnvironmentAuthInvalidError,
  type AuthBrowserSessionResult,
  type AuthCreatePairingCredentialInput,
  type AuthSessionState,
  type DesktopBridge,
} from "@t3tools/contracts";
import { createBrowserHistory } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { installEnvironmentHttpTest } from "../test/environmentHttpTest";
import { __setPrimaryHttpRunnerForTests } from "./lib/runtime";

type TestWindow = {
  location: URL;
  history: {
    state: unknown;
    replaceState: (_data: unknown, _unused: string, url?: string) => void;
  };
  desktopBridge?: DesktopBridge;
};

const LOOPBACK_AUTH = {
  policy: "loopback-browser",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["browser-session-cookie"],
  sessionCookieName: "t3_session",
} as const;

const DESKTOP_AUTH = {
  policy: "desktop-managed-local",
  bootstrapMethods: ["desktop-bootstrap"],
  sessionMethods: ["browser-session-cookie"],
  sessionCookieName: "t3_session",
} as const;

const SESSION_EXPIRES_AT = DateTime.makeUnsafe("2026-04-05T00:00:00.000Z");
const unauthenticatedSession = (auth: AuthSessionState["auth"]): AuthSessionState => ({
  authenticated: false,
  auth,
});

const authenticatedSession = (auth: AuthSessionState["auth"]): AuthSessionState => ({
  authenticated: true,
  auth,
  sessionMethod: "browser-session-cookie",
  expiresAt: SESSION_EXPIRES_AT,
});

const browserSession = (scopes: AuthBrowserSessionResult["scopes"]): AuthBrowserSessionResult => ({
  authenticated: true,
  scopes,
  sessionMethod: "browser-session-cookie",
  expiresAt: SESSION_EXPIRES_AT,
});

function installTestBrowser(url: string) {
  const testWindow: TestWindow = {
    location: new URL(url),
    history: {
      state: null,
      replaceState: (data, _unused, nextUrl) => {
        testWindow.history.state = data;
        if (nextUrl !== undefined) {
          testWindow.location = new URL(nextUrl, testWindow.location.href);
        }
      },
    },
  };

  vi.stubGlobal("window", testWindow);
  vi.stubGlobal("document", { title: "T3 Code" });

  return testWindow;
}

function sequence<A>(...values: ReadonlyArray<A>) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

function createSignal() {
  let resolve = () => {};
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

let disposeHttpTest: (() => Promise<void>) | undefined;

async function installAuthApi(input: {
  readonly session?: () => AuthSessionState;
  readonly browserSession?: (
    credential: string,
  ) => Effect.Effect<AuthBrowserSessionResult, EnvironmentAuthInvalidError>;
  readonly pairingCredential?: (payload: AuthCreatePairingCredentialInput) => Effect.Effect<{
    readonly id: string;
    readonly credential: string;
    readonly label?: string;
    readonly expiresAt: DateTime.Utc;
  }>;
}) {
  const testApi = await installEnvironmentHttpTest({
    ...(input.session ? { session: () => Effect.succeed(input.session!()) } : {}),
    ...(input.browserSession
      ? { browserSession: (payload) => input.browserSession!(payload.credential) }
      : {}),
    ...(input.pairingCredential
      ? { pairingCredential: (payload) => input.pairingCredential!(payload) }
      : {}),
  });
  disposeHttpTest = testApi.dispose;
  return testApi;
}

describe("resolveInitialServerAuthGateState", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    installTestBrowser("http://localhost/");
  });

  afterEach(async () => {
    await disposeHttpTest?.();
    disposeHttpTest = undefined;
    const { __resetServerAuthBootstrapForTests } = await import("./environments/primary");
    __resetServerAuthBootstrapForTests();
    __setPrimaryHttpRunnerForTests();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reuses an in-flight silent bootstrap attempt", async () => {
    const nextSession = sequence(
      unauthenticatedSession(DESKTOP_AUTH),
      authenticatedSession(DESKTOP_AUTH),
    );
    const testApi = await installAuthApi({
      session: nextSession,
      browserSession: () => Effect.succeed(browserSession(["orchestration:read", "access:write"])),
    });

    const testWindow = installTestBrowser("http://localhost/");
    testWindow.desktopBridge = {
      getLocalEnvironmentBootstraps: () => [
        {
          id: "primary",
          label: "Windows",
          httpBaseUrl: "http://localhost:3773",
          wsBaseUrl: "ws://localhost:3773",
          bootstrapToken: "desktop-bootstrap-token",
        },
      ],
    } as unknown as DesktopBridge;

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    await Promise.all([resolveInitialServerAuthGateState(), resolveInitialServerAuthGateState()]);

    expect(testApi.calls.session).toBe(2);
    expect(testApi.calls.browserSession).toEqual([{ credential: "desktop-bootstrap-token" }]);
  });

  it("reuses an unpaired result when the router redirects to pairing", async () => {
    const testApi = await installAuthApi({ session: () => unauthenticatedSession(LOOPBACK_AUTH) });
    const { resolveInitialServerAuthGateState } = await import("./environments/primary");
    const requiresAuth = { status: "requires-auth", auth: LOOPBACK_AUTH };

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual(requiresAuth);
    await expect(resolveInitialServerAuthGateState()).resolves.toEqual(requiresAuth);

    expect(testApi.calls.session).toBe(1);
  });

  it("times out a stalled session fetch instead of holding the splash", async () => {
    const requestStarted = createSignal();
    const testApi = await installEnvironmentHttpTest({
      session: () => Effect.sync(requestStarted.resolve).pipe(Effect.andThen(Effect.never)),
    });
    disposeHttpTest = testApi.dispose;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { fetchSessionState } = await import("./environments/primary/auth");

    let failure: unknown;
    const settled = fetchSessionState().then(
      () => {},
      (error: unknown) => {
        failure = error;
      },
    );
    await requestStarted.promise;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(failure).toMatchObject({
      _tag: "PrimaryEnvironmentRequestError",
      operation: "fetch-session-state",
    });
    expect((failure as Error).message).toBe(
      "Primary environment request failed during fetch-session-state (timed out).",
    );
    expect(testApi.calls.session).toBe(1);
    await settled;
  });

  it("holds a desktop bootstrap until its starting backend answers", async () => {
    const request = HttpClientRequest.get("http://localhost/api/auth/session");
    const refused = new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ request, description: "connection refused" }),
    });
    let backendReady = false;
    let attempts = 0;
    __setPrimaryHttpRunnerForTests(() => {
      attempts += 1;
      return backendReady
        ? (Promise.resolve(authenticatedSession(DESKTOP_AUTH)) as Promise<never>)
        : Promise.reject(refused);
    });
    const testWindow = installTestBrowser("http://localhost/");
    testWindow.desktopBridge = {
      getLocalEnvironmentBootstraps: () => [
        {
          id: "primary",
          label: "Local",
          httpBaseUrl: "http://localhost:3773",
          wsBaseUrl: "ws://localhost:3773",
          bootstrapToken: "desktop-bootstrap-token",
        },
      ],
    } as unknown as DesktopBridge;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    let outcome: unknown;
    const settled = resolveInitialServerAuthGateState().then(
      (state) => {
        outcome = state;
      },
      (error: unknown) => {
        outcome = error;
      },
    );
    // A first launch after an update can migrate for well over a minute.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(outcome).toBeUndefined();
    const attemptsWhileStarting = attempts;
    expect(attemptsWhileStarting).toBeGreaterThan(1);

    backendReady = true;
    await vi.advanceTimersByTimeAsync(500);

    expect(outcome).toEqual({ status: "authenticated" });
    expect(attempts).toBe(attemptsWhileStarting + 1);
    await settled;
  });

  it("stops retrying an unavailable session endpoint after three seconds", async () => {
    const request = HttpClientRequest.get("http://localhost/api/auth/session");
    const unavailable = new HttpClientError.HttpClientError({
      reason: new HttpClientError.StatusCodeError({
        request,
        response: HttpClientResponse.fromWeb(request, new Response(null, { status: 503 })),
      }),
    });
    let attempts = 0;
    __setPrimaryHttpRunnerForTests(() => {
      attempts += 1;
      return Promise.reject(unavailable);
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { fetchSessionState } = await import("./environments/primary/auth");

    let failure: unknown;
    const settled = fetchSessionState().then(
      () => {},
      (error: unknown) => {
        failure = error;
      },
    );
    await vi.advanceTimersByTimeAsync(3_000);

    expect(failure).toMatchObject({ _tag: "PrimaryEnvironmentRequestError", status: 503 });
    expect(attempts).toBe(7);
    await settled;
  });

  it("takes a pairing token from the location hash and strips it immediately", async () => {
    const testWindow = installTestBrowser("http://localhost/#token=pairing-token");
    const { takePairingTokenFromUrl } = await import("./environments/primary");

    expect(takePairingTokenFromUrl()).toBe("pairing-token");
    expect(testWindow.location.hash).toBe("");
    expect(testWindow.location.searchParams.get("token")).toBeNull();
  });

  it.each([
    { suffix: "#token=replacement-token", cached: false },
    { suffix: "#token=replacement-token", cached: true },
    { suffix: "?token=replacement-token", cached: true },
    { suffix: "/#token=replacement-token", cached: true },
  ])(
    "re-pairs an authenticated browser with $suffix when cached=$cached",
    async ({ suffix, cached }) => {
      let scopes: AuthBrowserSessionResult["scopes"] = ["orchestration:read"];
      const testApi = await installAuthApi({
        session: () => ({ ...authenticatedSession(LOOPBACK_AUTH), scopes }),
        browserSession: () =>
          Effect.sync(() => {
            scopes = ["orchestration:read", "orchestration:operate"];
            return browserSession(scopes);
          }),
      });
      const testWindow = installTestBrowser("http://localhost/");
      const {
        resolveInitialServerAuthGateState,
        submitServerAuthCredential,
        takePairingTokenFromUrl,
      } = await import("./environments/primary");
      const { fetchSessionState } = await import("./environments/primary/auth");

      if (cached) {
        await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
          status: "authenticated",
        });
      }

      testWindow.location = new URL(`http://localhost/pair${suffix}`);
      await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
        status: "requires-auth",
        auth: LOOPBACK_AUTH,
      });
      expect(testApi.calls.browserSession).toEqual([]);

      const token = takePairingTokenFromUrl();
      expect(token).toBe("replacement-token");
      await submitServerAuthCredential(token!);

      expect(testApi.calls.browserSession).toEqual([{ credential: "replacement-token" }]);
      await expect(fetchSessionState()).resolves.toMatchObject({
        authenticated: true,
        scopes: ["orchestration:read", "orchestration:operate"],
      });
      await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
        status: "authenticated",
      });
    },
  );

  it.each([false, true])(
    "keeps rejected replacement pairing open when cached=%s",
    async (cached) => {
      const existingSession = {
        ...authenticatedSession(LOOPBACK_AUTH),
        scopes: ["orchestration:read"] as const,
      };
      const exchangeStarted = createSignal();
      const finishExchange = createSignal();
      const testApi = await installAuthApi({
        session: () => existingSession,
        browserSession: () =>
          Effect.gen(function* () {
            exchangeStarted.resolve();
            yield* Effect.promise(() => finishExchange.promise);
            return yield* new EnvironmentAuthInvalidError({
              code: "auth_invalid",
              reason: "invalid_credential",
              traceId: "trace-invalid-replacement",
            });
          }),
      });
      const testWindow = installTestBrowser("http://localhost/");
      const {
        resolveInitialServerAuthGateState,
        submitServerAuthCredential,
        takePairingTokenFromUrl,
      } = await import("./environments/primary");
      const { fetchSessionState } = await import("./environments/primary/auth");
      if (cached) {
        await resolveInitialServerAuthGateState();
      }
      testWindow.location = new URL("http://localhost/pair#token=invalid-replacement");
      const history = createBrowserHistory({
        window: {
          get location() {
            return testWindow.location;
          },
          history: testWindow.history,
          addEventListener() {},
          removeEventListener() {},
        },
      });
      const gateLoads: Array<ReturnType<typeof resolveInitialServerAuthGateState>> = [];
      const unsubscribe = history.subscribe(() => {
        gateLoads.push(resolveInitialServerAuthGateState());
      });
      try {
        const requiresAuth = { status: "requires-auth", auth: LOOPBACK_AUTH };
        await expect(resolveInitialServerAuthGateState()).resolves.toEqual(requiresAuth);

        // Token removal synchronously reloads the TanStack auth gate via replaceState.
        const token = takePairingTokenFromUrl();
        expect(gateLoads).toHaveLength(1);
        await expect(gateLoads[0]).resolves.toEqual(requiresAuth);
        const rejected = expect(submitServerAuthCredential(token!)).rejects.toMatchObject({
          _tag: "PrimaryEnvironmentPairingCredentialRejectedError",
          message: "Invalid pairing token. Check the token and try again.",
        });
        await exchangeStarted.promise;
        await expect(resolveInitialServerAuthGateState()).resolves.toEqual(requiresAuth);
        finishExchange.resolve();
        await rejected;
        await expect(resolveInitialServerAuthGateState()).resolves.toEqual(requiresAuth);
        expect(testApi.calls.browserSession).toEqual([{ credential: "invalid-replacement" }]);
        await expect(fetchSessionState()).resolves.toEqual(existingSession);

        testWindow.history.replaceState({}, "", "/");
        await expect(gateLoads[1]).resolves.toEqual({ status: "authenticated" });
        testWindow.history.replaceState({}, "", "/pair");
        await expect(gateLoads[2]).resolves.toEqual({ status: "authenticated" });
      } finally {
        finishExchange.resolve();
        unsubscribe();
        history.destroy();
      }
    },
  );

  it("makes later callers wait for a URL token that arrives during bootstrap", async () => {
    let releaseExchange!: () => void;
    const exchangeRelease = new Promise<void>((resolve) => {
      releaseExchange = resolve;
    });
    let markExchangeStarted!: () => void;
    const exchangeStarted = new Promise<void>((resolve) => {
      markExchangeStarted = resolve;
    });
    const nextSession = sequence(
      authenticatedSession(LOOPBACK_AUTH),
      authenticatedSession(LOOPBACK_AUTH),
    );
    const testApi = await installAuthApi({
      session: nextSession,
      browserSession: () => {
        markExchangeStarted();
        return Effect.promise(() => exchangeRelease).pipe(
          Effect.andThen(
            Effect.fail(
              new EnvironmentAuthInvalidError({
                code: "auth_invalid",
                reason: "invalid_credential",
                traceId: "trace-rejected-queued-credential",
              }),
            ),
          ),
        );
      },
    });
    const testWindow = installTestBrowser("http://localhost/");
    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    const initialBootstrap = resolveInitialServerAuthGateState();
    testWindow.location = new URL("http://localhost/#token=reusable-token");
    const explicitPairing = resolveInitialServerAuthGateState();
    const laterCaller = resolveInitialServerAuthGateState();
    let laterCallerSettled = false;
    void laterCaller.then(() => {
      laterCallerSettled = true;
    });

    try {
      await expect(initialBootstrap).resolves.toEqual({ status: "authenticated" });
      await exchangeStarted;
      expect(laterCallerSettled).toBe(false);
    } finally {
      releaseExchange();
    }

    const rejectedState = {
      status: "requires-auth",
      auth: LOOPBACK_AUTH,
      errorMessage: "Invalid pairing token. Check the token and try again.",
    } as const;
    await expect(explicitPairing).resolves.toEqual(rejectedState);
    await expect(laterCaller).resolves.toEqual(rejectedState);
    expect(testApi.calls.browserSession).toEqual([{ credential: "reusable-token" }]);
    expect(testApi.calls.session).toBe(2);
  });

  it("reports a rejected URL token without caching false success", async () => {
    const cause = new EnvironmentAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_credential",
      traceId: "trace-invalid-url-credential",
    });
    const nextSession = sequence(
      authenticatedSession(LOOPBACK_AUTH),
      unauthenticatedSession(LOOPBACK_AUTH),
    );
    const testApi = await installAuthApi({
      session: nextSession,
      browserSession: () => Effect.fail(cause),
    });
    installTestBrowser("http://localhost/#token=rejected-token");
    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: LOOPBACK_AUTH,
      errorMessage: "Invalid pairing token. Check the token and try again.",
    });
    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: LOOPBACK_AUTH,
    });
    expect(testApi.calls.browserSession).toEqual([{ credential: "rejected-token" }]);
  });
});
