import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DEFAULT_ORBIT_GATEWAY_URL } from "@t3tools/client-runtime/orbit-gateway";

import * as DesktopIpc from "../DesktopIpc.ts";
import { ORBIT_GATEWAY_SEND_CHANNEL } from "../channels.ts";

// Calls the Orbit Gateway for profile sync and Tasks. It runs in the
// main process because the Gateway refuses requests that carry a page `Origin`, and Chromium's
// network stack trusts the Orbit root CA from the keychain. Root calls use the exact allowlist.

const DEFAULT_TIMEOUT_MS = 15_000;
const CONN_PREFIX = "/api/v1/conn";

const OrbitGatewayRequest = Schema.Struct({
  method: Schema.Literals(["GET", "POST", "PUT", "PATCH"]),
  path: Schema.String.check(Schema.isPattern(/^\/[A-Za-z0-9/_.%-]{0,512}$/)),
  body: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000_000))),
  /** Checked against `CONN_QUERIES`; a path without an entry takes no query. */
  query: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** A longer limit for a call the Gateway answers slowly, such as a clone's create. */
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1_000), Schema.isLessThanOrEqualTo(120_000)),
  ),
  idempotencyKey: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[A-Za-z0-9:._-]{1,128}$/)),
  ),
  /** Conn: a path below `/api/v1`; only the calls in `ROOT_CALLS` go out this way. */
  root: Schema.optional(Schema.Literal(true)),
});

const OrbitGatewayResponse = Schema.Struct({
  error: Schema.NullOr(Schema.String),
  status: Schema.Int,
  body: Schema.String,
});

/** True when a path segment is `.` or `..` (also percent-encoded), or holds an encoded slash. */
export function hasUnsafeSegment(path: string): boolean {
  for (const segment of path.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      return true;
    }
  }
  return false;
}

/**
 * Builds the Gateway URL for a Conn path, or returns null when the path would leave
 * `/api/v1/conn`. The path is resolved by the URL parser first, so `..` segments (also written
 * `%2e%2e`) cannot climb out of the prefix. They are rejected outright, as is an encoded slash.
 */
export function resolveConnUrl(path: string): URL | null {
  if (hasUnsafeSegment(path)) return null;
  let url: URL;
  try {
    url = new URL(`${DEFAULT_ORBIT_GATEWAY_URL}${CONN_PREFIX}${path}`);
  } catch {
    return null;
  }
  const inside = url.pathname === CONN_PREFIX || url.pathname.startsWith(`${CONN_PREFIX}/`);
  return inside && url.origin === new URL(DEFAULT_ORBIT_GATEWAY_URL).origin ? url : null;
}

/**
 * Exact calls outside `/api/v1/conn`: lifecycle reads/wake, the private Tasks summary channel and
 * the Tasks board insights.
 * Only the board insights take a query (`resolveRootUrl`); channel authentication restricts a body.
 */
const ROOT_CALLS: ReadonlyArray<{ readonly method: "GET" | "POST"; readonly pattern: RegExp }> = [
  { method: "POST", pattern: /^\/instances\/[1-9][0-9]{0,15}\/wake$/ },
  { method: "GET", pattern: /^\/operations\/[1-9][0-9]{0,15}$/ },
  { method: "GET", pattern: /^\/realtime$/ },
  { method: "POST", pattern: /^\/broadcasting\/auth$/ },
];

/** The Tasks board's insights: a period, and optionally one Project. */
function isTaskInsightsQuery(query: Readonly<Record<string, string>>): boolean {
  return Object.entries(query).every(([key, value]) =>
    key === "period" ? value === "7d" || value === "30d" : key === "project_id" && isOrbitId(value),
  );
}

/** The Gateway URL of an allowed call below `/api/v1`, or null for anything else. */
export function resolveRootUrl(
  request: Pick<typeof OrbitGatewayRequest.Type, "method" | "path" | "query"> & {
    readonly body?: string | null;
  },
): URL | null {
  if (request.method === "GET" && request.path === "/task-insights") {
    return isTaskInsightsQuery(request.query ?? {})
      ? new URL(`${DEFAULT_ORBIT_GATEWAY_URL}/api/v1/task-insights`)
      : null;
  }
  if (Object.keys(request.query ?? {}).length > 0) return null;
  if (request.path === "/broadcasting/auth") {
    try {
      const body: unknown = JSON.parse(request.body ?? "null");
      if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
      const data = body as Record<string, unknown>;
      if (
        Object.keys(data).length !== 2 ||
        data.channel_name !== "private-orbit" ||
        typeof data.socket_id !== "string" ||
        !/^[0-9]{1,20}\.[0-9]{1,20}$/.test(data.socket_id)
      )
        return null;
    } catch {
      return null;
    }
  }
  const allowed = ROOT_CALLS.some(
    (call) => call.method === request.method && call.pattern.test(request.path),
  );
  return allowed ? new URL(`${DEFAULT_ORBIT_GATEWAY_URL}/api/v1${request.path}`) : null;
}

/** Orbit's Instance name rule allows at most 63 characters; anything longer is no name to check. */
const isNameCheckValue = (value: string) => /^[a-z0-9-]{1,63}$/.test(value);

const isOrbitId = (value: string) => /^[1-9][0-9]{0,15}$/.test(value);

/** A branch search: a bounded, printable substring; Orbit itself answers an invalid ref with 502. */
const ORBIT_BRANCH_QUERY_MAX_LENGTH = 200;
const isBranchQueryValue = (value: string) =>
  value.length >= 1 &&
  value.length <= ORBIT_BRANCH_QUERY_MAX_LENGTH &&
  !/[\u0000-\u001f\u007f]/.test(value);

/**
 * The queries the renderer may send, each kept exact: the method and path, and every key with
 * its value rule. Any other key, or a query on another path, is refused.
 */
const CONN_QUERIES: ReadonlyArray<{
  readonly method: "GET";
  readonly pattern: RegExp;
  readonly query: Readonly<Record<string, (value: string) => boolean>>;
  /** Any subset of the keys may be sent, instead of all of them. */
  readonly optional?: true;
}> = [
  // The palette's Project list, with the Projects in which threads cannot start yet.
  { method: "GET", pattern: /^\/projects$/, query: { include_unavailable: (v) => v === "1" } },
  // The Instance step's live name check.
  {
    method: "GET",
    pattern: /^\/projects\/[1-9][0-9]{0,15}\/instances\/check$/,
    query: { name: isNameCheckValue },
  },
  // The branch control's search.
  {
    method: "GET",
    pattern: /^\/projects\/[1-9][0-9]{0,15}\/branches$/,
    query: { query: isBranchQueryValue },
  },
  // The Tasks panel's list: optional filters and paging.
  {
    method: "GET",
    pattern: /^\/tasks$/,
    query: {
      project: isOrbitId,
      instance: isOrbitId,
      status: (v) => /^[a-z_]{1,32}$/.test(v),
      limit: (v) => /^[1-9][0-9]?$|^100$/.test(v),
      cursor: isOrbitId,
    },
    optional: true,
  },
];

/** Whether the request's query may go to the Gateway; no query always may. */
export function isAllowedConnQuery(
  request: Pick<typeof OrbitGatewayRequest.Type, "method" | "path" | "query">,
): boolean {
  const keys = Object.keys(request.query ?? {});
  if (keys.length === 0) return true;
  const spec = CONN_QUERIES.find(
    (entry) => entry.method === request.method && entry.pattern.test(request.path),
  );
  if (spec === undefined) return false;
  const wanted = Object.keys(spec.query);
  if (!keys.every((key) => wanted.includes(key))) return false;
  if (spec.optional !== true && keys.length !== wanted.length) return false;
  return keys.every((key) => spec.query[key]!(request.query![key]!));
}

async function send(
  request: typeof OrbitGatewayRequest.Type,
): Promise<typeof OrbitGatewayResponse.Type> {
  const url = request.root === true ? resolveRootUrl(request) : resolveConnUrl(request.path);
  if (url === null) {
    return { error: "That Gateway path is not allowed.", status: 0, body: "" };
  }
  if (request.root !== true && !isAllowedConnQuery(request)) {
    return { error: "That Gateway query is not allowed.", status: 0, body: "" };
  }
  for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value);
  try {
    const response = await Electron.net.fetch(url.toString(), {
      method: request.method,
      headers: {
        Accept: "application/json",
        ...(request.body === null ? {} : { "Content-Type": "application/json" }),
        ...(request.idempotencyKey === undefined
          ? {}
          : { "Idempotency-Key": request.idempotencyKey }),
      },
      body: request.body,
      signal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      bypassCustomProtocolHandlers: true,
    });
    return { error: null, status: response.status, body: await response.text() };
  } catch (error) {
    return {
      error:
        error instanceof Error && error.name === "TimeoutError"
          ? "The Orbit Gateway did not answer in time."
          : error instanceof Error
            ? error.message
            : String(error),
      status: 0,
      body: "",
    };
  }
}

export const orbitGatewaySend = DesktopIpc.makeIpcMethod({
  channel: ORBIT_GATEWAY_SEND_CHANNEL,
  payload: OrbitGatewayRequest,
  result: OrbitGatewayResponse,
  handler: Effect.fn("desktop.ipc.orbitGateway.send")(function* (request) {
    return yield* Effect.promise(() => send(request));
  }),
});
