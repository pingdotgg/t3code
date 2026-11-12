import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ProjectId,
  ThreadId,
  type AuthSessionState,
  type OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ThreadBoundedSnapshot,
  OrchestrationV2ThreadTranscript,
  type OrchestrationV2ThreadHistoryPage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import type { HttpClient } from "effect/http";

import { ConnectionDiagnostics, makeConnectionDiagnostics } from "../connection/diagnostics.ts";
import {
  BearerConnectionTarget,
  type PreparedConnection,
  type PreparedHttpAuthorization,
} from "../connection/model.ts";
import { type RemoteEnvironmentRequestError } from "../rpc/http.ts";
import * as RpcHttp from "../rpc/http.ts";
import * as PullRequestDiffLoader from "./pullRequestDiffHttp.ts";
import { fetchEnvironmentSessionState } from "./session.ts";
import { fetchEnvironmentShellSnapshot } from "./shellSnapshotHttp.ts";
import { fetchEnvironmentThreadTranscript } from "./threadTranscriptHttp.ts";
import { fetchEnvironmentBoundedThreadSnapshot } from "./boundedThreadSnapshotHttp.ts";
import { fetchEnvironmentThreadHistoryPage } from "./threadHistoryHttp.ts";
import { v2Projection } from "./orchestrationV2TestFixtures.ts";

const encodeBoundedSnapshot = Schema.encodeSync(OrchestrationV2ThreadBoundedSnapshot);
const encodeThreadTranscript = Schema.encodeSync(OrchestrationV2ThreadTranscript);

const TARGET = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Remote environment",
  connectionId: "remote",
});
const CURRENT_ORIGIN = "https://current.example.test";
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: CURRENT_ORIGIN,
  socketUrl: "wss://current.example.test/ws",
  httpAuthorization: { _tag: "Bearer", token: "bearer-token" },
  target: TARGET,
};
const DIFF = {
  projectId: ProjectId.make("project-1"),
  repository: "owner/repository",
  number: 42,
};
const DIFF_RESULT = { patch: "diff --git a/file.ts b/file.ts", truncated: false, nextCursor: null };
const AUTH = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["bearer-access-token"],
  sessionCookieName: "t3_session",
} satisfies AuthSessionState["auth"];
const SESSION = {
  authenticated: true,
  auth: AUTH,
  scopes: ["orchestration:read", "orchestration:operate"],
  sessionMethod: "bearer-access-token",
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
const TRANSCRIPT = {
  threadId: v2Projection.thread.id,
  title: v2Projection.thread.title,
  updatedAt: v2Projection.updatedAt,
  items: v2Projection.visibleTurnItems,
} satisfies OrchestrationV2ThreadTranscript;
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
  const fetchFn: typeof fetch = async (request, init) => {
    calls.push({ url: String(request), init: init ?? {} });
    return reply(calls.length);
  };
  return {
    calls,
    input: { prepared: PREPARED },
    httpLayer: RpcHttp.layerRemoteHttpClient(fetchFn),
  };
}

// Resolves "settled" instead of hanging when the load finishes without sending another request.
function nextRequestOrSettled(requests: Queue.Queue<number>, load: Fiber.Fiber<unknown, unknown>) {
  return Effect.raceFirst(
    Queue.take(requests).pipe(Effect.as("sent" as const)),
    Fiber.await(load).pipe(Effect.as("settled" as const)),
  );
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
    RemoteEnvironmentRequestError | PullRequestDiffLoader.PullRequestDiffCredentialRejectedError,
    HttpClient.HttpClient
  >;
}> = [
  {
    name: "PR diff",
    method: "POST",
    path: "/api/pull-requests/diff",
    response: DIFF_RESULT,
    expected: DIFF_RESULT,
    load: (input: HttpInput) =>
      PullRequestDiffLoader.fetchEnvironmentPullRequestDiff({ ...input, diff: DIFF }),
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
    load: (input: HttpInput) =>
      fetchEnvironmentShellSnapshot(input).pipe(
        Effect.map(({ loadPullRequests: _links, ...snapshot }) => snapshot),
      ),
  },
  {
    name: "thread transcript",
    method: "GET",
    path: `/api/orchestration/threads/${TRANSCRIPT.threadId}/transcript`,
    response: encodeThreadTranscript(TRANSCRIPT),
    expected: TRANSCRIPT,
    load: (input: HttpInput) =>
      fetchEnvironmentThreadTranscript({ ...input, threadId: TRANSCRIPT.threadId }),
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
  it.effect.each(LOADERS)("rejects an invalid $name response", (loader) =>
    Effect.gen(function* () {
      const diagnostics = makeConnectionDiagnostics();
      const harness = makeHarness(() => Response.json({}));
      const result = yield* loader
        .load(harness.input)
        .pipe(
          Effect.provide(harness.httpLayer),
          Effect.provideService(ConnectionDiagnostics, diagnostics),
          Effect.asVoid,
          Effect.flip,
        );
      expect(result._tag).toBe("RemoteEnvironmentAuthInvalidJsonError");
      if (loader.name === "shell snapshot")
        expect(diagnostics.snapshot()).toMatchObject({
          milestones: ["shell-headers", "shell-body"],
          firstFailure: "shell-schema",
        });
      expect(harness.calls).toHaveLength(1);
    }),
  );

  it.effect("keeps the status of a shell snapshot error that is not a declared error", () =>
    Effect.gen(function* () {
      const harness = makeHarness(() => Response.json({ error: "bad_gateway" }, { status: 502 }));
      const error = yield* fetchEnvironmentShellSnapshot(harness.input).pipe(
        Effect.provide(harness.httpLayer),
        Effect.flip,
      );
      expect(error).toMatchObject({
        _tag: "RemoteEnvironmentAuthUndeclaredStatusError",
        status: 502,
      });
    }),
  );

  it.effect.each(LOADERS)("sends the bearer token to the prepared endpoint for $name", (loader) =>
    Effect.gen(function* () {
      const diagnostics = makeConnectionDiagnostics();
      const harness = makeHarness(() => Response.json(loader.response));
      const result = yield* loader
        .load(harness.input)
        .pipe(
          Effect.provide(harness.httpLayer),
          Effect.provideService(ConnectionDiagnostics, diagnostics),
        );
      if (loader.name === "shell snapshot")
        expect(diagnostics.snapshot()).toEqual({
          milestones: ["shell-headers", "shell-body", "shell-decoded"],
          rx: 0,
          tx: 0,
          closes: 0,
          errors: 0,
          binary: 0,
        });

      expect(result).toEqual(loader.expected);
      expect(harness.calls).toHaveLength(1);
      const call = harness.calls[0]!;
      const url = new URL(call.url);
      expect(url.origin).toBe(CURRENT_ORIGIN);
      expect(url.pathname).toBe(loader.path);
      expect(call.init.method).toBe(loader.method);
      expect(new Headers(call.init.headers).get("authorization")).toBe("Bearer bearer-token");
      expect(call.init.credentials).toBe("omit");
      if (loader.path.startsWith("/api/orchestration/")) {
        expect(new Headers(call.init.headers).get(ORCHESTRATION_PROTOCOL_HEADER)).toBe(
          ORCHESTRATION_PROTOCOL_VERSION_TEXT,
        );
      }
      if (loader.name === "older thread history") {
        expect(url.searchParams.get("cursor")).toBe("older-page");
      }
    }),
  );

  // MCP-created thread ids contain ":", which the request path percent-encodes.
  const MCP_THREAD_ID = ThreadId.make("mcp:3534bc83-1c17-4a1e-9118-601c2766d355");
  const MCP_THREAD_LOADERS: ReadonlyArray<
    Pick<(typeof LOADERS)[number], "name" | "response" | "load">
  > = [
    {
      name: "thread transcript",
      response: encodeThreadTranscript(TRANSCRIPT),
      load: (input: HttpInput) =>
        fetchEnvironmentThreadTranscript({ ...input, threadId: MCP_THREAD_ID }),
    },
    {
      name: "bounded thread snapshot",
      response: encodeBoundedSnapshot(BOUNDED_THREAD),
      load: (input: HttpInput) =>
        fetchEnvironmentBoundedThreadSnapshot({ ...input, threadId: MCP_THREAD_ID }),
    },
    {
      name: "older thread history",
      response: THREAD_HISTORY,
      load: (input: HttpInput) =>
        fetchEnvironmentThreadHistoryPage({
          ...input,
          threadId: MCP_THREAD_ID,
          cursor: "older-page",
        }),
    },
  ];
  it.effect.each(MCP_THREAD_LOADERS)(
    "encodes the path for a $name of a thread id that needs encoding",
    (loader) =>
      Effect.gen(function* () {
        const harness = makeHarness(() => Response.json(loader.response));
        yield* loader.load(harness.input).pipe(Effect.provide(harness.httpLayer));

        expect(new URL(harness.calls[0]!.url).pathname).toContain("/mcp%3A3534bc83-");
      }),
  );

  it.effect("keeps a learned direct origin and marks the token request as direct", () =>
    Effect.gen(function* () {
      const loader = LOADERS[0]!;
      const harness = makeHarness(() => Response.json(loader.response));
      const direct = new BearerConnectionTarget({
        environmentId: TARGET.environmentId,
        label: TARGET.label,
        connectionId: "tailnet",
      });
      yield* loader
        .load({
          ...harness.input,
          prepared: { ...PREPARED, httpBaseUrl: "http://100.64.0.10:3773", target: direct },
        })
        .pipe(Effect.provide(harness.httpLayer));

      expect(new URL(harness.calls[0]!.url).origin).toBe("http://100.64.0.10:3773");
      expect(new Headers(harness.calls[0]!.init.headers).get("authorization")).toBe(
        "Bearer bearer-token",
      );
    }),
  );

  it.effect("reports a rejected diff credential without retrying", () =>
    Effect.gen(function* () {
      const harness = makeHarness(() => credentialRejectedResponse());
      const error = yield* PullRequestDiffLoader.fetchEnvironmentPullRequestDiff({
        ...harness.input,
        diff: DIFF,
      }).pipe(Effect.provide(harness.httpLayer), Effect.flip);

      expect(error).toMatchObject({
        _tag: "PullRequestDiffCredentialRejectedError",
        traceId: "trace-rejected",
      });
      expect(harness.calls).toHaveLength(1);
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
  ])("does not retry on $name", ({ reply, errorTag }) =>
    Effect.gen(function* () {
      const harness = makeHarness(reply);
      const error = yield* PullRequestDiffLoader.fetchEnvironmentPullRequestDiff({
        ...harness.input,
        diff: DIFF,
      }).pipe(Effect.provide(harness.httpLayer), Effect.flip);

      expect(error._tag).toBe(errorTag);
      expect(harness.calls).toHaveLength(1);
    }),
  );

  it.effect(
    "waits longer for session permissions after the environment is too slow to answer",
    () =>
      Effect.gen(function* () {
        const requests = yield* Queue.unbounded<number>();
        let answer: () => void = () => {};
        const answered = new Promise<void>((resolve) => {
          answer = resolve;
        });
        const harness = makeHarness((requestNumber) => {
          Queue.offerUnsafe(requests, requestNumber);
          return requestNumber === 1
            ? new Promise<Response>(() => {})
            : answered.then(() => Response.json(SESSION));
        });
        const load = yield* fetchEnvironmentSessionState({
          prepared: PREPARED,
          timeoutMs: 1_000,
        }).pipe(Effect.provide(harness.httpLayer), Effect.forkChild({ startImmediately: true }));

        yield* Queue.take(requests);
        yield* TestClock.adjust("1 second");
        expect(yield* nextRequestOrSettled(requests, load)).toBe("sent");
        yield* TestClock.adjust("1500 millis");
        answer();

        expect(yield* Fiber.await(load)).toStrictEqual(Exit.succeed(SESSION));
        expect(harness.calls).toHaveLength(2);
      }),
  );

  it.effect("gives up on session permissions once a 60 second wait also times out", () =>
    Effect.gen(function* () {
      const requests = yield* Queue.unbounded<number>();
      const harness = makeHarness((requestNumber) => {
        Queue.offerUnsafe(requests, requestNumber);
        return new Promise<Response>(() => {});
      });
      const load = yield* fetchEnvironmentSessionState({
        prepared: PREPARED,
        timeoutMs: 15_000,
      }).pipe(Effect.provide(harness.httpLayer), Effect.forkChild({ startImmediately: true }));

      yield* Queue.take(requests);
      yield* TestClock.adjust("15 seconds");
      expect(yield* nextRequestOrSettled(requests, load)).toBe("sent");
      yield* TestClock.adjust("30 seconds");
      expect(yield* nextRequestOrSettled(requests, load)).toBe("sent");
      yield* TestClock.adjust("60 seconds");
      const exit = yield* Fiber.await(load);

      expect(exit).toMatchObject({
        _tag: "Failure",
        cause: {
          reasons: [{ error: { _tag: "RemoteEnvironmentAuthTimeoutError", timeoutMs: 60_000 } }],
        },
      });
      expect(harness.calls).toHaveLength(3);
    }),
  );

  it.effect.each([
    { name: "cookie", authorization: null },
    { name: "bearer", authorization: { _tag: "Bearer", token: "bearer-token" } },
  ] satisfies ReadonlyArray<{ name: string; authorization: PreparedHttpAuthorization | null }>)(
    "leaves $name sessions unchanged",
    ({ authorization }) =>
      Effect.gen(function* () {
        const harness = makeHarness(() => Response.json(UNAUTHENTICATED_SESSION));
        const result = yield* fetchEnvironmentSessionState({
          prepared: { ...PREPARED, httpAuthorization: authorization },
        }).pipe(Effect.provide(harness.httpLayer));

        expect(result).toEqual(UNAUTHENTICATED_SESSION);
        expect(harness.calls).toHaveLength(1);
        expect(new Headers(harness.calls[0]!.init.headers).get("authorization")).toBe(
          authorization === null ? null : "Bearer bearer-token",
        );
        expect(harness.calls[0]!.init.credentials).toBe(
          authorization === null ? "include" : "omit",
        );
      }),
  );
});
