import * as athena from "@distilled.cloud/aws/athena";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface NamedQueryProps {
  /**
   * Display name of the saved query. If omitted, a unique name is generated.
   * Up to 128 characters.
   */
  name?: string;
  /**
   * The SQL text of the saved query.
   */
  queryString: string;
  /**
   * Glue/Athena database the query runs against. Changing this replaces the
   * named query (Athena cannot re-point a saved query's database in place).
   */
  database: string;
  /**
   * Optional human-readable description.
   */
  description?: string;
  /**
   * Workgroup the query is saved in. Changing this replaces the named query.
   * @default "primary"
   */
  workGroup?: string;
}

export interface NamedQuery extends Resource<
  "AWS.Athena.NamedQuery",
  NamedQueryProps,
  {
    /**
     * Unique ID of the named query.
     */
    namedQueryId: string;
    /**
     * Name of the saved query.
     */
    name: string;
    /**
     * The saved SQL statement.
     */
    queryString: string;
    /**
     * Database the query runs against.
     */
    database: string;
    /**
     * Description of the query.
     */
    description: string | undefined;
    /**
     * Workgroup the query is saved in.
     */
    workGroup: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon Athena named (saved) query — a reusable SQL statement stored
 * against a Glue database inside a workgroup. Its identity is the
 * server-assigned `NamedQueryId`; the `name`, `description`, and `queryString`
 * are updatable in place, while changing `database` or `workGroup` replaces it.
 *
 * @resource
 * @section Saving Queries
 * @example Save a query against a Glue database
 * ```typescript
 * const query = yield* AWS.Athena.NamedQuery("TopCustomers", {
 *   database: "analytics",
 *   queryString: "SELECT customer_id, SUM(amount) AS total " +
 *     "FROM orders GROUP BY customer_id ORDER BY total DESC LIMIT 10",
 *   workGroup: wg.workGroupName,
 * });
 * ```
 */
export const NamedQuery = Resource<NamedQuery>("AWS.Athena.NamedQuery");

const toAttributes = (nq: athena.NamedQuery) => ({
  namedQueryId: nq.NamedQueryId!,
  name: nq.Name,
  queryString: nq.QueryString,
  database: nq.Database,
  description: nq.Description,
  workGroup: nq.WorkGroup ?? "primary",
});

export const NamedQueryProvider = () =>
  Provider.effect(
    NamedQuery,
    Effect.gen(function* () {
      const toName = (id: string, props: NamedQueryProps) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 128 });

      // Deterministic per-instance idempotency token so a create that crashes
      // before state persists re-returns the SAME NamedQueryId on re-run
      // instead of creating a duplicate saved query.
      const toToken = (id: string) =>
        createPhysicalName({ id, maxLength: 90 }).pipe(
          Effect.map((n) => `${n}-alchemy-namedquery-idempotency`),
        );

      const getOne = (namedQueryId: string) =>
        athena.getNamedQuery({ NamedQueryId: namedQueryId }).pipe(
          Effect.map((res) => res.NamedQuery),
          Effect.catchTag("NamedQueryNotFound", () =>
            Effect.succeed(undefined),
          ),
        );

      return {
        stables: ["namedQueryId"],
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return;
          if ((olds?.database ?? undefined) !== news.database) {
            return { action: "replace" } as const;
          }
          if (
            (olds?.workGroup ?? "primary") !== (news.workGroup ?? "primary")
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          // Named queries have no deterministic name-based lookup — identity is
          // the server-assigned id. Without a cached id there's nothing to read.
          if (!output?.namedQueryId) return undefined;
          const nq = yield* getOne(output.namedQueryId);
          return nq ? toAttributes(nq) : undefined;
        }),
        list: () =>
          Effect.gen(function* () {
            const wgPages = yield* athena.listWorkGroups
              .pages({})
              .pipe(Stream.runCollect);
            const workGroups = Array.from(wgPages)
              .flatMap((page) => page.WorkGroups ?? [])
              .flatMap((wg) => (wg.Name ? [wg.Name] : []));
            const attrs: ReturnType<typeof toAttributes>[] = [];
            for (const wg of workGroups) {
              const idPages = yield* athena.listNamedQueries
                .pages({ WorkGroup: wg })
                .pipe(Stream.runCollect);
              const ids = Array.from(idPages).flatMap(
                (page) => page.NamedQueryIds ?? [],
              );
              for (let i = 0; i < ids.length; i += 50) {
                const res = yield* athena.batchGetNamedQuery({
                  NamedQueryIds: ids.slice(i, i + 50),
                });
                for (const nq of res.NamedQueries ?? []) {
                  if (nq.NamedQueryId) attrs.push(toAttributes(nq));
                }
              }
            }
            return attrs;
          }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* toName(id, news);
          const workGroup = news.workGroup ?? "primary";

          // Observe — cloud state (by cached id) is authoritative.
          let nq = output?.namedQueryId
            ? yield* getOne(output.namedQueryId)
            : undefined;

          if (nq) {
            // Sync — Name/Description/QueryString are updatable in place.
            if (
              nq.Name !== name ||
              nq.Description !== news.description ||
              nq.QueryString !== news.queryString
            ) {
              yield* athena.updateNamedQuery({
                NamedQueryId: nq.NamedQueryId!,
                Name: name,
                Description: news.description,
                QueryString: news.queryString,
              });
            }
          } else {
            // Ensure — create with a deterministic idempotency token.
            const token = yield* toToken(id);
            const created = yield* athena.createNamedQuery({
              Name: name,
              Description: news.description,
              Database: news.database,
              QueryString: news.queryString,
              WorkGroup: workGroup,
              ClientRequestToken: token,
            });
            nq = yield* getOne(created.NamedQueryId!);
          }

          if (!nq?.NamedQueryId) {
            return yield* Effect.die(
              new Error(`NamedQuery ${name} did not materialize`),
            );
          }

          yield* session.note(nq.NamedQueryId);
          return toAttributes(nq);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* athena
            .deleteNamedQuery({ NamedQueryId: output.namedQueryId })
            .pipe(Effect.catchTag("NamedQueryNotFound", () => Effect.void));
        }),
      };
    }),
  );
