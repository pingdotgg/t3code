import type { Contract } from "@prisma/orm-postgres/contract/types";
import type { ExtractCodecTypes, SqlStorage } from "@prisma/orm-postgres/family-contract/types";
import type {
  BindSiteParams,
  Declaration,
  ParamsFromDeclaration,
  PreparedExecution,
  PreparedFor,
  PreparedStatement,
  Runtime,
  RuntimeQueryable,
} from "@prisma/orm-postgres/family-runtime";
import type { CodecTypesBase } from "@prisma/orm-postgres/relational-core/expression";
import type { SqlQueryPlan } from "@prisma/orm-postgres/relational-core/plan";
import type { PostgresStaticContext } from "@prisma/orm-postgres/static";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { type ClientError, wrapPrismaError } from "./Errors.ts";
import type { QueryResult } from "./OrmClient.ts";

type QueryOptions<Params, Row> = Parameters<PreparedStatement<Params, Row>["query"]>[2];
type ExecutionOptions<Params> = Parameters<PreparedExecution<Params>["execute"]>[2];

/** A reusable native statement with Effect and Stream consumption. */
export interface PreparedQuery<Params, Row, E = never, R = never> extends Omit<
  PreparedStatement<Params, Row>,
  "query"
> {
  query(params: Params, options?: QueryOptions<Params, Row>): QueryResult<Row, E, R>;
}

/** A prepared mutation that reports statistics rather than rows. */
export interface PreparedMutation<Params, E = never, R = never> extends Omit<
  PreparedExecution<Params>,
  "execute"
> {
  execute(
    params: Params,
    options?: ExecutionOptions<Params>,
  ): Effect.Effect<Awaited<ReturnType<PreparedExecution<Params>["execute"]>>, E, R>;
}

export type Prepared<Params, Row, E = never, R = never> =
  PreparedFor<Params, Row> extends PreparedStatement<Params, Row>
    ? PreparedQuery<Params, Row, E, R>
    : PreparedMutation<Params, E, R>;

export interface Prepare<C extends Contract<SqlStorage>, E = never, R = never> {
  <D extends Declaration<CT>, Row, CT extends CodecTypesBase = ExtractCodecTypes<C>>(
    declaration: D,
    build: (sql: PostgresStaticContext<C>["sql"], params: BindSiteParams<D>) => SqlQueryPlan<Row>,
  ): Effect.Effect<
    Prepared<ParamsFromDeclaration<D, CT>, Row, ClientError | E, R>,
    ClientError | E,
    R
  >;
}

export const makePrepare =
  <C extends Contract<SqlStorage>, E, R>(
    runtime: Effect.Effect<Runtime, E, R>,
    sql: PostgresStaticContext<C>["sql"],
    queryTarget: Effect.Effect<RuntimeQueryable, E, R> = runtime,
  ): Prepare<C, E, R> =>
  <D extends Declaration<CT>, Row, CT extends CodecTypesBase = ExtractCodecTypes<C>>(
    declaration: D,
    build: (sql: PostgresStaticContext<C>["sql"], params: BindSiteParams<D>) => SqlQueryPlan<Row>,
  ) =>
    Effect.gen(function* () {
      const target = yield* runtime;
      const statement = yield* Effect.tryPromise({
        try: () => target.prepare<D, Row, CT>(declaration, (params) => build(sql, params)),
        catch: wrapPrismaError,
      });
      type Params = ParamsFromDeclaration<D, CT>;
      const metadata = {
        sql: statement.sql,
        ast: statement.ast,
        meta: statement.meta,
        slots: statement.slots,
      };
      const result =
        "query" in statement
          ? {
              ...metadata,
              query: (params: Params, options?: QueryOptions<Params, Row>) =>
                Object.assign(
                  Effect.flatMap(queryTarget, (current) =>
                    Effect.tryPromise({
                      try: (signal) =>
                        statement.query(current, params, { ...options, signal }).toArray(),
                      catch: wrapPrismaError,
                    }),
                  ),
                  {
                    stream: Stream.unwrap(
                      Effect.flatMap(queryTarget, (current) =>
                        Effect.try({
                          try: () =>
                            Stream.fromAsyncIterable(
                              statement.query(current, params, options),
                              wrapPrismaError,
                            ),
                          catch: wrapPrismaError,
                        }),
                      ),
                    ),
                  },
                ),
            }
          : {
              ...metadata,
              execute: (params: Params, options?: ExecutionOptions<Params>) =>
                Effect.flatMap(queryTarget, (current) =>
                  Effect.tryPromise({
                    try: (signal) =>
                      statement.execute(current, params, {
                        ...options,
                        signal,
                      }),
                    catch: wrapPrismaError,
                  }),
                ),
            };
      // Prisma selects the consumption method from the plan's affected-count brand.
      return result as Prepared<Params, Row, ClientError | E, R>;
    });
