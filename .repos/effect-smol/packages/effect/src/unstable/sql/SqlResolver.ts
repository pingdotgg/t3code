/**
 * Schema-aware `RequestResolver` helpers for SQL-backed data loading.
 *
 * This module bridges `Effect.request` with `SqlClient` by representing each
 * lookup or mutation as a `SqlRequest` and batching concurrent requests into a
 * single SQL operation. Request payloads are encoded with the request schema
 * before `execute` is called, and rows returned by the query are decoded with
 * the result schema before entries are completed.
 *
 * Use `ordered` when a query returns exactly one row per request in the same
 * order, `findById` for `where id in (...)` lookups, `grouped` for one-to-many
 * relationships, and `void` for inserts, updates, deletes, or other
 * side-effecting statements where no row is needed.
 *
 * **Gotchas**
 *
 * - `ordered` requires the result count and order to match the request batch.
 * - `grouped` and `findById` rely on stable request/result keys and fail
 *   missing requests with `NoSuchElementError`.
 * - Equal payloads are equal `SqlRequest`s, which enables request batching,
 *   deduplication, and cache reuse; model payload identity deliberately.
 * - Batches are split by the active SQL transaction connection, so requests
 *   made in different transactions are not resolved together.
 * - Queries like `where id in (...)` often return rows in database order; use
 *   `findById` or `grouped`, or preserve input order explicitly before choosing
 *   `ordered`.
 *
 * @since 4.0.0
 */
import * as Arr from "../../Array.ts"
import * as Cause from "../../Cause.ts"
import * as Effect from "../../Effect.ts"
import * as Equal from "../../Equal.ts"
import * as Exit from "../../Exit.ts"
import * as Hash from "../../Hash.ts"
import * as MutableHashMap from "../../MutableHashMap.ts"
import * as Request from "../../Request.ts"
import * as RequestResolver from "../../RequestResolver.ts"
import * as Schema from "../../Schema.ts"
import type * as Types from "../../Types.ts"
import * as SqlClient from "./SqlClient.ts"
import { ResultLengthMismatch } from "./SqlError.ts"

/**
 * Request type used by SQL request resolvers, carrying the input payload
 * together with the resolver's result, error, and environment types.
 *
 * @category requests
 * @since 4.0.0
 */
export interface SqlRequest<In, A, E, R> extends Request.Request<A, E | Schema.SchemaError, R> {
  readonly payload: In
}

const SqlRequestProto = {
  ...Request.Class.prototype,
  [Equal.symbol](
    this: SqlRequest<any, any, any, any>,
    that: SqlRequest<any, any, any, any>
  ): boolean {
    return Equal.equals(this.payload, that.payload)
  },
  [Hash.symbol](this: SqlRequest<any, any, any, any>): number {
    return Hash.hash(this.payload)
  }
}

/**
 * Runs a payload as a `SqlRequest` through a request resolver, either directly
 * with a payload and resolver or curried by resolver.
 *
 * @category requests
 * @since 4.0.0
 */
export const request: {
  <In, A, E, R>(
    resolver: RequestResolver.RequestResolver<SqlRequest<In, A, E, R>>
  ): (payload: In) => Effect.Effect<A, E | Schema.SchemaError, R>
  <In, A, E, R>(
    payload: In,
    resolver: RequestResolver.RequestResolver<SqlRequest<In, A, E, R>>
  ): Effect.Effect<A, E | Schema.SchemaError, R>
} = function() {
  if (arguments.length === 1) {
    const resolver = arguments[0]
    return (payload: any) => Effect.request(SqlRequest(payload), resolver)
  }
  return Effect.request(SqlRequest(arguments[0]), arguments[1])
} as any

/**
 * Constructs a `SqlRequest` from a payload. Equality and hashing are based on
 * the payload so equal requests can be batched and deduplicated.
 *
 * @category requests
 * @since 4.0.0
 */
export const SqlRequest = <In, A, E, R>(payload: In): SqlRequest<In, A, E, R> => {
  const self = Object.create(SqlRequestProto)
  self.payload = payload
  return self
}

/**
 * Creates a resolver for a SQL query with a request schema and a result schema.
 *
 * **Details**
 *
 * The request schema is used to validate the input of the query, and the result
 * schema is used to validate the output of the query. Results are mapped to the
 * requests in order, so the length of the results must match the length of the
 * requests.
 *
 * @category resolvers
 * @since 4.0.0
 */
export const ordered = <Req extends Schema.Top, Res extends Schema.Top, _, E, R>(
  options: {
    readonly Request: Req
    readonly Result: Res
    readonly execute: (
      requests: Arr.NonEmptyArray<Req["Encoded"]>
    ) => Effect.Effect<ReadonlyArray<_>, E, R>
  }
): RequestResolver.RequestResolver<
  SqlRequest<Req["Type"], Res["Type"], E | ResultLengthMismatch, Req["EncodingServices"] | Res["DecodingServices"] | R>
> => {
  const decodeArray = Schema.decodeUnknownEffect(Schema.Array(options.Result))
  return RequestResolver.makeGrouped<
    SqlRequest<
      Req["Type"],
      Res["Type"],
      E | ResultLengthMismatch,
      Req["EncodingServices"] | Res["DecodingServices"] | R
    >,
    SqlClient.TransactionConnection.Service | undefined
  >({
    key: transactionKey,
    resolver: Effect.fnUntraced(function*(entries) {
      const inputs = yield* partitionRequests(entries, options.Request)
      const results = yield* options.execute(inputs as any).pipe(
        Effect.provideContext(entries[0].context)
      )
      if (results.length !== inputs.length) {
        return yield* new ResultLengthMismatch({ expected: inputs.length, actual: results.length })
      }
      const decodedResults = yield* decodeArray(results).pipe(
        Effect.provideContext(entries[0].context)
      )
      for (let i = 0; i < entries.length; i++) {
        entries[i].completeUnsafe(Exit.succeed(decodedResults[i]))
      }
    })
  })
}

/**
 * Creates a batched SQL request resolver that encodes requests, decodes result
 * rows, groups decoded results by matching request and result keys, and fails a
 * request with `NoSuchElementError` when no result group exists.
 *
 * @category resolvers
 * @since 4.0.0
 */
export const grouped = <Req extends Schema.Top, Res extends Schema.Top, K, Row, E, R>(
  options: {
    readonly Request: Req
    readonly RequestGroupKey: (request: Req["Type"]) => K
    readonly Result: Res
    readonly ResultGroupKey: (result: Res["Type"], row: Types.NoInfer<Row>) => K
    readonly execute: (
      requests: Arr.NonEmptyArray<Req["Encoded"]>
    ) => Effect.Effect<ReadonlyArray<Row>, E, R>
  }
): RequestResolver.RequestResolver<
  SqlRequest<
    Req["Type"],
    Arr.NonEmptyArray<Res["Type"]>,
    E | Schema.SchemaError | Cause.NoSuchElementError,
    Req["EncodingServices"] | Res["DecodingServices"] | R
  >
> => {
  const decodeResults = Schema.decodeUnknownEffect(Schema.Array(options.Result))

  return RequestResolver.makeGrouped<
    SqlRequest<
      Req["Type"],
      Arr.NonEmptyArray<Res["Type"]>,
      E | Schema.SchemaError | Cause.NoSuchElementError,
      Req["EncodingServices"] | Res["DecodingServices"] | R
    >,
    SqlClient.TransactionConnection.Service | undefined
  >({
    key: transactionKey,
    resolver: Effect.fnUntraced(function*(entries) {
      const inputs = yield* partitionRequests(entries, options.Request)
      const resultMap = MutableHashMap.empty<K, Arr.NonEmptyArray<Res["Type"]>>()
      const results = yield* options.execute(inputs as any).pipe(
        Effect.provideContext(entries[0].context)
      )
      const decodedResults = yield* decodeResults(results).pipe(
        Effect.provideContext(entries[0].context)
      )
      for (let i = 0, len = decodedResults.length; i < len; i++) {
        const result = decodedResults[i]
        const key = options.ResultGroupKey(result, results[i])
        const group = MutableHashMap.get(resultMap, key)
        if (group._tag === "None") {
          MutableHashMap.set(resultMap, key, [result])
        } else {
          group.value.push(result)
        }
      }
      for (let i = 0, len = entries.length; i < len; i++) {
        const entry = entries[i]
        const key = options.RequestGroupKey(entry.request.payload)
        const result = MutableHashMap.get(resultMap, key)
        entry.completeUnsafe(
          result._tag === "None" ? constNoSuchElement : Exit.succeed(result.value)
        )
      }
    })
  })
}

/**
 * Creates a batched resolver that fetches rows for encoded ids, decodes
 * results, completes each matching request using `ResultId`, and fails missing
 * ids with `NoSuchElementError`.
 *
 * @category resolvers
 * @since 4.0.0
 */
export const findById = <Id extends Schema.Top, Res extends Schema.Top, Row, E, R>(
  options: {
    readonly Id: Id
    readonly Result: Res
    readonly ResultId: (result: Res["Type"], row: Types.NoInfer<Row>) => Id["Type"]
    readonly execute: (
      requests: Arr.NonEmptyArray<Id["Encoded"]>
    ) => Effect.Effect<ReadonlyArray<Row>, E, R>
  }
): RequestResolver.RequestResolver<
  SqlRequest<
    Id["Type"],
    Res["Type"],
    E | Schema.SchemaError | Cause.NoSuchElementError,
    Id["EncodingServices"] | Res["DecodingServices"] | R
  >
> => {
  const decodeResults = Schema.decodeUnknownEffect(Schema.Array(options.Result))

  return RequestResolver.makeGrouped<
    SqlRequest<
      Id["Type"],
      Res["Type"],
      E | Schema.SchemaError | Cause.NoSuchElementError,
      Id["EncodingServices"] | Res["DecodingServices"] | R
    >,
    SqlClient.TransactionConnection.Service | undefined
  >({
    key: transactionKey,
    resolver: Effect.fnUntraced(function*(entries) {
      const [inputs, idMap] = yield* partitionRequestsById(entries, options.Id)
      const results = yield* options.execute(inputs as any).pipe(
        Effect.provideContext(entries[0].context)
      )
      const decodedResults = yield* decodeResults(results).pipe(
        Effect.provideContext(entries[0].context)
      )
      for (let i = 0; i < decodedResults.length; i++) {
        const result = decodedResults[i]
        const id = options.ResultId(result, results[i])
        const request = MutableHashMap.get(idMap, id)
        if (request._tag === "None") {
          continue
        }
        MutableHashMap.remove(idMap, id)
        request.value.completeUnsafe(Exit.succeed(result))
      }
      if (MutableHashMap.isEmpty(idMap)) {
        return
      }
      MutableHashMap.forEach(idMap, (request) => {
        request.completeUnsafe(constNoSuchElement)
      })
    })
  })
}

const void_ = <Req extends Schema.Top, _, E, R>(
  options: {
    readonly Request: Req
    readonly execute: (
      requests: Arr.NonEmptyArray<Req["Encoded"]>
    ) => Effect.Effect<ReadonlyArray<_>, E, R>
  }
): RequestResolver.RequestResolver<
  SqlRequest<
    Req["Type"],
    void,
    E | Schema.SchemaError,
    Req["EncodingServices"] | R
  >
> =>
  RequestResolver.makeGrouped<
    SqlRequest<
      Req["Type"],
      void,
      E | Schema.SchemaError,
      Req["EncodingServices"] | R
    >,
    SqlClient.TransactionConnection.Service | undefined
  >({
    key: transactionKey,
    resolver: Effect.fnUntraced(function*(entries) {
      const inputs = yield* partitionRequests(entries, options.Request)
      yield* options.execute(inputs as any).pipe(
        Effect.provideContext(entries[0].context)
      )
      for (let i = 0; i < entries.length; i++) {
        entries[i].completeUnsafe(Exit.void)
      }
    })
  })

export {
  /**
   * Create a resolver that performs side effects.
   *
   * @category resolvers
   * @since 4.0.0
   */
  void_ as void
}

const constNoSuchElement = Exit.fail(new Cause.NoSuchElementError())

const partitionRequests = function*<In, A, E, R, InE>(
  requests: Arr.NonEmptyArray<Request.Entry<SqlRequest<In, A, E, R>>>,
  schema: Schema.Codec<In, InE, R, R>
) {
  const len = requests.length
  const inputs = Arr.empty<InE>()
  let entry!: Request.Entry<SqlRequest<In, A, E, R>>
  const encode = Schema.encodeEffect(schema)
  const handle = Effect.matchCauseEager({
    onFailure(cause: Cause.Cause<Schema.SchemaError>) {
      entry.completeUnsafe(Exit.failCause(cause))
    },
    onSuccess(value: InE) {
      inputs.push(value)
    }
  })

  for (let i = 0; i < len; i++) {
    entry = requests[i]
    yield (Effect.provideContext(handle(encode(entry.request.payload)), entry.context) as Effect.Effect<void>)
  }

  return inputs
}

const partitionRequestsById = function*<In, A, E, R, InE>(
  requests: ReadonlyArray<Request.Entry<SqlRequest<In, A, E, R>>>,
  schema: Schema.Codec<In, InE, R, R>
) {
  const len = requests.length
  const inputs = Arr.empty<InE>()
  const byIdMap = MutableHashMap.empty<In, Request.Entry<SqlRequest<In, A, E, R>>>()
  let entry!: Request.Entry<SqlRequest<In, A, E, R>>
  const encode = Schema.encodeEffect(schema)
  const handle = Effect.matchCauseEager({
    onFailure(cause: Cause.Cause<Schema.SchemaError>) {
      entry.completeUnsafe(Exit.failCause(cause))
    },
    onSuccess(value: InE) {
      inputs.push(value)
    }
  })

  for (let i = 0; i < len; i++) {
    entry = requests[i]
    yield (Effect.provideContext(handle(encode(entry.request.payload)), entry.context) as Effect.Effect<void>)
    MutableHashMap.set(byIdMap, entry.request.payload, entry)
  }

  return [inputs, byIdMap] as const
}

function transactionKey<A>(entry: Request.Entry<A>): SqlClient.TransactionConnection.Service | undefined {
  const client = entry.context.mapUnsafe.get(SqlClient.SqlClient.key)
  if (!client) return undefined
  const conn = entry.context.mapUnsafe.get(client.transactionService.key)
  if (!conn) return undefined
  return Equal.byReferenceUnsafe(conn)
}
