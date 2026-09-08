import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { HttpEffect } from "../Http.ts";
import {
  PRIVATE_HOST_SUFFIX,
  RPC_ERROR_TAG,
  RPC_PATH_PREFIX,
  RPC_TOKEN_ENV,
  RPC_TOKEN_HEADER,
} from "./rpc-token.ts";

const header = (
  headers: Record<string, string | undefined>,
  name: string,
): string => headers[name] ?? headers[name.toLowerCase()] ?? "";

const hostnameOf = (host: string): string => {
  const trimmed = host.trim();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? trimmed : trimmed.slice(1, end);
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon > 0 && trimmed.includes(".")) return trimmed.slice(0, colon);
  return trimmed;
};

const isPrivateMesh = (host: string): boolean =>
  hostnameOf(host).endsWith(PRIVATE_HOST_SUFFIX);

const tokensEqual = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i++) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return mismatch === 0;
};

const unauthorized = HttpServerResponse.text("Unauthorized", { status: 401 });

/**
 * Serve schemaless RPC only on the private mesh, and only with the
 * host's {@link RPC_TOKEN_ENV}. Public `*.up.railway.app` requests to
 * `/__rpc__/*` get 401 even if they guess the path or the token.
 *
 * Implemented here (not `alchemy/Rpc.serveRpc`) so canvas Functions stay
 * under the 96KB start-command cap. Value methods only — no streams.
 *
 * Importing this module registers the Function-runtime hook. Tagged
 * Functions that host RPC methods must import it (or `bindFunction`,
 * which re-exports this module).
 */
export const serveRailwayRpc = <Req = never>(
  shape: Record<string, unknown>,
  fallback: HttpEffect<Req>,
): HttpEffect<Req> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const prefixAt = request.url.indexOf(RPC_PATH_PREFIX);
    if (prefixAt === -1) {
      return yield* fallback;
    }

    const headers = request.headers as Record<string, string | undefined>;
    const hostHeader = header(headers, "host");
    const host =
      hostHeader.length > 0
        ? hostHeader
        : yield* Effect.sync(() => {
            try {
              return new URL(request.url).host;
            } catch {
              return "";
            }
          });
    const forwarded = header(headers, "x-forwarded-host");
    const expected = yield* Effect.sync(() => process.env[RPC_TOKEN_ENV] ?? "");
    const provided = header(headers, RPC_TOKEN_HEADER);
    if (
      !isPrivateMesh(host) ||
      (forwarded.length > 0 && !isPrivateMesh(forwarded)) ||
      expected.length === 0 ||
      provided.length === 0 ||
      !tokensEqual(provided, expected)
    ) {
      return unauthorized;
    }

    let name = request.url.slice(prefixAt + RPC_PATH_PREFIX.length);
    const queryAt = name.indexOf("?");
    if (queryAt !== -1) name = name.slice(0, queryAt);
    name = decodeURIComponent(name);

    const method = shape[name];
    if (typeof method !== "function") {
      return HttpServerResponse.text(`Unknown RPC method "${name}"`, {
        status: 404,
      });
    }

    const text = yield* request.text;
    let args: unknown[] = [];
    if (text.length > 0) {
      try {
        args = JSON.parse(text) as unknown[];
      } catch {
        return HttpServerResponse.text(`Invalid RPC arguments for "${name}"`, {
          status: 400,
        });
      }
    }

    const invoked = (method as (...a: unknown[]) => unknown)(...args);
    if (!Effect.isEffect(invoked)) {
      return yield* HttpServerResponse.json(invoked ?? null);
    }
    const result = yield* Effect.result(
      invoked as Effect.Effect<unknown, unknown>,
    );
    if (Result.isSuccess(result)) {
      return yield* HttpServerResponse.json(result.success ?? null);
    }
    return yield* HttpServerResponse.json({
      _tag: RPC_ERROR_TAG,
      error: result.failure,
    });
  });

/** Register private-mesh RPC on this Function/Service isolate. */
export const enableRailwayRpc = (): void => {
  (globalThis as any).__R = serveRailwayRpc;
};
