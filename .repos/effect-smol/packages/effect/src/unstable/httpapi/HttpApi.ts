/**
 * The `HttpApi` module defines the top-level declaration for an Effect HTTP
 * API. An {@link HttpApi} has an identifier, annotations, and a collection of
 * groups whose endpoints describe request inputs, response schemas, middleware,
 * and route metadata.
 *
 * An `HttpApi` value is the shared contract consumed by server builders,
 * generated clients, URL builders, OpenAPI generation, and reflection tools.
 * Handler implementations are supplied later with `HttpApiBuilder.group`, and
 * the completed API is registered with `HttpApiBuilder.layer`.
 *
 * **Mental model**
 *
 * - {@link make} creates an empty API declaration with a stable identifier.
 * - Groups are added to the API declaration, and each group owns its endpoint
 *   declarations.
 * - API-level prefixes, middleware, and annotations are composition operations
 *   over the groups already present in the declaration.
 * - {@link reflect} walks the final group and endpoint metadata with merged
 *   annotations, status-indexed response schemas, and middleware errors.
 *
 * **Common tasks**
 *
 * - Create an API with {@link make}.
 * - Add groups with the `add` method, or merge another API with `addHttpApi`.
 * - Apply a shared path prefix, middleware, or annotation through the methods on
 *   {@link HttpApi}.
 * - Inspect the resulting route shape with {@link reflect}.
 * - Register extra OpenAPI component schemas through {@link AdditionalSchemas}.
 *
 * **Gotchas**
 *
 * - Group identifiers are used as keys. Adding a group with the same identifier
 *   replaces the previous group.
 * - `prefix` and `middleware` affect the groups and endpoints already present
 *   when those methods are called.
 * - `addHttpApi` merges the added API's annotations into its groups.
 * - Reflection includes middleware error schemas with endpoint errors and treats
 *   endpoints without an explicit success schema as `NoContent`.
 * - Schemas supplied through {@link AdditionalSchemas} must have an `identifier`
 *   annotation so OpenAPI generation can emit them as components.
 *
 * **See also**
 *
 * - {@link make} for constructing API declarations.
 * - {@link reflect} for inspecting groups and endpoints.
 * - {@link AdditionalSchemas} for OpenAPI component schemas.
 *
 * @since 4.0.0
 */
import type { NonEmptyReadonlyArray } from "../../Array.ts"
import * as Context from "../../Context.ts"
import { type Pipeable, pipeArguments } from "../../Pipeable.ts"
import * as Predicate from "../../Predicate.ts"
import * as Record from "../../Record.ts"
import type * as Schema from "../../Schema.ts"
import type * as AST from "../../SchemaAST.ts"
import type { Mutable } from "../../Types.ts"
import type { PathInput } from "../http/HttpRouter.ts"
import * as HttpApiEndpoint from "./HttpApiEndpoint.ts"
import type * as HttpApiGroup from "./HttpApiGroup.ts"
import type * as HttpApiMiddleware from "./HttpApiMiddleware.ts"
import * as HttpApiSchema from "./HttpApiSchema.ts"

const TypeId = "~effect/httpapi/HttpApi"

/**
 * Returns `true` when a value is an `HttpApi`.
 *
 * @category guards
 * @since 4.0.0
 */
export const isHttpApi = (u: unknown): u is Any => Predicate.hasProperty(u, TypeId)

/**
 * An `HttpApi` is a collection of HTTP API groups and endpoints that represents a
 * portion of your domain.
 *
 * **When to use**
 *
 * Use when endpoint implementations can be provided with `HttpApiBuilder.group`, and the
 * completed API can be registered with `HttpApiBuilder.layer`.
 *
 * @category models
 * @since 4.0.0
 */
export interface HttpApi<
  out Id extends string,
  out Groups extends HttpApiGroup.Any = never
> extends Pipeable {
  new(_: never): {}
  readonly [TypeId]: typeof TypeId
  readonly identifier: Id
  readonly groups: Record.ReadonlyRecord<string, Groups>
  readonly annotations: Context.Context<never>

  /**
   * Add a `HttpApiGroup` to the `HttpApi`.
   */
  add<A extends NonEmptyReadonlyArray<HttpApiGroup.Any>>(...groups: A): HttpApi<Id, Groups | A[number]>

  /**
   * Add another `HttpApi` to the `HttpApi`.
   */
  addHttpApi<Id2 extends string, Groups2 extends HttpApiGroup.Any>(
    api: HttpApi<Id2, Groups2>
  ): HttpApi<Id, Groups | Groups2>

  /**
   * Prefix all endpoints in the `HttpApi`.
   */
  prefix<const Prefix extends PathInput>(prefix: Prefix): HttpApi<Id, HttpApiGroup.AddPrefix<Groups, Prefix>>

  /**
   * Adds a middleware to every endpoint currently in the `HttpApi`.
   *
   * **Gotchas**
   *
   * Endpoints added after this method is called do not receive the middleware.
   */
  middleware<I extends HttpApiMiddleware.AnyId, S>(
    middleware: Context.Key<I, S>
  ): HttpApi<Id, HttpApiGroup.AddMiddleware<Groups, I>>

  /**
   * Annotate the `HttpApi`.
   */
  annotate<I, S>(tag: Context.Key<I, S>, value: S): HttpApi<Id, Groups>

  /**
   * Annotate the `HttpApi` with a Context.
   */
  annotateMerge<I>(context: Context.Context<I>): HttpApi<Id, Groups>
}

/**
 * An `HttpApi` value with its identifier and group types erased.
 *
 * @category models
 * @since 4.0.0
 */
export interface Any {
  readonly [TypeId]: typeof TypeId
}

/**
 * An `HttpApi` with broad identifier and group types while retaining the concrete
 * runtime properties used by implementation helpers.
 *
 * @category models
 * @since 4.0.0
 */
export type AnyWithProps = HttpApi<string, HttpApiGroup.AnyWithProps>

const Proto = {
  [TypeId]: TypeId,
  pipe() {
    return pipeArguments(this, arguments)
  },
  add(
    this: AnyWithProps,
    ...toAdd: NonEmptyReadonlyArray<HttpApiGroup.AnyWithProps>
  ) {
    const groups = { ...this.groups }
    for (const group of toAdd) {
      groups[group.identifier] = group
    }
    return makeProto({
      identifier: this.identifier,
      groups,
      annotations: this.annotations
    })
  },
  addHttpApi(
    this: AnyWithProps,
    api: AnyWithProps
  ) {
    const newGroups = { ...this.groups }
    for (const key in api.groups) {
      const newGroup: Mutable<HttpApiGroup.AnyWithProps> = api.groups[key]
      newGroup.annotations = Context.merge(api.annotations, newGroup.annotations)
      newGroups[key] = newGroup as any
    }
    return makeProto({
      identifier: this.identifier,
      groups: newGroups,
      annotations: this.annotations
    })
  },
  prefix(this: AnyWithProps, prefix: PathInput) {
    return makeProto({
      identifier: this.identifier,
      groups: Record.map(this.groups, (group) => group.prefix(prefix)),
      annotations: this.annotations
    })
  },
  middleware(this: AnyWithProps, tag: HttpApiMiddleware.AnyService) {
    return makeProto({
      identifier: this.identifier,
      groups: Record.map(this.groups, (group) => group.middleware(tag as any)),
      annotations: this.annotations
    })
  },
  annotate(this: AnyWithProps, key: Context.Key<any, any>, value: any) {
    return makeProto({
      identifier: this.identifier,
      groups: this.groups,
      annotations: Context.add(this.annotations, key, value)
    })
  },
  annotateMerge(this: AnyWithProps, annotations: Context.Context<never>) {
    return makeProto({
      identifier: this.identifier,
      groups: this.groups,
      annotations: Context.merge(this.annotations, annotations)
    })
  }
}

const makeProto = <Id extends string, Groups extends HttpApiGroup.Any>(
  options: {
    readonly identifier: Id
    readonly groups: Record.ReadonlyRecord<string, Groups>
    readonly annotations: Context.Context<never>
  }
): HttpApi<Id, Groups> => {
  function HttpApi() {}
  Object.setPrototypeOf(HttpApi, Proto)
  HttpApi.groups = options.groups
  HttpApi.annotations = options.annotations
  return HttpApi as any
}

/**
 * Creates an empty `HttpApi` with the supplied identifier.
 *
 * **When to use**
 *
 * Use when add groups with `add` or `addHttpApi`, provide endpoint implementations with
 * `HttpApiBuilder.group`, and register the API with `HttpApiBuilder.layer`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = <const Id extends string>(identifier: Id): HttpApi<Id, never> =>
  makeProto({
    identifier,
    groups: new Map() as any,
    annotations: Context.empty()
  })

/**
 * Describes the groups and endpoints in an `HttpApi`.
 *
 * **Details**
 *
 * The callbacks receive each group or endpoint with merged annotations, endpoint
 * middleware, and response schemas grouped by HTTP status.
 *
 * @category reflection
 * @since 4.0.0
 */
export const reflect = <Id extends string, Groups extends HttpApiGroup.Any>(
  self: HttpApi<Id, Groups>,
  options: {
    readonly predicate?:
      | Predicate.Predicate<{
        readonly endpoint: HttpApiEndpoint.AnyWithProps
        readonly group: HttpApiGroup.AnyWithProps
      }>
      | undefined
    readonly onGroup: (options: {
      readonly group: HttpApiGroup.AnyWithProps
      readonly mergedAnnotations: Context.Context<never>
    }) => void
    readonly onEndpoint: (options: {
      readonly group: HttpApiGroup.AnyWithProps
      readonly endpoint: HttpApiEndpoint.AnyWithProps
      readonly mergedAnnotations: Context.Context<never>
      readonly middleware: ReadonlySet<HttpApiMiddleware.AnyService>
      readonly successes: ReadonlyMap<number, readonly [Schema.Top, ...Array<Schema.Top>]>
      readonly errors: ReadonlyMap<number, readonly [Schema.Top, ...Array<Schema.Top>]>
    }) => void
  }
) => {
  const groups = Object.values(self.groups) as any as Array<HttpApiGroup.AnyWithProps>
  for (const group of groups) {
    const groupAnnotations = Context.merge(self.annotations, group.annotations)
    options.onGroup({
      group,
      mergedAnnotations: groupAnnotations
    })
    const endpoints = Object.values(group.endpoints) as Iterable<HttpApiEndpoint.AnyWithProps>
    for (const endpoint of endpoints) {
      if (
        options.predicate && !options.predicate({
          endpoint,
          group
        } as any)
      ) continue

      options.onEndpoint({
        group,
        endpoint,
        middleware: endpoint.middlewares as any,
        mergedAnnotations: Context.merge(groupAnnotations, endpoint.annotations),
        successes: extractResponseContent(
          HttpApiEndpoint.getSuccessSchemas(endpoint),
          HttpApiSchema.getStatusSuccess
        ),
        errors: extractResponseContent(
          HttpApiEndpoint.getErrorSchemas(endpoint),
          HttpApiSchema.getStatusError
        )
      })
    }
  }
}

// -------------------------------------------------------------------------------------

const extractResponseContent = (
  schemas: Array<Schema.Top>,
  getStatus: (ast: AST.AST) => number
): ReadonlyMap<number, [Schema.Top, ...Array<Schema.Top>]> => {
  const map = new Map<number, [Schema.Top, ...Array<Schema.Top>]>()

  schemas.forEach(add)

  return map

  function add(schema: Schema.Top) {
    const ast = schema.ast
    const status = getStatus(ast)
    const schemas = map.get(status)
    if (schemas === undefined) {
      map.set(status, [schema])
    } else {
      schemas.push(schema)
    }
  }
}

/**
 * Adds additional schemas to components/schemas.
 * The provided schemas must have a `identifier` annotation.
 *
 * @category tags
 * @since 4.0.0
 */
export class AdditionalSchemas extends Context.Service<
  AdditionalSchemas,
  ReadonlyArray<Schema.Top>
>()("effect/httpapi/HttpApi/AdditionalSchemas") {}
