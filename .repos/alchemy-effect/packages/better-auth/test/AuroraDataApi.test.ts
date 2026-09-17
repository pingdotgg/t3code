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

describe("AuroraDataApi dialect", () => {
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
});
