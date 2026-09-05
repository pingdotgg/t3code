import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ProjectId,
  type AuthSessionState,
  type OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ThreadBoundedSnapshot,
  type OrchestrationV2ThreadHistoryPage,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import type { HttpClient } from "effect/unstable/http";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import {
  ConnectionTransientError,
  RelayConnectionTarget,
  type PreparedConnection,
  type PreparedHttpAuthorization,
} from "../connection/model.ts";
import { ManagedRelayDpopSigner, type ManagedRelayDpopProofInput } from "../relay/managedRelay.ts";
import { remoteHttpClientLayer, type RemoteEnvironmentRequestError } from "../rpc/http.ts";
import {
  fetchEnvironmentPullRequestDiff,
  type PullRequestDiffCredentialRejectedError,
  PullRequestDiffLoader,
  pullRequestDiffLoaderLayer,
} from "./pullRequestDiffHttp.ts";
import { withOrchestrationProtocolHeader } from "./environmentHttpAuth.ts";
import { fetchEnvironmentSessionState } from "./session.ts";
import { fetchEnvironmentShellSnapshot } from "./shellSnapshotHttp.ts";
import { fetchEnvironmentThreadSnapshot } from "./threadSnapshotHttp.ts";
import {
  boundedThreadSnapshotLoaderLayer,
  fetchEnvironmentBoundedThreadSnapshot,
} from "./boundedThreadSnapshotHttp.ts";
import { ThreadSnapshotLoader } from "./threadSnapshotHttp.ts";
import { fetchEnvironmentThreadHistoryPage } from "./threadHistoryHttp.ts";
import { v2Projection } from "./orchestrationV2TestFixtures.ts";

const encodeThreadSnapshot = Schema.encodeSync(OrchestrationV2ThreadDetailSnapshot);
const encodeBoundedSnapshot = Schema.encodeSync(OrchestrationV2ThreadBoundedSnapshot);

const TARGET = new RelayConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Remote environment",
});
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: "https://previous.example.test",
  socketUrl: "wss://previous.example.test/ws",
  httpAuthorization: { _tag: "Dpop", accessToken: "expired-token", expiresAtEpochMs: 0 },
  target: TARGET,
};
const CURRENT_ORIGIN = "https://current.example.test";
const RENEWED_ORIGIN = "https://renewed.example.test";
const DIFF = {
  projectId: ProjectId.make("project-1"),
  repository: "owner/repository",
  number: 42,
};
const DIFF_RESULT = { patch: "diff --git a/file.ts b/file.ts", truncated: false, nextCursor: null };
const AUTH = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["dpop-access-token"],
  sessionCookieName: "t3_session",
} satisfies AuthSessionState["auth"];
const SESSION = {
  authenticated: true,
  auth: AUTH,
  scopes: ["orchestration:read", "orchestration:operate"],
  sessionMethod: "dpop-access-token",
} satisfies AuthSessionState;
const UNAUTHENTICATED_SESSION = { authenticated: false, auth: AUTH } satisfies AuthSessionState;
const SHELL = {
  schemaVersion: 1,
  snapshotSequence: 1,
  projects: [],
  threads: [],
  archivedThreads: [],
} satisfies OrchestrationV2ShellSnapshot;
const THREAD = {
  snapshotSequence: 2,
  projection: v2Projection,
} satisfies OrchestrationV2ThreadDetailSnapshot;
const BOUNDED_THREAD = {
  ...THREAD,
  historyCursor: "older-page",
  hasMoreHistory: true,
  latestLocalTurnOrdinal: 3,
} satisfies OrchestrationV2ThreadBoundedSnapshot;
const THREAD_HISTORY = {
  snapshotSequence: 2,
  items: [],
  nextCursor: null,
  hasMoreHistory: false,
} satisfies OrchestrationV2ThreadHistoryPage;

function credentialRejectedResponse(reason = "invalid_credential") {
  return Response.json(
    {
      _tag: "EnvironmentAuthInvalidError",
      code: "auth_invalid",
      reason,
      traceId: "trace-rejected",
    },
    { status: 401 },
  );
}

function makeHarness(reply: (requestNumber: number) => Response | Promise<Response>) {
  const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
  const authorizations: Array<
    Parameters<RemoteEnvironmentAuthorization["Service"]["authorizeDpopHttp"]>[0]
  > = [];
  const proofs: Array<ManagedRelayDpopProofInput> = [];
  const remoteAuthorization = RemoteEnvironmentAuthorization.of({
    authorizeBearer: () => Effect.die("Unexpected bearer connection preparation."),
    authorizeDpop: () => Effect.die("HTTP requests must not prepare a WebSocket connection."),
    authorizeDpopHttp: (input) =>
      Effect.sync(() => {
        authorizations.push(input);
        const rejected = input.rejectedAccessToken !== undefined;
        return {
          environmentId: TARGET.environmentId,
          label: TARGET.label,
          httpBaseUrl: rejected ? RENEWED_ORIGIN : CURRENT_ORIGIN,
          httpAuthorization: {
            _tag: "Dpop" as const,
            accessToken: rejected ? "renewed-token" : "current-token",
            expiresAtEpochMs: 3_600_000,
          },
        };
      }),
  });
  const signer = ManagedRelayDpopSigner.of({
    thumbprint: Effect.succeed("test-thumbprint"),
    createProof: (input) =>
      Effect.sync(() => {
        proofs.push(input);
        return `proof-${proofs.length}`;
      }),
  });
  const fetchFn: typeof fetch = async (request, init) => {
    calls.push({ url: String(request), init: init ?? {} });
    return reply(calls.length);
  };
  return {
    calls,
    authorizations,
    proofs,
    remoteAuthorization,
    input: {
      prepared: PREPARED,
      signer: Option.some(signer),
      remoteAuthorization: Option.some(remoteAuthorization),
    },
    httpLayer: remoteHttpClientLayer(fetchFn),
  };
}

type HttpInput = ReturnType<typeof makeHarness>["input"];
const LOADERS: ReadonlyArray<{
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly response: unknown;
  readonly expected: unknown;
  readonly load: (
    input: HttpInput,
  ) => Effect.Effect<
    unknown,
    RemoteEnvironmentRequestError | PullRequestDiffCredentialRejectedError,
    HttpClient.HttpClient
  >;
}> = [
  {
    name: "PR diff",
    method: "POST",
    path: "/api/pull-requests/diff",
    response: DIFF_RESULT,
    expected: DIFF_RESULT,
    load: (input: HttpInput) => fetchEnvironmentPullRequestDiff({ ...input, diff: DIFF }),
  },
  {
    name: "session permissions",
    method: "GET",
    path: "/api/auth/session",
    response: SESSION,
    expected: SESSION,
    load: fetchEnvironmentSessionState,
  },
  {
    name: "shell snapshot",
    method: "GET",
    path: "/api/orchestration/shell",
    response: SHELL,
    expected: SHELL,
    load: fetchEnvironmentShellSnapshot,
  },
  {
    name: "thread snapshot",
    method: "GET",
    path: `/api/orchestration/threads/${THREAD.projection.thread.id}`,
    response: encodeThreadSnapshot(THREAD),
    expected: THREAD,
    load: (input: HttpInput) =>
      fetchEnvironmentThreadSnapshot({ ...input, threadId: THREAD.projection.thread.id }),
  },
  {
    name: "bounded thread snapshot",
    method: "GET",
    path: `/api/orchestration/threads/${THREAD.projection.thread.id}/bounded`,
    response: encodeBoundedSnapshot(BOUNDED_THREAD),
    expected: BOUNDED_THREAD,
    load: (input: HttpInput) =>
      fetchEnvironmentBoundedThreadSnapshot({ ...input, threadId: THREAD.projection.thread.id }),
  },
  {
    name: "older thread history",
    method: "GET",
    path: `/api/orchestration/threads/${THREAD.projection.thread.id}/history`,
    response: THREAD_HISTORY,
    expected: THREAD_HISTORY,
    load: (input: HttpInput) =>
      fetchEnvironmentThreadHistoryPage({
        ...input,
        threadId: THREAD.projection.thread.id,
        cursor: "older-page",
      }),
  },
];

describe("authenticated environment HTTP requests", () => {
  it.effect.each(LOADERS)("uses current relay authorization and endpoint for $name", (loader) =>
    Effect.gen(function* () {
      const harness = makeHarness(() => Response.json(loader.response));
      const result = yield* loader.load(harness.input).pipe(Effect.provide(harness.httpLayer));

      expect(result).toEqual(loader.expected);
      expect(harness.calls).toHaveLength(1);
      const call = harness.calls[0]!;
      const url = new URL(call.url);
      expect(url.origin).toBe(CURRENT_ORIGIN);
      expect(url.pathname).toBe(loader.path);
      expect(call.init.method).toBe(loader.method);
      expect(new Headers(call.init.headers).get("authorization")).toBe("DPoP current-token");
      expect(new Headers(call.init.headers).get("dpop")).toBe("proof-1");
      expect(call.init.credentials).toBeUndefined();
      if (loader.path.startsWith("/api/orchestration/")) {
        expect(new Headers(call.init.headers).get(ORCHESTRATION_PROTOCOL_HEADER)).toBe(
          ORCHESTRATION_PROTOCOL_VERSION_TEXT,
        );
      }
      expect(harness.authorizations).toEqual([{ expectedEnvironmentId: TARGET.environmentId }]);
      expect(harness.proofs).toEqual([
        {
          method: loader.method,
          url: `${CURRENT_ORIGIN}${loader.path}`,
          accessToken: "current-token",
        },
      ]);
      if (loader.name === "older thread history") {
        expect(url.searchParams.get("cursor")).toBe("older-page");
      }
      expect(PREPARED.httpAuthorization).toMatchObject({ accessToken: "expired-token" });
    }),
  );

  it.effect("retries a rejected diff once with a new token, endpoint, and proof", () =>
    Effect.gen(function* () {
      const harness = makeHarness((requestNumber) =>
        requestNumber === 1 ? credentialRejectedResponse() : Response.json(DIFF_RESULT),
      );
      const result = yield* fetchEnvironmentPullRequestDiff({ ...harness.input, diff: DIFF }).pipe(
        Effect.provide(harness.httpLayer),
      );

      expect(result).toEqual(DIFF_RESULT);
      expect(harness.authorizations).toEqual([
        { expectedEnvironmentId: TARGET.environmentId },
        { expectedEnvironmentId: TARGET.environmentId, rejectedAccessToken: "current-token" },
      ]);
      expect(harness.calls.map((call) => call.url)).toEqual([
        `${CURRENT_ORIGIN}/api/pull-requests/diff`,
        `${RENEWED_ORIGIN}/api/pull-requests/diff`,
      ]);
      expect(
        harness.calls.map((call) => new Headers(call.init.headers).get("authorization")),
      ).toEqual(["DPoP current-token", "DPoP renewed-token"]);
      expect(harness.calls.map((call) => new Headers(call.init.headers).get("dpop"))).toEqual([
        "proof-1",
        "proof-2",
      ]);
      expect(harness.proofs[1]).toEqual({
        method: "POST",
        url: `${RENEWED_ORIGIN}/api/pull-requests/diff`,
        accessToken: "renewed-token",
      });
      expect(harness.calls[1]!.init.body).toEqual(harness.calls[0]!.init.body);
    }),
  );

  it.effect.each(LOADERS.filter((loader) => loader.path.startsWith("/api/orchestration/")))(
    "renews a rejected credential without losing the v2 protocol or query for $name",
    (loader) =>
      Effect.gen(function* () {
        const harness = makeHarness((requestNumber) =>
          requestNumber === 1 ? credentialRejectedResponse() : Response.json(loader.response),
        );
        const result = yield* loader.load(harness.input).pipe(Effect.provide(harness.httpLayer));
        expect(result).toEqual(loader.expected);
        expect(harness.calls).toHaveLength(2);
        const retried = harness.calls[1]!;
        const url = new URL(retried.url);
        expect(url.origin).toBe(RENEWED_ORIGIN);
        expect(url.pathname).toBe(loader.path);
        expect(new Headers(retried.init.headers).get("authorization")).toBe("DPoP renewed-token");
        expect(new Headers(retried.init.headers).get("dpop")).toBe("proof-2");
        expect(new Headers(retried.init.headers).get(ORCHESTRATION_PROTOCOL_HEADER)).toBe(
          ORCHESTRATION_PROTOCOL_VERSION_TEXT,
        );
        expect(harness.proofs[1]).toEqual({
          method: "GET",
          url: `${RENEWED_ORIGIN}${loader.path}`,
          accessToken: "renewed-token",
        });
        if (loader.name === "older thread history") {
          expect(url.searchParams.get("cursor")).toBe("older-page");
        }
      }),
  );

  it.effect("renews credentials captured by the bounded snapshot loader", () =>
    Effect.gen(function* () {
      const harness = makeHarness((requestNumber) =>
        requestNumber === 1
          ? credentialRejectedResponse()
          : Response.json(encodeBoundedSnapshot(BOUNDED_THREAD)),
      );
      const loaderLayer = boundedThreadSnapshotLoaderLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            harness.httpLayer,
            Layer.succeed(ManagedRelayDpopSigner, Option.getOrThrow(harness.input.signer)),
            Layer.succeed(RemoteEnvironmentAuthorization, harness.remoteAuthorization),
          ),
        ),
      );
      const loader = yield* ThreadSnapshotLoader.pipe(Effect.provide(loaderLayer));
      const result = yield* loader.load(PREPARED, THREAD.projection.thread.id);
      expect(result).toEqual({
        _tag: "present",
        snapshot: { ...THREAD, latestLocalTurnOrdinal: BOUNDED_THREAD.latestLocalTurnOrdinal },
        history: {
          historyCursor: BOUNDED_THREAD.historyCursor,
          hasMoreHistory: true,
          latestLocalTurnOrdinal: BOUNDED_THREAD.latestLocalTurnOrdinal,
        },
      });
      expect(harness.calls).toHaveLength(2);
      expect(new Headers(harness.calls[1]!.init.headers).get("authorization")).toBe(
        "DPoP renewed-token",
      );
    }),
  );

  it.effect("uses the authorization service captured by the diff loader layer", () =>
    Effect.gen(function* () {
      const harness = makeHarness(() => Response.json(DIFF_RESULT));
      const loaderLayer = pullRequestDiffLoaderLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            harness.httpLayer,
            Layer.succeed(ManagedRelayDpopSigner, Option.getOrThrow(harness.input.signer)),
            Layer.succeed(RemoteEnvironmentAuthorization, harness.remoteAuthorization),
          ),
        ),
      );
      const loader = yield* PullRequestDiffLoader.pipe(Effect.provide(loaderLayer));
      const result = yield* loader.load(PREPARED, DIFF);

      expect(result).toEqual(DIFF_RESULT);
      expect(new Headers(harness.calls[0]!.init.headers).get("authorization")).toBe(
        "DPoP current-token",
      );
    }),
  );

  it.effect("preserves the credential rejection after the one recovery attempt fails", () =>
    Effect.gen(function* () {
      const harness = makeHarness(() => credentialRejectedResponse());
      const error = yield* fetchEnvironmentPullRequestDiff({ ...harness.input, diff: DIFF }).pipe(
        Effect.provide(harness.httpLayer),
        Effect.flip,
      );

      expect(error).toMatchObject({
        _tag: "PullRequestDiffCredentialRejectedError",
        traceId: "trace-rejected",
      });
      expect(harness.calls).toHaveLength(2);
      expect(harness.authorizations).toHaveLength(2);
    }),
  );

  it.effect.each([
    {
      name: "insufficient scope",
      reply: () =>
        Response.json(
          {
            _tag: "EnvironmentScopeRequiredError",
            code: "insufficient_scope",
            requiredScope: "orchestration:read",
            traceId: "trace-scope",
          },
          { status: 403 },
        ),
      errorTag: "EnvironmentScopeRequiredError",
    },
    {
      name: "missing credential",
      reply: () => credentialRejectedResponse("missing_credential"),
      errorTag: "EnvironmentAuthInvalidError",
    },
    {
      name: "Cloudflare 530",
      reply: () => new Response("error code: 1033", { status: 530 }),
      errorTag: "RemoteEnvironmentAuthUndeclaredStatusError",
    },
    {
      name: "network failure",
      reply: () => Promise.reject(new Error("Network unreachable")),
      errorTag: "RemoteEnvironmentAuthFetchError",
    },
  ])("does not renew or retry on $name", ({ reply, errorTag }) =>
    Effect.gen(function* () {
      const harness = makeHarness(reply);
      const error = yield* fetchEnvironmentPullRequestDiff({ ...harness.input, diff: DIFF }).pipe(
        Effect.provide(harness.httpLayer),
        Effect.flip,
      );

      expect(error._tag).toBe(errorTag);
      expect(harness.calls).toHaveLength(1);
      expect(harness.authorizations).toEqual([{ expectedEnvironmentId: TARGET.environmentId }]);
    }),
  );

  it.effect("recovers a session's unauthenticated 200 response before checking permissions", () =>
    Effect.gen(function* () {
      const harness = makeHarness((requestNumber) =>
        Response.json(requestNumber === 1 ? UNAUTHENTICATED_SESSION : SESSION),
      );
      const result = yield* fetchEnvironmentSessionState(harness.input).pipe(
        Effect.provide(harness.httpLayer),
      );

      expect(result).toEqual(SESSION);
      expect(harness.authorizations[1]).toEqual({
        expectedEnvironmentId: TARGET.environmentId,
        rejectedAccessToken: "current-token",
      });
      expect(harness.calls).toHaveLength(2);
    }),
  );

  it.effect("reports persistent session rejection instead of showing missing permissions", () =>
    Effect.gen(function* () {
      const harness = makeHarness(() => Response.json(UNAUTHENTICATED_SESSION));
      const error = yield* fetchEnvironmentSessionState(harness.input).pipe(
        Effect.provide(harness.httpLayer),
        Effect.flip,
      );

      expect(error).toMatchObject({
        _tag: "RemoteEnvironmentAuthFetchError",
        message: "The environment rejected the renewed session authorization.",
      });
      expect(harness.calls).toHaveLength(2);
    }),
  );

  it.effect.each([
    { name: "cookie", authorization: null },
    { name: "bearer", authorization: { _tag: "Bearer", token: "bearer-token" } },
  ] satisfies ReadonlyArray<{ name: string; authorization: PreparedHttpAuthorization | null }>)(
    "leaves $name sessions unchanged without relay services",
    ({ authorization }) =>
      Effect.gen(function* () {
        const harness = makeHarness(() => Response.json(UNAUTHENTICATED_SESSION));
        const result = yield* fetchEnvironmentSessionState({
          prepared: { ...PREPARED, httpAuthorization: authorization },
          signer: Option.none(),
        }).pipe(Effect.provide(harness.httpLayer));

        expect(result).toEqual(UNAUTHENTICATED_SESSION);
        expect(harness.calls).toHaveLength(1);
        expect(harness.authorizations).toEqual([]);
        expect(new Headers(harness.calls[0]!.init.headers).get("authorization")).toBe(
          authorization === null ? null : "Bearer bearer-token",
        );
        expect(harness.calls[0]!.init.credentials).toBe(
          authorization === null ? "include" : undefined,
        );
      }),
  );

  it.effect("keeps the caller's timeout while waiting for renewal", () =>
    Effect.gen(function* () {
      const harness = makeHarness(() => Response.json(SESSION));
      const authorizing = yield* Deferred.make<void>();
      const remoteAuthorization = RemoteEnvironmentAuthorization.of({
        ...harness.remoteAuthorization,
        authorizeDpopHttp: () =>
          Deferred.succeed(authorizing, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const pending = yield* fetchEnvironmentSessionState({
        ...harness.input,
        remoteAuthorization: Option.some(remoteAuthorization),
        timeoutMs: 100,
      }).pipe(Effect.provide(harness.httpLayer), Effect.flip, Effect.forkChild);
      yield* Deferred.await(authorizing);
      yield* TestClock.adjust(100);

      expect(yield* Fiber.join(pending)).toMatchObject({
        _tag: "RemoteEnvironmentAuthTimeoutError",
        requestUrl: `${PREPARED.httpBaseUrl}/api/auth/session`,
        timeoutMs: 100,
      });
      expect(harness.calls).toEqual([]);
    }),
  );

  it.effect("reports the current endpoint when the total timeout expires during HTTP", () =>
    Effect.gen(function* () {
      const requested = Promise.withResolvers<void>();
      const response = Promise.withResolvers<Response>();
      const harness = makeHarness(() => {
        requested.resolve();
        return response.promise;
      });
      const authorizing = yield* Deferred.make<void>();
      const authorize = yield* Deferred.make<void>();
      const remoteAuthorization = RemoteEnvironmentAuthorization.of({
        ...harness.remoteAuthorization,
        authorizeDpopHttp: (input) =>
          Deferred.succeed(authorizing, undefined).pipe(
            Effect.andThen(Deferred.await(authorize)),
            Effect.andThen(harness.remoteAuthorization.authorizeDpopHttp(input)),
          ),
      });
      const pending = yield* fetchEnvironmentSessionState({
        ...harness.input,
        remoteAuthorization: Option.some(remoteAuthorization),
        timeoutMs: 100,
      }).pipe(Effect.provide(harness.httpLayer), Effect.flip, Effect.forkChild);
      yield* Deferred.await(authorizing);
      yield* TestClock.adjust(25);
      yield* Deferred.succeed(authorize, undefined);
      yield* Effect.promise(() => requested.promise);
      yield* TestClock.adjust(75);

      expect(yield* Fiber.join(pending)).toMatchObject({
        _tag: "RemoteEnvironmentAuthTimeoutError",
        requestUrl: `${CURRENT_ORIGIN}/api/auth/session`,
        timeoutMs: 100,
      });
      expect(harness.calls.map((call) => call.url)).toEqual([`${CURRENT_ORIGIN}/api/auth/session`]);
      expect(harness.authorizations).toHaveLength(1);
      response.resolve(Response.json(SESSION));
    }),
  );

  it.effect("reports renewal failure without sending the expired prepared token", () =>
    Effect.gen(function* () {
      const harness = makeHarness(() => Response.json(SESSION));
      const failure = new ConnectionTransientError({
        reason: "transport",
        detail: "Relay unavailable",
      });
      const remoteAuthorization = RemoteEnvironmentAuthorization.of({
        ...harness.remoteAuthorization,
        authorizeDpopHttp: () => Effect.fail(failure),
      });
      const error = yield* fetchEnvironmentSessionState({
        ...harness.input,
        remoteAuthorization: Option.some(remoteAuthorization),
      }).pipe(Effect.provide(harness.httpLayer), Effect.flip);

      expect(error).toMatchObject({
        _tag: "RemoteEnvironmentAuthFetchError",
        message: "Could not authorize the environment request.",
        cause: failure,
      });
      expect(harness.calls).toEqual([]);
      expect(harness.proofs).toEqual([]);
    }),
  );

  it.effect("does not fall back to a captured DPoP token when authorization is unavailable", () =>
    Effect.gen(function* () {
      const harness = makeHarness(() => Response.json(SESSION));
      const error = yield* fetchEnvironmentSessionState({
        prepared: PREPARED,
        signer: harness.input.signer,
      }).pipe(Effect.provide(harness.httpLayer), Effect.flip);

      expect(error).toMatchObject({
        _tag: "RemoteEnvironmentAuthFetchError",
        message: "No relay authorization service is available for the environment request.",
      });
      expect(harness.calls).toEqual([]);
    }),
  );
});

describe("orchestration HTTP compatibility header", () => {
  it("announces the current protocol without replacing bearer or DPoP authentication", () => {
    expect(
      withOrchestrationProtocolHeader({
        authorization: "DPoP access-token",
        dpop: "signed-proof",
      }),
    ).toEqual({
      authorization: "DPoP access-token",
      dpop: "signed-proof",
      [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
    });
  });
});
