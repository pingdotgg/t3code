/**
 * The `HttpApiTest` module provides helpers for testing `HttpApi`
 * implementations through the generated client interface without starting an
 * HTTP server.
 *
 * Use this module when a test should exercise one or more implemented API
 * groups with the same request encoding, routing, response encoding, and client
 * decoding used by the production `HttpApiBuilder` and `HttpApiClient`
 * pipeline. This is useful for focused handler tests, schema round-trip checks,
 * middleware behavior, and tests that want to call an API through its typed
 * client while keeping all traffic in memory.
 *
 * The selected groups must be provided in the test environment, usually by
 * supplying the corresponding `HttpApiBuilder.group` layers. Groups that are not
 * selected are still present on the returned client shape, but their handlers
 * are placeholders that die if called, which helps catch accidental calls outside
 * the test scope. The generated client is still a real `HttpApiClient`, so
 * endpoint middleware, client middleware, platform services, and the optional
 * `baseUrl` used for URL construction follow the same rules as normal clients;
 * only the HTTP transport is replaced with an in-memory router dispatch.
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import * as Effect from "../../Effect.ts"
import type { FileSystem } from "../../FileSystem.ts"
import * as Layer from "../../Layer.ts"
import type { Path } from "../../Path.ts"
import type { Scope } from "../../Scope.ts"
import type { Generator } from "../http/Etag.ts"
import * as HttpClient from "../http/HttpClient.ts"
import type { HttpPlatform } from "../http/HttpPlatform.ts"
import * as HttpRouter from "../http/HttpRouter.ts"
import * as HttpServerRequest from "../http/HttpServerRequest.ts"
import * as HttpServerResponse from "../http/HttpServerResponse.ts"
import type * as HttpApi from "./HttpApi.ts"
import type { Handlers } from "./HttpApiBuilder.ts"
import * as HttpApiBuilder from "./HttpApiBuilder.ts"
import * as HttpApiClient from "./HttpApiClient.ts"
import type * as HttpApiEndpoint from "./HttpApiEndpoint.ts"
import type * as HttpApiGroup from "./HttpApiGroup.ts"

/**
 * Creates an in-memory client for testing selected groups of an `HttpApi`.
 *
 * **Details**
 *
 * Handlers for the selected groups are taken from the environment; unselected
 * groups are wired with placeholder handlers that fail if called.
 *
 * @category testing
 * @since 4.0.0
 */
export const groups = Effect.fnUntraced(function*<
  ApiId extends string,
  Groups extends HttpApiGroup.Any,
  const Names extends ReadonlyArray<HttpApiGroup.Name<Groups>>,
  SelectedGroups = HttpApiGroup.WithName<Groups, Names[number]>
>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  groupNames: Names,
  options?: {
    readonly baseUrl?: string | URL | undefined
  }
): Effect.fn.Return<
  HttpApiClient.Client<Groups>,
  never,
  | HttpApiGroup.ToService<ApiId, SelectedGroups>
  | HttpApiGroup.MiddlewareClient<Groups>
  | HttpApiEndpoint.Middleware<HttpApiGroup.Endpoints<Groups>>
  | FileSystem
  | Generator
  | HttpPlatform
  | Path
  | Scope
> {
  let context = yield* Effect.context<HttpApiGroup.ToService<ApiId, SelectedGroups>>()

  for (const name in api.groups) {
    const group = api.groups[name]
    if (groupNames.includes(name as any)) {
      continue
    }
    const handlers = new Map<string, Handlers.Item<never>>()
    const routes: Array<HttpRouter.Route<any, any>> = []
    for (const endpointName in group.endpoints) {
      const endpoint = group.endpoints[endpointName]
      const handler: Handlers.Item<never> = {
        endpoint: endpoint as any,
        handler: () => Effect.die(new Error(`Unhandled endpoint: ${endpointName}`)),
        isRaw: false,
        uninterruptible: false
      }
      handlers.set(endpointName, handler)
      routes.push(HttpApiBuilder.handlerToRoute(group as any, handler, context))
    }
    context = Context.add(context, group as any, { handlers, routes })
  }

  const layer: Layer.Layer<
    never,
    never,
    | FileSystem
    | Generator
    | HttpPlatform
    | HttpRouter.HttpRouter
    | Path
  > = HttpApiBuilder.layer(api).pipe(
    Layer.provide(Layer.succeedContext(context))
  ) as any
  const handler = yield* HttpRouter.toHttpEffect(layer)
  const httpClient = HttpClient.make(Effect.fnUntraced(function*(request) {
    const serverRequest = HttpServerRequest.fromClientRequest(request)
    const response = yield* handler.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, serverRequest),
      Effect.orDie
    )
    return HttpServerResponse.toClientResponse(response)
  }, Effect.scoped))

  return yield* HttpApiClient.makeWith(api, {
    httpClient,
    baseUrl: options?.baseUrl ?? "http://localhost:3000"
  })
})
