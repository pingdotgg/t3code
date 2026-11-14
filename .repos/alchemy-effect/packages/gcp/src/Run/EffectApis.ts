import * as Effect from "effect/Effect";
import type * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import type * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Etag from "effect/http/Etag";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import type * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import {
  type Rpc,
  RpcClient,
  type RpcGroup,
  RpcSchema,
  RpcSerialization,
  RpcServer,
} from "effect/rpc";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

/**
 * Serve an Effect RPC group as a Cloud Run service's or container's
 * `fetch`. Uses NDJSON, the serialization the `schema` clients of
 * {@link bindContainer} and {@link InvokeService} speak, so value and
 * streaming procedures both work.
 *
 * ### Serving Effect RPC
 * **Example:** A container that serves an RpcGroup
 * ```typescript
 * export default class Tasks extends GCP.Run.Container<Tasks>()(
 *   "Tasks",
 *   { main: import.meta.url, port: 3000 },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: GCP.Run.ServeRpc(TaskRpcs, TaskRpcs.toLayer({
 *         getTask: ({ id }) => Effect.succeed(new Task({ id, title: "write docs" })),
 *       })),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * @primitive
 * @category Run
 */
/**
 * Build `server` once, on the first request, in a scope that lives as long
 * as the process (a Cloud Run instance), and hand every request to it.
 */
const servedOnce = <E, R, RIn>(
  server: Effect.Effect<
    Effect.Effect<HttpServerResponse.HttpServerResponse, E, RIn>,
    never,
    R | Scope.Scope
  >,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, RIn | Exclude<R, Scope.Scope>> => {
  let built: Effect.Effect<HttpServerResponse.HttpServerResponse, E, RIn> | undefined;
  const lock = Semaphore.makeUnsafe(1);
  const build = lock.withPermits(1)(
    Effect.suspend(() =>
      built !== undefined
        ? Effect.succeed(built)
        : server.pipe(
            Scope.provide(Scope.makeUnsafe()),
            Effect.tap((handler) => Effect.sync(() => (built = handler))),
          ),
    ),
  );
  return Effect.flatMap(
    Effect.suspend(() => (built !== undefined ? Effect.succeed(built) : build)),
    (handler) => handler,
  );
};

/**
 * Serve an Effect RPC group as a Cloud Run service's or container's
 * `fetch`. Uses NDJSON, the serialization the `schema` clients of
 * {@link bindContainer} and {@link InvokeService} speak, so value and
 * streaming procedures both work.
 *
 * ### Serving Effect RPC
 * **Example:** A container that serves an RpcGroup
 * ```typescript
 * export default class Tasks extends GCP.Run.Container<Tasks>()(
 *   "Tasks",
 *   { main: import.meta.url, port: 3000 },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: GCP.Run.ServeRpc(TaskRpcs, TaskRpcs.toLayer({
 *         getTask: ({ id }) => Effect.succeed(new Task({ id, title: "write docs" })),
 *       })),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * @primitive
 * @category Run
 */
export const ServeRpc = <Rpcs extends Rpc.Any, R>(
  group: RpcGroup.RpcGroup<Rpcs>,
  handlers: Layer.Layer<Rpc.ToHandler<Rpcs>, never, R>,
) =>
  servedOnce(
    RpcServer.toHttpEffect(group).pipe(
      Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerNdjson)),
    ),
  );

/**
 * Serve an Effect HttpApi as a Cloud Run service's or container's
 * `fetch`: the api plus the Layers of its implemented groups.
 *
 * ### Serving an HttpApi
 * **Example:** A service that serves an HttpApi
 * ```typescript
 * export default class TaskHttp extends GCP.Run.Service<TaskHttp>()(
 *   "TaskHttp",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const tasks = HttpApiBuilder.group(TaskApi, "Tasks", (handlers) =>
 *       handlers.handle("getTask", ({ params }) =>
 *         Effect.succeed(new Task({ id: params.id, title: "write docs" })),
 *       ),
 *     );
 *     return { fetch: GCP.Run.ServeHttpApi(TaskApi, tasks) };
 *   }),
 * ) {}
 * ```
 *
 * @primitive
 * @category Run
 */
export const ServeHttpApi = <Id extends string, Groups extends HttpApiGroup.Constraint, R>(
  api: HttpApi.HttpApi<Id, Groups>,
  groups: Layer.Layer<HttpApiGroup.ToService<Id, Groups>, never, R>,
) =>
  api.pipe(
    HttpApiBuilder.layer,
    Layer.provide(groups),
    Layer.provide(Layer.mergeAll(HttpPlatform.layer, Etag.layer)),
    HttpRouter.toHttpEffect,
    servedOnce,
  );

/**
 * A typed Effect RPC client over `http`. Each call builds its own
 * `RpcClient` in a scope that lives as long as the call (or the stream,
 * for streaming procedures), so no I/O outlives a request.
 */
export const makeRpcGroupClient = <Rpcs extends Rpc.Any>(
  group: RpcGroup.RpcGroup<Rpcs>,
  http: HttpClient.HttpClient,
): RpcClient.RpcClient<Rpcs, RpcClientError.RpcClientError> => {
  const protocol = // `http` already resolves relative URLs against the target; an empty
    // base keeps the protocol from prefixing them again.
    RpcClient.layerProtocolHttp({ url: "" }).pipe(
      Layer.provide(RpcSerialization.layerNdjson),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
    );
  const client = RpcClient.make(group).pipe(Effect.provide(protocol));
  const call = (method: string, args: unknown[]) =>
    Effect.map(client, (built) =>
      (built as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!(...args),
    );
  return new Proxy(
    {},
    {
      get: (_target, method) => {
        if (typeof method !== "string") return undefined;
        const rpc = group.requests.get(method) as Rpc.AnyWithProps | undefined;
        if (rpc === undefined) return undefined;
        return RpcSchema.isStreamSchema(rpc.successSchema)
          ? (...args: unknown[]) =>
              Stream.unwrap(
                call(method, args) as Effect.Effect<
                  Stream.Stream<unknown, unknown>,
                  never,
                  Scope.Scope
                >,
              )
          : (...args: unknown[]) =>
              Effect.scoped(
                Effect.flatMap(
                  call(method, args) as Effect.Effect<
                    Effect.Effect<unknown, unknown>,
                    never,
                    Scope.Scope
                  >,
                  (effect) => effect,
                ),
              );
      },
    },
  ) as RpcClient.RpcClient<Rpcs, RpcClientError.RpcClientError>;
};

/** A typed Effect HttpApi client whose requests go through `http`. */
export const makeHttpApiClient = <Id extends string, Groups extends HttpApiGroup.Constraint, E>(
  api: HttpApi.HttpApi<Id, Groups>,
  http: HttpClient.HttpClient.With<E>,
) =>
  HttpApiClient.make(api).pipe(
    Effect.provideService(HttpClient.HttpClient, http as unknown as HttpClient.HttpClient),
  ) as unknown as Effect.Effect<HttpApiClient.Client<Groups, E>>;
