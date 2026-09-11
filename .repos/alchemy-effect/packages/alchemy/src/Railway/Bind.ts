import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { Rpc } from "../Rpc.ts";
import { unpackEnvValue } from "../RuntimeContext.ts";
import { isYieldableEffectLike } from "../Util/effect.ts";
import { isRailwayHost } from "./MountVolume.ts";
import {
  DEFAULT_RPC_PORT,
  RPC_ERROR_TAG,
  RPC_PATH_PREFIX,
  RPC_TOKEN_HEADER,
  rpcEnvKeys,
} from "./rpc-token.ts";

export class RpcCallError extends Data.TaggedError("Railway.RpcCallError")<{
  readonly method: string;
  readonly cause: unknown;
}> {}

export class RpcUnauthorized extends Data.TaggedError(
  "Railway.RpcUnauthorized",
)<{
  readonly method: string;
}> {}

const fromProcessEnv = (key: string): string => {
  const unpacked = unpackEnvValue<unknown>(process.env[key]);
  if (typeof unpacked === "string") return unpacked;
  return "";
};

type RpcTarget = {
  readonly Type: string;
  readonly LogicalId: string;
  readonly dnsName?: unknown;
  readonly port?: unknown;
  readonly rpcToken?: unknown;
};

const resolveTarget = <Shape, Req>(
  targetEff:
    | (RpcTarget & Rpc<Shape>)
    | Effect.Effect<RpcTarget & Rpc<Shape>, never, Req>,
): Effect.Effect<RpcTarget & Rpc<Shape>, never, Req> =>
  isYieldableEffectLike(targetEff)
    ? (targetEff as Effect.Effect<RpcTarget & Rpc<Shape>, never, Req>)
    : Effect.succeed(targetEff as RpcTarget & Rpc<Shape>);

/** Logical id without yielding the Resource (runtime has no engine). */
const logicalIdOf = (target: unknown): string => {
  if (target !== null && typeof target === "object" && "LogicalId" in target) {
    const id = (target as { LogicalId?: unknown }).LogicalId;
    if (typeof id === "string" && id.length > 0) return id;
  }
  if (typeof target === "function") {
    const named = (target as { name?: unknown }).name;
    if (typeof named === "string" && named.length > 0) return named;
  }
  return "";
};

const makeStub = <Shape>(options: {
  readonly baseUrl: string;
  readonly token: string;
}): Shape => {
  const { baseUrl, token } = options;
  return new Proxy(
    {},
    {
      get: (_obj, prop) => {
        if (typeof prop !== "string") return undefined;
        return (...args: unknown[]) =>
          Effect.gen(function* () {
            if (!baseUrl || !token) {
              return yield* new RpcCallError({
                method: prop,
                cause: !baseUrl ? "missing host" : "missing token",
              });
            }
            const response = yield* Effect.tryPromise({
              try: () =>
                fetch(
                  `${baseUrl}${RPC_PATH_PREFIX}${encodeURIComponent(prop)}`,
                  {
                    method: "POST",
                    headers: {
                      "content-type": "application/json",
                      [RPC_TOKEN_HEADER]: token,
                    },
                    body: JSON.stringify(args),
                    signal: AbortSignal.timeout(25_000),
                  },
                ),
              catch: (cause) => new RpcCallError({ method: prop, cause }),
            });
            if (response.status === 401) {
              return yield* new RpcUnauthorized({ method: prop });
            }
            const value = yield* Effect.tryPromise({
              try: () => response.json() as Promise<unknown>,
              catch: (cause) => new RpcCallError({ method: prop, cause }),
            });
            if (
              typeof value === "object" &&
              value !== null &&
              (value as { _tag?: unknown })._tag === RPC_ERROR_TAG &&
              "error" in value
            ) {
              return yield* Effect.fail((value as { error: unknown }).error);
            }
            return value;
          });
      },
    },
  ) as Shape;
};

const bindRpc = <Shape, Req = never>(
  targetEff:
    | (RpcTarget & Rpc<Shape>)
    | Effect.Effect<RpcTarget & Rpc<Shape>, never, Req>,
): Effect.Effect<Shape, never, Req> =>
  Effect.gen(function* () {
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const target = yield* resolveTarget(targetEff);
      const keys = rpcEnvKeys(target.LogicalId);
      const host = yield* Binding.Host;
      if (isRailwayHost(host)) {
        yield* host.bind`${target}`({
          env: {
            [keys.host]: target.dnsName,
            [keys.port]: target.port ?? DEFAULT_RPC_PORT,
            [keys.token]: target.rpcToken,
          },
        });
      }
    }

    const keys = rpcEnvKeys(logicalIdOf(targetEff));
    const hostName = fromProcessEnv(keys.host);
    const port = fromProcessEnv(keys.port);
    const token = fromProcessEnv(keys.token);
    const baseUrl =
      hostName.length > 0
        ? `http://${hostName}:${port.length > 0 ? port : String(DEFAULT_RPC_PORT)}`
        : "";

    return makeStub<Shape>({ baseUrl, token });
  });

/**
 * Bind a {@link Function} and return a typed schemaless RPC stub.
 * Calls go to `{dnsName}:{port}/__rpc__/{method}` on the private mesh
 * with a shared token — not the public `*.up.railway.app` URL.
 *
 * @example
 * ```typescript
 * const query = yield* Railway.bindFunction(Query);
 * const greeting = yield* query.greet("sam");
 * ```
 */
export const bindFunction = bindRpc;

/**
 * Bind a {@link Service} and return a typed schemaless RPC stub.
 * Same private-mesh + token path as {@link bindFunction}.
 *
 * @example
 * ```typescript
 * const api = yield* Railway.bindService(Api);
 * const greeting = yield* api.greet("sam");
 * ```
 */
export const bindService = bindRpc;
