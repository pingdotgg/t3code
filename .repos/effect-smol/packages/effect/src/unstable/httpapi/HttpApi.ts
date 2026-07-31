/**
 * Describes an Effect HTTP API as groups of endpoints.
 *
 * An `HttpApi` value is data: it has an identifier, annotations, and groups of
 * endpoints that describe request inputs, responses, middleware, and route
 * metadata. The same description can be used by server builders, generated
 * clients, URL builders, OpenAPI generation, and reflection tools.
 *
 * @since 4.0.0
 */
import type { NonEmptyReadonlyArray } from "../../Array.ts"
import * as Context from "../../Context.ts"
import * as InternalRecord from "../../internal/record.ts"
import { type Pipeable, pipeArguments } from "../../Pipeable.ts"
import * as Predicate from "../../Predicate.ts"
import * as Record from "../../Record.ts"
import type * as Schema from "../../Schema.ts"
import type * as SchemaAST from "../../SchemaAST.ts"
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
export const isHttpApi = (u: unknown): u is Top => Predicate.hasProperty(u, TypeId)

/**
 * Groups indexed by their identifier.
 */
type GroupMap<Groups> = {
  readonly [Group in Groups as HttpApiGroup.Identifier<Group>]: Group
}

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
  in out Groups extends HttpApiGroup.Constraint = never
> extends Pipeable {
  new(_: never): {}
  readonly [TypeId]: typeof TypeId
  readonly identifier: Id
  readonly groups: GroupMap<Groups>
  readonly annotations: Context.Context<never>

  /**
   * Add a `HttpApiGroup` to the `HttpApi`.
   */
  add<const A extends NonEmptyReadonlyArray<HttpApiGroup.Constraint>>(...groups: A): HttpApi<Id, Groups | A[number]>

  /**
   * Adds every group from another `HttpApi` while preserving its annotation scope.
   *
   * **When to use**
   *
   * Use when you want to compose an API from groups declared and annotated under another API.
   *
   * **Details**
   *
   * The added API is flattened into this API rather than retained as a nested value. Each added group
   * is copied with the added API's annotations, leaving the added API unchanged. Annotation precedence
   * from least to most specific is this API, the added API, the group, and then the endpoint.
   *
   * **Gotchas**
   *
   * Annotations from the added API do not become top-level annotations of the result and do not affect
   * groups already present in this API. They remain scoped to the groups and endpoints being added.
   */
  addHttpApi<Id2 extends string, Groups2 extends HttpApiGroup.Constraint>(
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
export interface Constraint {
  readonly [TypeId]: typeof TypeId
}

/**
 * An `HttpApi` with broad identifier and group types while retaining the concrete
 * runtime properties used by implementation helpers.
 *
 * @category models
 * @since 4.0.0
 */
export interface Top extends HttpApi<string, HttpApiGroup.Top> {}

const Proto = {
  [TypeId]: TypeId,
  pipe() {
    return pipeArguments(this, arguments)
  },
  add(
    this: Top,
    ...toAdd: NonEmptyReadonlyArray<HttpApiGroup.Top>
  ) {
    const groups = { ...this.groups }
    for (const group of toAdd) {
      InternalRecord.assignProperty(groups, group.identifier, group)
    }
    return makeProto({
      ...optionsFromApi(this),
      groups
    })
  },
  addHttpApi(
    this: Top,
    api: Top
  ) {
    const newGroups = { ...this.groups }
    for (const key of Object.keys(api.groups)) {
      const group = api.groups[key]
      InternalRecord.assignProperty(
        newGroups,
        key,
        group.annotateMerge(Context.merge(api.annotations, group.annotations))
      )
    }
    return makeProto({
      ...optionsFromApi(this),
      groups: newGroups
    })
  },
  prefix(this: Top, prefix: PathInput) {
    return makeProto({
      ...optionsFromApi(this),
      groups: Record.map(this.groups, (group) => group.prefix(prefix))
    })
  },
  middleware(this: Top, tag: HttpApiMiddleware.AnyService) {
    return makeProto({
      ...optionsFromApi(this),
      groups: Record.map(this.groups, (group) => group.middleware(tag as any))
    })
  },
  annotate(this: Top, key: Context.Key<any, any>, value: any) {
    return makeProto({
      ...optionsFromApi(this),
      annotations: Context.add(this.annotations, key, value)
    })
  },
  annotateMerge(this: Top, annotations: Context.Context<never>) {
    return makeProto({
      ...optionsFromApi(this),
      annotations: Context.merge(this.annotations, annotations)
    })
  }
}

const optionsFromApi = (api: Top) => ({
  identifier: api.identifier,
  groups: api.groups,
  annotations: api.annotations
})

const makeProto = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  options: {
    readonly identifier: Id
    readonly groups: Record.ReadonlyRecord<string, HttpApiGroup.Constraint>
    readonly annotations: Context.Context<never>
  }
): HttpApi<Id, Groups> => {
  function HttpApi() {}
  Object.setPrototypeOf(HttpApi, Proto)
  return Object.assign(HttpApi, options) as any
}

/**
 * Creates an empty `HttpApi` with the supplied identifier.
 *
 * **When to use**
 *
 * Use when you need to start defining an HTTP API, add groups with `add` or
 * `addHttpApi`, provide endpoint implementations with `HttpApiBuilder.group`,
 * and register the API with `HttpApiBuilder.layer`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = <const Id extends string>(identifier: Id): HttpApi<Id, never> =>
  makeProto({
    identifier,
    groups: {},
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
export const reflect = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  self: HttpApi<Id, Groups>,
  options: {
    readonly predicate?:
      | Predicate.Predicate<{
        readonly endpoint: HttpApiEndpoint.Top
        readonly group: HttpApiGroup.Top
      }>
      | undefined
    readonly onGroup: (options: {
      readonly group: HttpApiGroup.Top
      readonly mergedAnnotations: Context.Context<never>
    }) => void
    readonly onEndpoint: (options: {
      readonly group: HttpApiGroup.Top
      readonly endpoint: HttpApiEndpoint.Top
      readonly mergedAnnotations: Context.Context<never>
      readonly middleware: ReadonlySet<HttpApiMiddleware.AnyService>
      readonly successes: ReadonlyMap<number, readonly [Schema.Top, ...Array<Schema.Top>]>
      readonly errors: ReadonlyMap<number, readonly [Schema.Top, ...Array<Schema.Top>]>
    }) => void
  }
) => {
  const groups = Object.values(self.groups) as any as Array<HttpApiGroup.Top>
  for (const group of groups) {
    const groupAnnotations = Context.merge(self.annotations, group.annotations)
    options.onGroup({
      group,
      mergedAnnotations: groupAnnotations
    })
    const endpoints = Object.values(group.endpoints) as Iterable<HttpApiEndpoint.Top>
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
  getStatus: (ast: SchemaAST.AST) => number
): ReadonlyMap<number, [Schema.Top, ...Array<Schema.Top>]> => {
  const map = new Map<number, [Schema.Top, ...Array<Schema.Top>]>()

  schemas.forEach(add)

  return map

  function add(schema: Schema.Top) {
    if (HttpApiSchema.isStreamSchema(schema)) return
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
 * @category services
 * @since 4.0.0
 */
export class AdditionalSchemas extends Context.Service<
  AdditionalSchemas,
  ReadonlyArray<Schema.Constraint>
>()("effect/httpapi/HttpApi/AdditionalSchemas") {}
