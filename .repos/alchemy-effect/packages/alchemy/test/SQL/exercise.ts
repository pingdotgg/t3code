import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type { UserRow } from "./fixtures/routes.ts";

export class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {}

// Bounded spaced schedule — rides out fresh-workers.dev cold-start
// propagation without blowing past the test timeout.
export const ready = Schedule.max([
  Schedule.spaced("2 seconds"),
  Schedule.recurs(45),
]);

/** Retry an HTTP call until it returns 200. */
export const untilOk = <E, R>(
  eff: Effect.Effect<HttpClientResponse.HttpClientResponse, E, R>,
) =>
  eff.pipe(
    Effect.flatMap((res) =>
      res.status === 200
        ? Effect.succeed(res)
        : res.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(new WorkerNotReady({ status: res.status, body })),
            ),
          ),
    ),
    Effect.retry({
      while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
      schedule: ready,
    }),
  );

export const postJson = (url: string, body: unknown) =>
  untilOk(
    HttpClient.execute(
      HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
    ),
  ).pipe(Effect.flatMap((res) => res.json));

export const putJson = (url: string, body: unknown) =>
  untilOk(
    HttpClient.execute(
      HttpClientRequest.put(url).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
    ),
  ).pipe(Effect.flatMap((res) => res.json));

export const getJson = (url: string) =>
  untilOk(HttpClient.get(url)).pipe(Effect.flatMap((res) => res.json));

/**
 * Drive the dialect-agnostic `SqlClient` surface (the shared routes in
 * `fixtures/routes.ts`) against one deployed worker. Covers, in order:
 *
 * - `sql.unsafe` (raw DDL) — `/init`
 * - the `sql(table)` identifier helper — `/reset` (and every later route)
 * - single-row `sql.insert` nested in an outer template + `sql.and` over
 *   nested fragments — `/users` (the original proxyChain regression)
 * - multi-row `sql.insert` + `sql.literal` — `/users/batch`
 * - `sql.update(row, omit)` — `PUT /users`
 * - `sql.in(column, values)` — `/users/in`
 * - `sql.or` over a nested `sql.and` — `/users/filter`
 * - prefix-form `sql.csv` mixing string and fragment clauses — `/users/ordered`
 * - the generic `SqlClient` service from `SQL.D1Layer` / `SQL.PostgresLayer`
 *   — `/layer/users`
 */
export const exerciseSqlSurface = Effect.fn(function* (base: string) {
  yield* postJson(`${base}/init`, {});
  yield* postJson(`${base}/reset`, {});

  // sql.insert(row) nested in the outer template, read back via sql.and.
  const alice: UserRow = { id: 1, name: "alice", email: "alice@example.com" };
  const created = (yield* postJson(`${base}/users`, alice)) as {
    rows: UserRow[];
  };
  expect(created.rows).toEqual([alice]);

  // sql.insert(rows) multi-row + sql.literal COUNT.
  const bob: UserRow = { id: 2, name: "bob", email: "bob@example.com" };
  const carol: UserRow = { id: 3, name: "carol", email: "carol@example.com" };
  const batch = (yield* postJson(`${base}/users/batch`, [bob, carol])) as {
    count: number;
  };
  expect(batch.count).toBe(3);

  // sql.update(row, ["id"]).
  const alicia: UserRow = {
    id: 1,
    name: "alicia",
    email: "alicia@example.com",
  };
  const updated = (yield* putJson(`${base}/users`, alicia)) as {
    rows: UserRow[];
  };
  expect(updated.rows).toEqual([alicia]);

  // sql.in("id", [2, 3]).
  const within = (yield* getJson(`${base}/users/in?ids=2,3`)) as {
    rows: UserRow[];
  };
  expect(within.rows).toEqual([bob, carol]);

  // sql.or([sql.and([...]), fragment]) — matches bob by name+email AND
  // carol by id.
  const filtered = (yield* getJson(
    `${base}/users/filter?name=${bob.name}&email=${bob.email}&id=${carol.id}`,
  )) as { rows: UserRow[] };
  expect(filtered.rows).toEqual([bob, carol]);

  // sql.csv("ORDER BY", [fragment, "raw string"]).
  const ordered = (yield* getJson(`${base}/users/ordered`)) as {
    rows: Array<{ id: number; name: string }>;
  };
  expect(ordered.rows.map((r) => r.name)).toEqual(["carol", "bob", "alicia"]);

  // SQL.D1Layer / SQL.PostgresLayer — the generic `SqlClient` service reads
  // the same table.
  const viaLayer = (yield* getJson(`${base}/layer/users`)) as {
    rows: UserRow[];
  };
  expect(viaLayer.rows).toEqual([alicia, bob, carol]);
});
