import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
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

/** Runtime client returned by {@link InvokeService}. */
export interface InvokeServiceClient {
  /**
   * Call the bound service at `path` (relative to its `uri`) with a
   * Google-signed ID token for the host's runtime service account.
   */
  fetch(
    path: string,
    init?: InvokeServiceRequestInit,
  ): Effect.Effect<InvokeServiceResponse, InvokeServiceError, RuntimeContext>;
}

/**
 * Minting the ID token, reaching the service, or decoding its response
 * failed. Non-2xx responses are not errors — inspect `status`.
 */
export class InvokeServiceError extends Data.TaggedError(
  "GCP.Run.InvokeServiceError",
)<{
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
 * @binding
 * @category Run
 */
export interface InvokeService extends Binding.Service<
  InvokeService,
  "GCP.Run.InvokeService",
  (service: Service) => Effect.Effect<InvokeServiceClient>
> {}

export const InvokeService = Binding.Service<InvokeService>(
  "GCP.Run.InvokeService",
);
