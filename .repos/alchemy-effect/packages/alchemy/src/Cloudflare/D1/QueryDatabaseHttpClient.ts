import type * as runtime from "@cloudflare/workers-types";
import * as d1 from "@distilled.cloud/cloudflare/d1";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { Credentials } from "../Credentials.ts";
import {
  type QueryDatabaseClient,
  PreparedStatement,
} from "./QueryDatabase.ts";

// Shared HTTP scaffolding for the D1 `QueryDatabase` binding. NOT re-exported
// from `index.ts` — only the contract and the impl layers are public. A future
// token-scoped `QueryDatabaseHttp` layer reuses this builder with an auth
// minted from an `AccountApiToken`; `QueryDatabaseLocal` builds the auth from
// the ambient current-credentials context.
//
// PreparedStatement (shared with QueryDatabaseBinding) drives a
// `runtime.D1Database` whose executors return Promises. The shim below
// implements the slice PreparedStatement uses (prepare/exec/batch + stmt
// bind/all/first/run/raw) by running `d1.queryDatabase` over HTTP.

/**
 * Injectable auth shared by the Local (current-credentials) impl and a future
 * Http (scoped-token) impl. `authorize` discharges the
 * `Credentials | HttpClient` requirement of a distilled op; `accountId` is the
 * Cloudflare account the ops run against.
 */
export interface D1Auth {
  authorize: <A, E>(
    eff: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ) => Effect.Effect<A, E>;
  accountId: string;
}

/**
 * Build a {@link QueryDatabaseClient} over the D1 HTTP query API.
 *
 * `databaseId` is an Effect so the resolution stays deferred to each call —
 * inside an Action it resolves through the apply-time RuntimeContext. The
 * credentials are provided ONLY around the distilled op (via `auth.authorize`),
 * never around the id accessor, matching the KV / Vectorize Local variants.
 */
export const makeHttpQueryDatabaseClient = (
  auth: D1Auth,
  databaseId: Effect.Effect<string>,
): QueryDatabaseClient => {
  const rawEff = Effect.map(databaseId, (id) => makeHttpD1Database(auth, id));

  return {
    raw: rawEff,
    prepare: (query: string) => new PreparedStatement(query, [], rawEff),
    exec: (query: string) =>
      Effect.flatMap(rawEff, (raw) => Effect.promise(() => raw.exec(query))),
    batch: <T = unknown>(statements: PreparedStatement[]) =>
      Effect.flatMap(rawEff, (raw) =>
        Effect.promise(() =>
          raw.batch<T>(statements.map((s) => s._build(raw))),
        ),
      ),
  } satisfies QueryDatabaseClient;
};

const runQuery = (
  auth: D1Auth,
  databaseId: string,
  body:
    | { sql: string; params?: unknown[] }
    | { batch: { sql: string; params?: unknown[] }[] },
): Promise<d1.QueryDatabaseResponse> =>
  auth
    .authorize(
      d1.queryDatabase({
        accountId: auth.accountId,
        databaseId,
        ...(body as any),
      }),
    )
    .pipe(Effect.runPromise);

const toResult = <T>(
  r: d1.QueryDatabaseResponse["result"][number] | undefined,
): runtime.D1Result<T> =>
  ({
    results: (r?.results ?? []) as T[],
    success: r?.success ?? true,
    meta: (r?.meta ?? {}) as any,
  }) as runtime.D1Result<T>;

/**
 * Normalize a bound value the way the native D1 binding does before it reaches
 * SQLite. Over the raw HTTP query API, unlike the Worker binding, values are
 * bound verbatim — a JS `true` would arrive as the string `"true"`. Match the
 * native semantics: booleans become integers (1/0) and binary becomes a byte
 * array (BLOB). `null`, numbers, and strings pass through unchanged.
 */
const normalizeBind = (value: unknown): unknown => {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof ArrayBuffer) {
    return Array.from(new Uint8Array(value));
  }
  if (ArrayBuffer.isView(value)) {
    return Array.from(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }
  return value;
};

const makeHttpD1Database = (
  auth: D1Auth,
  databaseId: string,
): runtime.D1Database => {
  const makeStatement = (
    query: string,
    binds: ReadonlyArray<unknown>,
  ): runtime.D1PreparedStatement => {
    const exec = async () => {
      const res = await runQuery(auth, databaseId, {
        sql: query,
        params: binds.length ? binds.map(normalizeBind) : undefined,
      });
      return res.result[0];
    };
    return {
      bind: (...values: unknown[]) => makeStatement(query, values),
      first: (async (column?: string) => {
        const first = (await exec())?.results?.[0] as
          | Record<string, unknown>
          | undefined;
        if (first == null) return null;
        return column !== undefined ? (first[column] ?? null) : first;
      }) as runtime.D1PreparedStatement["first"],
      all: (async () =>
        toResult(await exec())) as runtime.D1PreparedStatement["all"],
      run: (async () =>
        toResult(await exec())) as runtime.D1PreparedStatement["run"],
      raw: (async (options?: { columnNames?: boolean }) => {
        const rows = ((await exec())?.results ?? []) as Record<
          string,
          unknown
        >[];
        const arrays = rows.map((row) => Object.values(row));
        if (options?.columnNames && rows[0]) {
          return [Object.keys(rows[0]), ...arrays];
        }
        return arrays;
      }) as runtime.D1PreparedStatement["raw"],
      // Carry query + params so `batch` can reconstruct the request.
      __query: query,
      __params: binds,
    } as unknown as runtime.D1PreparedStatement;
  };

  return {
    prepare: (query: string) => makeStatement(query, []),
    exec: async (query: string) => {
      const res = await runQuery(auth, databaseId, { sql: query });
      const meta = res.result[res.result.length - 1]?.meta;
      return {
        count: res.result.length,
        duration: meta?.duration ?? 0,
      } as runtime.D1ExecResult;
    },
    batch: async <T = unknown>(statements: runtime.D1PreparedStatement[]) => {
      const res = await runQuery(auth, databaseId, {
        batch: statements.map((s) => ({
          sql: (s as any).__query as string,
          params: ((s as any).__params as unknown[]).length
            ? ((s as any).__params as unknown[]).map(normalizeBind)
            : undefined,
        })),
      });
      return res.result.map((r) => toResult<T>(r));
    },
  } as unknown as runtime.D1Database;
};
