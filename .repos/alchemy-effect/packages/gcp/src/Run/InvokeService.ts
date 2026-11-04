import * as Binding from "alchemy/Binding";
import type { Rpc } from "alchemy/Rpc";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as HttpApi from "effect/http-api/HttpApi";
import type * as HttpApiClient from "effect/http-api/HttpApiClient";
import type * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import type * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import type { Rpc as EffectRpc, RpcClient, RpcGroup } from "effect/rpc";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import type { Service } from "./Service.ts";

/** Request options for {@link InvokeServiceClient.fetch}. */
export interface InvokeServiceRequestInit {
  /** HTTP method. @default "GET" */
  method?: string;
  /** Extra request headers. `Authorization` is always set by the binding. */
  headers?: Record<string, string>;
  /** Request body; objects are not serialized — pass a string. */
  body?: string | Uint8Array;
}

/** A fully buffered response from the bound service. */
export interface InvokeServiceResponse {
  /** HTTP status code. */
  readonly status: number;
  /** Response headers (lower-cased names). */
  readonly headers: Readonly<Record<string, string>>;
  /** The response body as text. */
  readonly text: Effect.Effect<string>;
  /** The response body parsed as JSON. */
  readonly json: Effect.Effect<unknown, InvokeServiceError>;
}

/**
 * Runtime client returned by {@link InvokeService}: the target's RPC
 * methods, `fetch` for its HTTP routes, and an `httpClient` for anything
 * else (an Effect RPC or HttpApi client, streaming responses).
 */
export type InvokeServiceClient<Shape = {}> = Omit<Shape, "fetch" | "run"> & {
  /**
   * Call the bound service at `path` (relative to its `uri`) with a
   * Google-signed ID token for the host's runtime service account.
   */
  fetch(
    path: string,
    init?: InvokeServiceRequestInit,
  ): Effect.Effect<InvokeServiceResponse, InvokeServiceError, RuntimeContext>;
  /**
   * An `HttpClient` that signs every request with an ID token for the
   * service. A relative URL such as `/orders` resolves against its `uri`.
   */
  httpClient: HttpClient.HttpClient.With<HttpClientError.HttpClientError | InvokeServiceError>;
};

/** The RPC shape a Cloud Run service class declares, if any. */
type ShapeOf<Target> = Target extends Rpc<infer Shape> ? Shape : {};

/**
 * Minting the ID token, reaching the service, or decoding its response
 * failed. Non-2xx responses are not errors — inspect `status`.
 */
export class InvokeServiceError extends Data.TaggedError("GCP.Run.InvokeServiceError")<{
  message: string;
  cause?: unknown;
}> {}

/**
 * Runtime binding that calls a private Cloud Run {@link Service} from
 * another Cloud Run host with Google-signed identity — the GCP analog of
 * `AWS.Lambda.InvokeFunction`.
 *
 * At deploy time it grants `roles/run.invoker` on the target service to
 * the host's runtime service account and binds the target's `uri` into
 * the host. At runtime it mints an ID token (audience = the target `uri`)
 * from the metadata server, caches it until shortly before expiry, and
 * sends it as `Authorization: Bearer`. The target keeps
 * `invokerIamDisabled` off, so anything without a token gets `403`.
 *
 * Provide {@link InvokeServiceHttp}.
 *
 * ### Calling a private service
 * **Example:** Forward a request to a private backend
 * ```typescript
 * export default class Gateway extends GCP.Function<Gateway>()(
 *   "Gateway",
 *   { main: import.meta.url, invokerIamDisabled: true },
 *   Effect.gen(function* () {
 *     const quotes = yield* GCP.Run.InvokeService(Quotes);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const response = yield* quotes.fetch("/quote").pipe(Effect.orDie);
 *         return HttpServerResponse.text(yield* response.text, {
 *           status: response.status,
 *         });
 *       }),
 *     };
 *   }).pipe(Effect.provide(GCP.Run.InvokeServiceHttp)),
 * ) {}
 * ```
 *
 * **Example:** POST a JSON body
 * ```typescript
 * const response = yield* orders.fetch("/orders", {
 *   method: "POST",
 *   headers: { "content-type": "application/json" },
 *   body: JSON.stringify({ sku: "abc", quantity: 1 }),
 * });
 * const order = yield* response.json;
 * ```
 *
 * ### Calling RPC methods
 * **Example:** Methods on a private service
 * ```typescript
 * export default class Quotes extends GCP.Run.Service<Quotes>()(
 *   "Quotes",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     return {
 *       quote: (symbol: string) => Effect.succeed({ symbol, price: 42 }),
 *       ticks: (symbol: string) => Stream.make(41, 42, 43),
 *     };
 *   }),
 * ) {}
 * ```
 * Keep the service's IAM invoker check on: a service that returns
 * methods and sets `invokerIamDisabled` fails to deploy with
 * `GCP.Run.ServiceRpcPublic`.
 *
 * **Example:** Call them from another service
 * ```typescript
 * const quotes = yield* GCP.Run.InvokeService(Quotes);
 * const { price } = yield* quotes.quote("GOOG");
 * const ticks = yield* quotes.ticks("GOOG").pipe(Stream.take(3), Stream.runCollect);
 * ```
 *
 * ### Bring your own client
 * **Example:** `httpClient` signs every request
 * ```typescript
 * const response = yield* quotes.httpClient.get("/health");
 * ```
 *
 * @binding
 * @category Run
 */
/** `fetch` and `httpClient` of a bound service, alongside a typed client. */
export type InvokeServiceTransport = Pick<InvokeServiceClient, "fetch" | "httpClient">;

/** The API a bound service serves, when it is an Effect RPC group or HttpApi. */
export type InvokeServiceOptions =
  | { schema: RpcGroup.RpcGroup<EffectRpc.Any> }
  | { api: HttpApi.HttpApi<string, HttpApiGroup.Constraint> };

export interface InvokeService extends Binding.Service<
  InvokeService,
  "GCP.Run.InvokeService",
  (service: Service, options?: InvokeServiceOptions) => Effect.Effect<InvokeServiceClient>
> {
  <Target extends Service, Req = never>(
    service: Target | Effect.Effect<Target, never, Req>,
  ): Effect.Effect<InvokeServiceClient<ShapeOf<Target>>, never, InvokeService | Req>;
  <Rpcs extends EffectRpc.Any, Req = never>(
    service: Service | Effect.Effect<Service, never, Req>,
    options: { schema: RpcGroup.RpcGroup<Rpcs> },
  ): Effect.Effect<
    RpcClient.RpcClient<Rpcs, RpcClientError.RpcClientError> & InvokeServiceTransport,
    never,
    InvokeService | Req
  >;
  <Groups extends HttpApiGroup.Constraint, Req = never>(
    service: Service | Effect.Effect<Service, never, Req>,
    options: { api: HttpApi.HttpApi<string, Groups> },
  ): Effect.Effect<
    HttpApiClient.Client<Groups, HttpClientError.HttpClientError | InvokeServiceError> &
      InvokeServiceTransport,
    never,
    InvokeService | Req
  >;
}

export const InvokeService = Binding.Service<InvokeService>("GCP.Run.InvokeService");
