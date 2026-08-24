import * as athena from "@distilled.cloud/aws/athena";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface PreparedStatementProps {
  /**
   * Name of the prepared statement. If omitted, a unique name is generated.
   * Must start with a letter or underscore and contain only letters, digits,
   * and underscores. Changing this replaces the prepared statement.
   */
  statementName?: string;
  /**
   * The SQL statement text, with `?` positional parameters (e.g.
   * `SELECT * FROM t WHERE id = ?`). Updatable in place.
   */
  queryStatement: string;
  /**
   * Workgroup the statement is saved in. Changing this replaces the prepared
   * statement.
   * @default "primary"
   */
  workGroup?: string;
  /**
   * Optional human-readable description. Updatable in place.
   */
  description?: string;
}

export interface PreparedStatement extends Resource<
  "AWS.Athena.PreparedStatement",
  PreparedStatementProps,
  {
    /**
     * Name of the prepared statement (its identity within the workgroup).
     */
    statementName: string;
    /**
     * Workgroup the statement is saved in.
     */
    workGroup: string;
    /**
     * The SQL statement text.
     */
    queryStatement: string;
    /**
     * Description of the prepared statement.
     */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Amazon Athena prepared statement — a named, parameterized SQL statement
 * saved in a workgroup and run with `EXECUTE name USING ...`. Identity is the
 * `(workGroup, statementName)` pair; the `queryStatement` and `description`
 * are updatable in place.
 *
 * @resource
 * @section Preparing Statements
 * @example Save a parameterized statement in a workgroup
 * ```typescript
 * const stmt = yield* AWS.Athena.PreparedStatement("TopN", {
 *   workGroup: wg.workGroupName,
 *   queryStatement: "SELECT * FROM analytics.orders WHERE customer_id = ?",
 * });
 * // then at runtime: EXECUTE <stmt.statementName> USING 'customer-123'
 * ```
 */
export const PreparedStatement = Resource<PreparedStatement>(
  "AWS.Athena.PreparedStatement",
);

const toAttributes = (ps: athena.PreparedStatement) => ({
  statementName: ps.StatementName!,
  workGroup: ps.WorkGroupName ?? "primary",
  queryStatement: ps.QueryStatement ?? "",
  description: ps.Description,
});

export const PreparedStatementProvider = () =>
  Provider.effect(
    PreparedStatement,
    Effect.gen(function* () {
      // Statement names must match [a-zA-Z_][a-zA-Z0-9_@:]* — generate the
      // engine name and fold every other character to `_`.
      const toName = (id: string, props: PreparedStatementProps) =>
        props.statementName
          ? Effect.succeed(props.statementName)
          : createPhysicalName({ id, maxLength: 128 }).pipe(
              Effect.map((n) => n.replace(/[^a-zA-Z0-9_]/g, "_")),
              Effect.map((n) => (/^[a-zA-Z_]/.test(n) ? n : `_${n}`)),
            );

      const getOne = (workGroup: string, statementName: string) =>
        athena
          .getPreparedStatement({
            WorkGroup: workGroup,
            StatementName: statementName,
          })
          .pipe(
            Effect.map((res) => res.PreparedStatement),
            Effect.catchTag(
              ["ResourceNotFoundException", "WorkGroupNotFound"],
              () => Effect.succeed(undefined),
            ),
          );

      return {
        stables: ["statementName", "workGroup"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toName(id, olds ?? { queryStatement: "" })) !==
            (yield* toName(id, news))
          ) {
            return { action: "replace" } as const;
          }
          if (
            (olds?.workGroup ?? "primary") !== (news.workGroup ?? "primary")
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const workGroup = output?.workGroup ?? olds?.workGroup ?? "primary";
          const name =
            output?.statementName ??
            (yield* toName(id, olds ?? { queryStatement: "" }));
          const ps = yield* getOne(workGroup, name);
          return ps ? toAttributes(ps) : undefined;
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
              const namePages = yield* athena.listPreparedStatements
                .pages({ WorkGroup: wg })
                .pipe(Stream.runCollect);
              const names = Array.from(namePages)
                .flatMap((page) => page.PreparedStatements ?? [])
                .flatMap((ps) => (ps.StatementName ? [ps.StatementName] : []));
              for (let i = 0; i < names.length; i += 256) {
                const res = yield* athena.batchGetPreparedStatement({
                  WorkGroup: wg,
                  PreparedStatementNames: names.slice(i, i + 256),
                });
                for (const ps of res.PreparedStatements ?? []) {
                  if (ps.StatementName) {
                    attrs.push(toAttributes({ ...ps, WorkGroupName: wg }));
                  }
                }
              }
            }
            return attrs;
          }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const workGroup = news.workGroup ?? "primary";
          const name = output?.statementName ?? (yield* toName(id, news));

          // Observe — cloud state is authoritative.
          const ps = yield* getOne(workGroup, name);

          if (!ps) {
            // Ensure — create if missing. CreatePreparedStatement upserts on
            // name collision within the workgroup, so a crash-and-retry race
            // converges rather than erroring.
            yield* athena.createPreparedStatement({
              WorkGroup: workGroup,
              StatementName: name,
              QueryStatement: news.queryStatement,
              Description: news.description,
            });
          } else if (
            ps.QueryStatement !== news.queryStatement ||
            (news.description !== undefined &&
              ps.Description !== news.description)
          ) {
            // Sync — statement text and description are updatable in place.
            yield* athena.updatePreparedStatement({
              WorkGroup: workGroup,
              StatementName: name,
              QueryStatement: news.queryStatement,
              Description: news.description,
            });
          }

          yield* session.note(`${workGroup}/${name}`);
          const final = yield* getOne(workGroup, name);
          return final
            ? toAttributes(final)
            : {
                statementName: name,
                workGroup,
                queryStatement: news.queryStatement,
                description: news.description,
              };
        }),
        delete: Effect.fn(function* ({ output }) {
          // Idempotent — the statement (or its whole workgroup) may already be
          // gone; both surface as typed not-found tags.
          yield* athena
            .deletePreparedStatement({
              WorkGroup: output.workGroup,
              StatementName: output.statementName,
            })
            .pipe(
              Effect.catchTag(
                ["ResourceNotFoundException", "WorkGroupNotFound"],
                () => Effect.void,
              ),
            );
        }),
      };
    }),
  );
