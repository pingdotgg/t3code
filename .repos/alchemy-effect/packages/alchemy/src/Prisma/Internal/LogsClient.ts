import type { ConfigError } from "@distilled.cloud/core/errors";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { PrismaApiError } from "../Client.ts";
import { Credentials } from "../Credentials.ts";
import type {
  BuildLogsQuery,
  BuildLogsRequest,
  DeploymentLogsQuery,
  DeploymentLogsRequest,
} from "../Types.ts";

/**
 * Hand-written request builders for the Management API's log streams. The
 * deployment stream is a WebSocket and the build stream is NDJSON-over-HTTP;
 * neither fits distilled's request/response operations, so these stay in
 * alchemy.
 *
 * They read the token and base URL from the distilled {@link Credentials}
 * service — the same service every migrated operation authenticates with —
 * rather than from `PrismaEnvironment`. `Credentials` holds an *effect*, so a
 * stack layer can carry it without resolving credentials at build time;
 * `PrismaEnvironment` is a resolved value and therefore cannot appear in
 * `providers()`' output (see the lazy-auth note on `stackManagementApiLayer`).
 */

const INVALID_PATH_SEGMENT = "__alchemy_invalid_prisma_path_segment__";

const pathSegment = (value: string): string => {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value === INVALID_PATH_SEGMENT ||
    /[\\/?#%]/.test(value) ||
    value.includes("\0")
  ) {
    return INVALID_PATH_SEGMENT;
  }
  try {
    return encodeURIComponent(value);
  } catch {
    return INVALID_PATH_SEGMENT;
  }
};

const isValidApiPath = (baseUrl: string, path: string): boolean => {
  if (
    (path !== "/v1" && !path.startsWith("/v1/")) ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#") ||
    path.includes(INVALID_PATH_SEGMENT)
  ) {
    return false;
  }
  try {
    const base = new URL(baseUrl);
    const resolved = new URL(path, base);
    return (
      resolved.origin === base.origin &&
      (resolved.pathname === "/v1" || resolved.pathname.startsWith("/v1/"))
    );
  } catch {
    return false;
  }
};

const buildUrl = (
  baseUrl: string,
  path: string,
  query?: object,
): Effect.Effect<string, PrismaApiError> => {
  if (!isValidApiPath(baseUrl, path)) {
    return Effect.fail(
      new PrismaApiError({
        method: "GET",
        path,
        status: 0,
        message: "Refused an invalid Prisma Management API path parameter",
      }),
    );
  }
  return Effect.sync(() => {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          url.searchParams.append(key, String(item));
        }
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  });
};

const buildWebSocketUrl = (baseUrl: string, path: string, query?: object) =>
  buildUrl(baseUrl, path, query).pipe(
    Effect.map((value) => {
      const url = new URL(value);
      if (url.protocol === "https:") url.protocol = "wss:";
      if (url.protocol === "http:") url.protocol = "ws:";
      return url.toString();
    }),
  );

const logsQuery = (
  query: DeploymentLogsQuery | undefined,
): Record<string, unknown> | undefined => {
  if (!query) return undefined;
  const { fromStart, ...rest } = query;
  return {
    ...rest,
    from_start: fromStart === undefined ? undefined : String(fromStart),
  };
};

export const getDeploymentLogsRequest = (
  deploymentId: string,
  query?: DeploymentLogsQuery,
): Effect.Effect<
  DeploymentLogsRequest,
  PrismaApiError | ConfigError,
  Credentials
> =>
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const { apiToken, apiBaseUrl } = yield* credentials;
    const url = yield* buildWebSocketUrl(
      apiBaseUrl,
      `/v1/deployments/${pathSegment(deploymentId)}/logs`,
      logsQuery(query),
    );
    return {
      url,
      headers: {
        Authorization: Redacted.make(`Bearer ${Redacted.value(apiToken)}`),
      },
    };
  });

export const getBuildLogsRequest = (
  buildId: string,
  query?: BuildLogsQuery,
): Effect.Effect<BuildLogsRequest, PrismaApiError | ConfigError, Credentials> =>
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const { apiToken, apiBaseUrl } = yield* credentials;
    const url = yield* buildUrl(
      apiBaseUrl,
      `/v1/builds/${pathSegment(buildId)}/logs`,
      query,
    );
    return {
      url,
      headers: {
        Authorization: Redacted.make(`Bearer ${Redacted.value(apiToken)}`),
        Accept: "application/x-ndjson",
      },
    };
  });
