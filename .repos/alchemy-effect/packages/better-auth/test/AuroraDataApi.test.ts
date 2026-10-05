import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import { makeDataApiDialect, type DataApiExecutor } from "@/AuroraDataApi.ts";

interface Recorded {
  sql: string;
  parameters: unknown[] | undefined;
  transactionId: string | undefined;
}

/** Recording mock of the Data API surface the dialect drives. */
const makeMock = (
  respond: (request: Recorded) => {
    records?: unknown[][];
    columnMetadata?: { label?: string; typeName?: string }[];
    numberOfRecordsUpdated?: number;
  } = () => ({}),
) => {
  const calls: {
    executed: Recorded[];
    begun: number;
    committed: string[];
    rolledBack: string[];
  } = { executed: [], begun: 0, committed: [], rolledBack: [] };
  const executor: DataApiExecutor = {
    execute: async (request) => {
      const recorded: Recorded = {
        sql: request.sql,
        parameters: request.parameters as unknown[] | undefined,
        transactionId: request.transactionId,
      };
      calls.executed.push(recorded);
      return respond(recorded) as never;
    },
    begin: async () => {
      calls.begun += 1;
      return { transactionId: `tx-${calls.begun}` };
    },
    commit: async (transactionId) => {
      calls.committed.push(transactionId);
      return {};
    },
    rollback: async (transactionId) => {
      calls.rolledBack.push(transactionId);
      return {};
    },
  };
  return { executor, calls };
};

const makeDb = (executor: DataApiExecutor) =>
  Effect.gen(function* () {
    const dialect = yield* makeDataApiDialect(executor);
    const { Kysely } = yield* Effect.promise(() => import("kysely"));
    return new Kysely<Record<string, Record<string, unknown>>>({ dialect });
  });

describe(
  "AuroraDataApi dialect",
  { tags: ["unit", "provider:aws", "provider:aws:rdsdata", "local"] },
  () => {
    it.live("compiles postgres SQL with named :n parameters", () =>
      Effect.gen(function* () {
        const { executor, calls } = makeMock();
        const db = yield* makeDb(executor);
        const createdAt = new Date("2026-08-10T12:00:00.000Z");
        yield* Effect.promise(() =>
          db
            .insertInto("user")
            .values({
              id: "u1",
              email: "a@b.co",
              emailVerified: false,
              age: 42,
              createdAt,
            })
            .execute(),
        );
        const call = calls.executed[0]!;
        expect(call.sql).toContain('insert into "user"');
        expect(call.sql).toContain(":1");
        expect(call.sql).toContain(":5");
        expect(call.parameters).toEqual([
          { name: "1", value: { stringValue: "u1" } },
          { name: "2", value: { stringValue: "a@b.co" } },
          { name: "3", value: { booleanValue: false } },
          { name: "4", value: { longValue: 42 } },
          {
            name: "5",
            typeHint: "TIMESTAMP",
            value: { stringValue: "2026-08-10 12:00:00.000" },
          },
        ]);
      }),
    );

    it.live("maps records to rows and revives timestamps as Dates", () =>
      Effect.gen(function* () {
        const { executor } = makeMock(() => ({
          columnMetadata: [
            { label: "id", typeName: "varchar" },
            { label: "createdAt", typeName: "timestamp" },
            { label: "count", typeName: "int8" },
          ],
          records: [
            [
              { stringValue: "u1" },
              { stringValue: "2026-08-10 12:00:00" },
              { longValue: 7 },
            ],
            [{ stringValue: "u2" }, { isNull: true }, { isNull: true }],
          ],
        }));
        const db = yield* makeDb(executor);
        const rows = yield* Effect.promise(() =>
          db.selectFrom("user").selectAll().execute(),
        );
        expect(rows).toHaveLength(2);
        expect(rows[0]!.id).toBe("u1");
        expect(rows[0]!.createdAt).toBeInstanceOf(Date);
        expect((rows[0]!.createdAt as Date).toISOString()).toBe(
          "2026-08-10T12:00:00.000Z",
        );
        expect(rows[0]!.count).toBe(7);
        expect(rows[1]!.createdAt).toBeNull();
      }),
    );

    it.live(
      "preserves schema search paths and other array-valued results",
      () =>
        Effect.gen(function* () {
          const { executor } = makeMock(() => ({
            columnMetadata: [
              { label: "schemas", typeName: "_text" },
              { label: "flags" },
              { label: "integers" },
              { label: "decimals" },
              { label: "nested" },
              { label: "empty" },
            ],
            records: [
              [
                { arrayValue: { stringValues: ["pg_catalog", "public"] } },
                { arrayValue: { booleanValues: [true, false] } },
                { arrayValue: { longValues: [1, 2] } },
                { arrayValue: { doubleValues: [1.5, 2.5] } },
                {
                  arrayValue: {
                    arrayValues: [
                      { longValues: [1, 2] },
                      { longValues: [3, 4] },
                    ],
                  },
                },
                { arrayValue: { stringValues: [] } },
              ],
            ],
          }));
          const db = yield* makeDb(executor);
          const rows = yield* Effect.promise(() =>
            db.selectFrom("metadata").selectAll().execute(),
          );
          expect(rows).toEqual([
            {
              schemas: ["pg_catalog", "public"],
              flags: [true, false],
              integers: [1, 2],
              decimals: [1.5, 2.5],
              nested: [
                [1, 2],
                [3, 4],
              ],
              empty: [],
            },
          ]);
        }),
    );

    it.live(
      "casts catalog table kinds to text during schema introspection",
      () =>
        Effect.gen(function* () {
          const { executor, calls } = makeMock(() => ({
            columnMetadata: [
              { label: "column" },
              { label: "not_null" },
              { label: "has_default" },
              { label: "table" },
              { label: "table_type" },
              { label: "schema" },
              { label: "type" },
              { label: "type_schema" },
              { label: "column_description" },
              { label: "auto_incrementing" },
            ],
            records: [
              [
                { stringValue: "id" },
                { booleanValue: true },
                { booleanValue: false },
                { stringValue: "user" },
                { stringValue: "r" },
                { stringValue: "public" },
                { stringValue: "text" },
                { stringValue: "pg_catalog" },
                { isNull: true },
                { isNull: true },
              ],
            ],
          }));
          const db = yield* makeDb(executor);
          const tables = yield* Effect.promise(() =>
            db.introspection.getTables(),
          );
          expect(calls.executed[0]!.sql).toContain(
            'cast("c"."relkind" as text) as "table_type"',
          );
          expect(tables).toEqual([
            {
              name: "user",
              schema: "public",
              isView: false,
              isForeign: false,
              columns: [
                {
                  name: "id",
                  dataType: "text",
                  dataTypeSchema: "pg_catalog",
                  isNullable: false,
                  hasDefaultValue: false,
                  isAutoIncrementing: false,
                  comment: undefined,
                },
              ],
            },
          ]);
        }),
    );

    it.live("threads transactions through begin/commit", () =>
      Effect.gen(function* () {
        const { executor, calls } = makeMock();
        const db = yield* makeDb(executor);
        yield* Effect.promise(() =>
          db.transaction().execute(async (trx) => {
            await trx.deleteFrom("session").execute();
            await trx.deleteFrom("account").execute();
          }),
        );
        expect(calls.begun).toBe(1);
        expect(calls.executed.map((call) => call.transactionId)).toEqual([
          "tx-1",
          "tx-1",
        ]);
        expect(calls.committed).toEqual(["tx-1"]);
        expect(calls.rolledBack).toEqual([]);
      }),
    );

    it.live("rolls back failed transactions", () =>
      Effect.gen(function* () {
        const { executor, calls } = makeMock();
        const db = yield* makeDb(executor);
        const result = yield* Effect.promise(() =>
          db
            .transaction()
            .execute(async () => {
              throw new Error("boom");
            })
            .then(
              () => "ok",
              () => "failed",
            ),
        );
        expect(result).toBe("failed");
        expect(calls.rolledBack).toEqual(["tx-1"]);
        expect(calls.committed).toEqual([]);
      }),
    );
  },
);
