import * as Binding from "alchemy/Binding";
import type { Resource } from "alchemy/Resource";
import { makeFetchRpcStub, type Rpc } from "alchemy/Rpc";
import { CurrentRuntimeContext, type RuntimeContext, sanitizeKey } from "alchemy/RuntimeContext";
import { isYieldableEffectLike } from "alchemy/Util/effect";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as HttpApi from "effect/http-api/HttpApi";
import type * as HttpApiClient from "effect/http-api/HttpApiClient";
import type * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import type { Rpc as EffectRpc, RpcClient, RpcGroup } from "effect/rpc";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import type { GcpHostBinding } from "../Host.ts";
import type { Container } from "./Container.ts";
import { makeHttpApiClient, makeRpcGroupClient } from "./EffectApis.ts";

/** The bound container has no port, or the caller was deployed before the binding existed. */
export class BoundContainerUnavailable extends Data.TaggedError(
  "GCP.Run.BoundContainerUnavailable",
)<{
  container: string;
}> {
  override get message() {
    return `No port for GCP.Run.Container ${this.container}. Give it a port, or redeploy the caller.`;
  }
}

/**
 * Client for a container bound with {@link bindContainer}: its RPC
 * methods, plus `fetch` for its HTTP routes.
 */
export type ContainerClient<Shape> = Omit<Shape, "fetch" | "run"> & {
  /**
   * Send a request to the container's `fetch` handler. A relative URL such
   * as `/health` resolves against `http://localhost:<port>`.
   */
  fetch(
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    HttpClientError.HttpClientError | BoundContainerUnavailable,
    RuntimeContext
  >;
  /**
   * An `HttpClient` whose relative requests go to the container, for an
   * Effect RPC or HttpApi client.
   */
  httpClient: HttpClient.HttpClient.With<
    HttpClientError.HttpClientError | BoundContainerUnavailable
  >;
};

/** A port of a container bound with {@link bindPort}. */
export interface PortClient {
  /** Always `localhost`: sidecars share the instance's network. */
  host: "localhost";
  /** The bound port. */
  port: number;
  /** `http://localhost:{port}`, for a port that serves plain HTTP. */
  url: string;
  /** An `HttpClient` whose relative requests go to {@link url}. */
  client: HttpClient.HttpClient;
}

type Target<Shape> = Container & Rpc<Shape>;

/** A container to bind: a `GCP.Run.Container` class, or an image-only declaration. */
type Bindable<Shape, Req> =
  | Target<Shape>
  | Effect.Effect<Target<Shape>, never, Req>
  | Effect.Effect<Container, never, Req>;

const RUN_HOSTS = new Set(["GCP.Run.Service", "GCP.Run.Container"]);

const isRunHost = (value: unknown): value is Resource<string, any, any, GcpHostBinding> =>
  typeof value === "object" &&
  value !== null &&
  RUN_HOSTS.has((value as { Type?: string }).Type ?? "");

/** Logical id without yielding the container (the runtime has no engine). */
const logicalIdOf = (target: unknown): string => {
  const id =
    target !== null && (typeof target === "object" || typeof target === "function")
      ? (target as { LogicalId?: unknown }).LogicalId
      : undefined;
  return typeof id === "string" ? id : "";
};

const withBase = (base: string, url: string) =>
  /^[a-z]+:\/\//i.test(url) ? url : `${base}${url.startsWith("/") ? "" : "/"}${url}`;

/**
 * Add the container to the host's revision and record its port in the
 * host's env. Returns a runtime accessor for that port.
 */
const bindSidecar = <Shape, Req>(
  target: Bindable<Shape, Req>,
): Effect.Effect<
  { id: string; port: Effect.Effect<number, BoundContainerUnavailable> },
  never,
  Req
> =>
  Effect.gen(function* () {
    const id = logicalIdOf(target);
    const key = sanitizeKey(`GCP_BIND_${id}_PORT`);
    const ctx = yield* CurrentRuntimeContext;
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      // Yielding registers the container and makes the host depend on it.
      const container = isYieldableEffectLike(target)
        ? yield* target as Effect.Effect<Container, never, Req>
        : target;
      const host = yield* Binding.Host;
      if (isRunHost(host)) {
        yield* host.bind`GCP.Run.bindContainer(${container})`({
          env: { [key]: container.port },
          containers: [
            {
              spec: container.spec,
              iam: container.iam,
              sidecars: container.sidecars,
            },
          ],
        } as unknown as GcpHostBinding);
      }
    }
    return {
      id,
      port: (ctx === undefined ? Effect.undefined : ctx.get<unknown>(key)).pipe(
        Effect.flatMap((port) =>
          port === undefined || port === null || port === ""
            ? Effect.fail(new BoundContainerUnavailable({ container: id }))
            : Effect.succeed(Number(port)),
        ),
      ),
    };
  });

/**
 * Run a {@link Container} as a sidecar of this Cloud Run service (or of
 * another Container) and call it over `localhost`.
 *
 * At deploy time the binding adds the container to the host's revision
 * and to the host's `dependsOn`, so the host starts only after the
 * container passes its startup probe. The container's binding roles are
 * granted to the revision's service account. At runtime it returns a
 * client with the container's methods (schemaless RPC on `/__rpc__/*`)
 * plus `fetch` for its HTTP routes.
 *
 * ### Calling a sidecar
 * **Example:** Methods on the container
 * ```typescript
 * export default class Worker extends GCP.Run.Container<Worker>()(
 *   "Worker",
 *   { main: import.meta.url, port: 3000 },
 *   Effect.gen(function* () {
 *     return {
 *       greet: (name: string) => Effect.succeed(`hello ${name}`),
 *       count: () => Stream.make(1, 2, 3),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * **Example:** Bind it and call a method
 * ```typescript
 * export default class Api extends GCP.Run.Service<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const worker = yield* GCP.Run.bindContainer(Worker);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const greeting = yield* worker.greet("sam");
 *         return HttpServerResponse.text(greeting);
 *       }),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### Streams and HTTP
 * **Example:** A method that returns a Stream
 * ```typescript
 * const counts = yield* worker.count().pipe(Stream.runCollect);
 * ```
 *
 * **Example:** Send a request to the container's `fetch`
 * ```typescript
 * const response = yield* worker.fetch(HttpClientRequest.get("/health"));
 * ```
 *
 * ### Sidecars that bind sidecars
 * **Example:** A container that starts after another
 * ```typescript
 * export default class Worker extends GCP.Run.Container<Worker>()(
 *   "Worker",
 *   { main: import.meta.url, port: 3000 },
 *   Effect.gen(function* () {
 *     const cache = yield* GCP.Run.bindPort(Cache, 6379);
 *     return { ping: () => Effect.succeed(cache.url) };
 *   }),
 * ) {}
 * ```
 * Every sidecar a bound container binds joins the same revision.
 *
 * @binding
 * @product Run
 */
/** `fetch` and `httpClient` of a bound container, alongside a typed client. */
export type ContainerTransport = Pick<ContainerClient<{}>, "fetch" | "httpClient">;

/** Options for {@link bindContainer}: the API the container serves, if typed. */
export type BindContainerOptions<
  Rpcs extends EffectRpc.Any,
  Groups extends HttpApiGroup.Constraint,
> = { schema: RpcGroup.RpcGroup<Rpcs> } | { api: HttpApi.HttpApi<string, Groups> };

export function bindContainer<Shape = {}, Req = never>(
  target: Bindable<Shape, Req>,
): Effect.Effect<ContainerClient<Shape>, never, Req | HttpClient.HttpClient>;
export function bindContainer<Rpcs extends EffectRpc.Any, Req = never>(
  target: Bindable<unknown, Req>,
  options: { schema: RpcGroup.RpcGroup<Rpcs> },
): Effect.Effect<
  RpcClient.RpcClient<Rpcs, RpcClientError.RpcClientError> & ContainerTransport,
  never,
  Req | HttpClient.HttpClient
>;
export function bindContainer<Groups extends HttpApiGroup.Constraint, Req = never>(
  target: Bindable<unknown, Req>,
  options: { api: HttpApi.HttpApi<string, Groups> },
): Effect.Effect<
  HttpApiClient.Client<Groups, HttpClientError.HttpClientError | BoundContainerUnavailable> &
    ContainerTransport,
  never,
  Req | HttpClient.HttpClient
>;
export function bindContainer(
  target: Bindable<unknown, unknown>,
  options?: BindContainerOptions<any, any>,
): Effect.Effect<unknown, never, any> {
  return Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const bound = yield* bindSidecar(target);
    const httpClient = HttpClient.mapRequestEffect(http, (request) =>
      bound.port.pipe(
        Effect.map((port) =>
          HttpClientRequest.setUrl(request, withBase(`http://localhost:${port}`, request.url)),
        ),
      ),
    );
    const send = (request: HttpClientRequest.HttpClientRequest) => httpClient.execute(request);
    const transport = { fetch: send, httpClient };
    if (options !== undefined && "schema" in options) {
      return Object.assign(
        makeRpcGroupClient(options.schema, httpClient as unknown as HttpClient.HttpClient),
        transport,
      );
    }
    if (options !== undefined && "api" in options) {
      return Object.assign(yield* makeHttpApiClient(options.api, httpClient), transport);
    }
    return makeFetchRpcStub<ContainerClient<{}>>({
      // Relative RPC paths, resolved against the container's localhost port.
      baseUrl: "",
      fetch: send as (
        request: HttpClientRequest.HttpClientRequest,
      ) => Effect.Effect<HttpClientResponse.HttpClientResponse, unknown>,
      base: transport,
    });
  });
}

/**
 * Run a {@link Container} as a sidecar and reach one of its ports
 * directly — for a protocol other than HTTP, such as Redis or Postgres.
 * See {@link bindContainer}.
 *
 * ### Binding a port
 * **Example:** A Redis sidecar
 * ```typescript
 * export const Cache = GCP.Run.Container("Cache", {
 *   image: "docker.io/library/redis:7",
 *   port: 6379,
 *   startupProbe: { tcpSocket: {} },
 * });
 *
 * // inside the service's Effect
 * const cache = yield* GCP.Run.bindPort(Cache, 6379);
 * // cache.url === "http://localhost:6379"; connect with `redis://localhost:${cache.port}`
 * ```
 *
 * @binding
 * @product Run
 */
export const bindPort = <Req = never>(
  target: Bindable<unknown, Req>,
  port: number,
): Effect.Effect<PortClient, never, Req | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    yield* bindSidecar(target);
    const url = `http://localhost:${port}`;
    return {
      host: "localhost",
      port,
      url,
      client: HttpClient.mapRequest(http, (request) =>
        HttpClientRequest.setUrl(request, withBase(url, request.url)),
      ),
    } satisfies PortClient;
  });
