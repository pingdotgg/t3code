import { PrismaApiError } from "@/Prisma/Client";
import { Credentials, fromApiToken } from "@distilled.cloud/prisma";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

/**
 * An in-memory Prisma Management API served over a fake `HttpClient`.
 *
 * This is `test/Prisma/Client.test.ts`'s harness (its `Captured` log,
 * `HttpClient.make` stub, `HttpBody` decoding, and `json`/`data`/`page`
 * helpers) lifted into a fixture so provider suites can share it. The only
 * change is that the `fixtureResponse` if-chain is supplied by the caller
 * instead of being hard-coded, which lets each suite declare exactly the
 * routes the resources under test call — resource files migrate to distilled
 * ops one dispatch at a time, so route coverage grows with them.
 *
 * The provider tests used to inject a fake `PrismaManagementClient`. Resource
 * files calling generated distilled operations bypass that seam, so the fake
 * moves one layer down and speaks the wire instead. Tests therefore exercise
 * distilled's schema decoding and its status-to-tag matching, which the
 * client-level fake never touched.
 */

export const FAKE_API_BASE_URL = "https://api.prisma.test";

/** Shape of a captured request, as in `Client.test.ts`. */
export interface Captured {
  readonly url: string;
  readonly method: string;
  readonly pathname: string;
  readonly search: string;
  readonly authorization: string | undefined;
  readonly bodyJson: unknown;
}

export const json = (value: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

/** `{ data }` — the Management API's single-resource envelope. */
export const data = <T>(value: T, init?: ResponseInit) =>
  json({ data: value }, init);

/** `{ data, pagination }` — the Management API's list envelope. */
export const page = <T>(
  items: ReadonlyArray<T>,
  hasMore = false,
  nextCursor: string | null = null,
) => json({ data: items, pagination: { hasMore, nextCursor } });

/** `204 No Content` — the Management API's delete responses. */
export const noContent = () => new Response(null, { status: 204 });

/** `{ error: { code, message } }` with a real status code. */
export const failure = (
  status: number,
  code: string,
  message: string,
  hint?: string,
) =>
  json(
    { error: hint === undefined ? { code, message } : { code, message, hint } },
    { status },
  );

export const notFound = (message = "Not found") =>
  failure(404, "not_found", message);

export const conflict = (message = "Already exists") =>
  failure(409, "already_exists", message);

export const badRequest = (message = "Invalid request") =>
  failure(400, "bad_request", message);

export interface FakeManagementApi {
  /** Fake transport plus the credentials the generated operations resolve. */
  readonly layer: Layer.Layer<HttpClient.HttpClient | Credentials>;
  /** Every request the fake served, in order. */
  readonly captured: Captured[];
}

/**
 * Build the fake from a `fixtureResponse`-style function: match on
 * `request.method` / `request.pathname` and return a `Response`, exactly as
 * `Client.test.ts` does. An unmatched request should return a failing status
 * so the test fails loudly rather than proceeding on something plausible.
 */
export const makeFakeManagementApi = (
  fixtureResponse: (request: Captured) => Response,
): FakeManagementApi => {
  const captured: Captured[] = [];

  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      const body = request.body as HttpBody.HttpBody;
      const bodyText =
        body._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : "";
      const entry: Captured = {
        url: request.url,
        method: request.method,
        pathname: url.pathname,
        search: url.search,
        authorization: request.headers.authorization,
        bodyJson: bodyText ? JSON.parse(bodyText) : undefined,
      };
      captured.push(entry);
      return HttpClientResponse.fromWeb(request, fixtureResponse(entry));
    }),
  );

  return {
    layer: Layer.mergeAll(
      Layer.succeed(HttpClient.HttpClient, client),
      fromApiToken({
        apiToken: "fake-service-token",
        apiBaseUrl: FAKE_API_BASE_URL,
      }),
    ),
    captured,
  };
};

/**
 * The catch-all arm of a suite's `fixtureResponse`, as in `Client.test.ts`.
 *
 * Deliberately a 400: an unregistered route is a harness bug and must fail
 * the test immediately. A 5xx would be a transient category, so the retry
 * policy would replay it eight times before surfacing anything.
 */
export const unhandled = (request: Captured) =>
  json(
    {
      error: {
        code: "unhandled",
        message: `Unhandled fixture request ${request.method} ${request.pathname}${request.search}`,
      },
    },
    { status: 400 },
  );

/** `METHOD /path` for every request served, for call-order assertions. */
export const routesOf = (captured: ReadonlyArray<Captured>) =>
  captured.map((request) => `${request.method} ${request.pathname}`);

/**
 * Adapter plumbing for suites whose route table is still expressed as
 * client-shaped handlers.
 *
 * Those suites declare a plain object of synchronous `Effect` handlers and
 * map them onto the wire. Every suite used to carry its own copy of this
 * dispatch code, which drifted; it lives here instead, so all of them agree
 * on how a handler's result becomes a response and on what a missing handler
 * does.
 */

/** Run a synchronous fixture handler and capture its success or failure. */
export const runHandler = (effect: Effect.Effect<any, any>) =>
  Effect.runSync(Effect.result(effect));

/**
 * Injected `PrismaApiError`s keep their real status; anything else becomes a
 * 400 — never a 5xx, whose transient category the retry policy would replay.
 */
const errorResponse = (error: unknown): Response =>
  error instanceof PrismaApiError
    ? failure(error.status, "error", error.message)
    : failure(400, "error", String(error));

/** A handler's result on the wire; `undefined` reads as a 404. */
export const asResponse = (
  outcome: ReturnType<typeof runHandler>,
  wrap: (value: unknown) => Response,
): Response =>
  Result.isFailure(outcome)
    ? errorResponse(outcome.failure)
    : outcome.success === undefined
      ? notFound("not found")
      : wrap(outcome.success);

/** A delete handler's result on the wire: `204`, or the injected failure. */
export const voidResponse = (
  outcome: ReturnType<typeof runHandler>,
): Response =>
  Result.isFailure(outcome) ? errorResponse(outcome.failure) : noContent();

export interface HandlerDispatch {
  /** Call a handler and envelope its value; a missing handler is `unhandled`. */
  readonly call: (
    handler: unknown,
    args: ReadonlyArray<unknown>,
    wrap?: (value: unknown) => Response,
  ) => Response;
  /** Same, for the delete routes that answer `204`. */
  readonly callVoid: (
    handler: unknown,
    args: ReadonlyArray<unknown>,
  ) => Response;
  /** The `{ data, pagination }` wrap for list routes. */
  readonly list: (value: unknown) => Response;
}

/**
 * Bind the dispatch helpers to one captured request. Every verb — DELETE
 * included — routes through here, so a route whose handler the suite never
 * stubbed returns the diagnosable `unhandled` 400 instead of throwing.
 */
export const dispatchTo = (request: Captured): HandlerDispatch => ({
  call: (handler, args, wrap = (value) => data(value)) =>
    typeof handler === "function"
      ? asResponse(runHandler((handler as any)(...args)), wrap)
      : unhandled(request),
  callVoid: (handler, args) =>
    typeof handler === "function"
      ? voidResponse(runHandler((handler as any)(...args)))
      : unhandled(request),
  list: (value) => page(value as unknown[]),
});

/**
 * Wire-shaped payload builders.
 *
 * Distilled decodes every response against the generated schema, so a fake
 * payload has to carry the fields the API really returns — including the
 * deprecated ones the create routes still send (`apiKeys`,
 * `connectionString`, `directConnection`). These builders supply that
 * skeleton so suites only state what the assertion cares about.
 */

const REF_BASE = `${FAKE_API_BASE_URL}/v1`;

const ref = (collection: string, id: string, name: string) => ({
  id,
  url: `${REF_BASE}/${collection}/${id}`,
  name,
});

export const WIRE_CREATED_AT = "2024-01-01T00:00:00.000Z";

export interface WireProjectOptions {
  readonly id?: string;
  readonly name?: string;
  readonly logicalId?: string | null;
  readonly defaultRegion?: string | null;
  readonly workspaceId?: string;
  readonly createdAt?: string;
}

export const wireProject = (options: WireProjectOptions = {}) => {
  const id = options.id ?? "project-1";
  return {
    id,
    type: "project",
    url: `${REF_BASE}/projects/${id}`,
    name: options.name ?? "app",
    logicalId: options.logicalId ?? null,
    createdAt: options.createdAt ?? WIRE_CREATED_AT,
    defaultRegion:
      options.defaultRegion === undefined ? "us-east-1" : options.defaultRegion,
    workspace: ref("workspaces", options.workspaceId ?? "workspace-1", "team"),
  };
};

export interface WireConnectionOptions {
  readonly id?: string;
  readonly name?: string;
  readonly databaseId?: string;
  readonly databaseName?: string;
  readonly directConnectionString?: string;
  readonly pooledConnectionString?: string;
}

export const wireConnection = (options: WireConnectionOptions = {}) => {
  const id = options.id ?? "connection-1";
  return {
    id,
    type: "connection",
    url: `${REF_BASE}/connections/${id}`,
    name: options.name ?? "default",
    createdAt: WIRE_CREATED_AT,
    kind: "postgres",
    endpoints: {
      direct: {
        host: "db.prisma.test",
        port: 5432,
        ...(options.directConnectionString === undefined
          ? {}
          : { connectionString: options.directConnectionString }),
      },
      ...(options.pooledConnectionString === undefined
        ? {}
        : {
            pooled: {
              host: "pool.prisma.test",
              port: 5432,
              connectionString: options.pooledConnectionString,
            },
          }),
    },
    database: ref(
      "databases",
      options.databaseId ?? "database-1",
      options.databaseName ?? "main",
    ),
  };
};

export interface WireDatabaseOptions {
  readonly id?: string;
  readonly name?: string;
  readonly status?: "failure" | "provisioning" | "ready" | "recovering";
  readonly isDefault?: boolean;
  readonly defaultConnectionId?: string | null;
  readonly connections?: ReadonlyArray<ReturnType<typeof wireConnection>>;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly regionId?: string | null;
  readonly branchId?: string | null;
}

export const wireDatabase = (options: WireDatabaseOptions = {}) => {
  const id = options.id ?? "database-1";
  const regionId =
    options.regionId === undefined ? "us-east-1" : options.regionId;
  return {
    id,
    type: "database",
    url: `${REF_BASE}/databases/${id}`,
    name: options.name ?? "main",
    status: options.status ?? "ready",
    createdAt: WIRE_CREATED_AT,
    isDefault: options.isDefault ?? false,
    defaultConnectionId: options.defaultConnectionId ?? null,
    connections: options.connections ?? [],
    project: ref(
      "projects",
      options.projectId ?? "project-1",
      options.projectName ?? "app",
    ),
    region: regionId === null ? null : { id: regionId, name: regionId },
    source: { type: "empty" },
    branchId: options.branchId ?? null,
  };
};

/**
 * The create/restore routes additionally return the deprecated top-level
 * credential fields; distilled's schema requires them.
 */
export const wireCreatedDatabase = (options: WireDatabaseOptions = {}) => ({
  ...wireDatabase(options),
  apiKeys: [],
  connectionString: "postgres://direct",
  directConnection: {
    host: "db.prisma.test",
    user: "prisma",
    pass: "secret",
  },
});
