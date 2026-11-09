import type { Input } from "alchemy/Input";
import type * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as AWSBindings from "../AWSBindings.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import { regionFromArn } from "../Lambda/BindingHttp.ts";
import type { Table } from "./Table.ts";

/**
 * Shared scaffolding for AWS DynamoDB HTTP bindings.
 *
 * NOT exported from `index.ts` — every near-identical `{Op}Http.ts` in this
 * service is a thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of
 * the builders below. Everything except the operation, the IAM action list,
 * and the granted ARNs is boilerplate. Genuinely-different bindings
 * (multi-table batches/transactions, restores, the batched sink) stay
 * bespoke but share {@link grantTables} / {@link tablesRegion}.
 *
 * Every binding works on any host (see `AWSBindings.ts`):
 *
 * - on a host that runs as an IAM role the deploy-time grant goes on that
 *   role and requests use the ambient `Credentials` / `Region`;
 * - on any other host the grant goes on the Role Alchemy creates for it, and
 *   each operation is resolved with `AWSBindings.withCredentials` to sign
 *   with that Role in the bound table's region (parsed from its ARN).
 */

/**
 * Grant the host `policyStatements` under `label`, recorded as
 * `Allow(<host>, <label>)` (see `AWSBindings.Bind`). Deploy-only: the grant
 * sits behind the `__ALCHEMY_RUNTIME__` guard so the bundler drops it.
 */
export const GrantTables = Effect.gen(function* () {
  const bind = yield* AWSBindings.Bind;
  return Effect.fn(function* (label: string, policyStatements: () => Input<PolicyStatement>[]) {
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      yield* bind`${label}`({ policyStatements: policyStatements() });
    }
  });
});

/**
 * The region a host with a created key signs requests in, for
 * `AWSBindings.withCredentials`: the region of the bound tables, parsed from
 * their ARNs (which this binds onto the host). Tables bound together must
 * share one region.
 *
 * The ARN is used rather than `Table.region` because tables whose state
 * predates that attribute keep their old attributes until their next update.
 */
export const tablesRegion = Effect.fn(function* (tables: readonly Table[]) {
  const arns: Effect.Effect<string>[] = [];
  for (const table of tables) {
    arns.push(yield* table.tableArn);
  }
  return Effect.gen(function* () {
    const regions = [...new Set((yield* Effect.all(arns)).map(regionFromArn))];
    if (regions.length !== 1) {
      return yield* Effect.die(
        new Error(
          `DynamoDB tables bound together must share one AWS region, got: ${regions.join(", ")}`,
        ),
      );
    }
    return regions[0]!;
  });
});

/**
 * Build the impl Effect for an account-level operation (`ListTables`,
 * `DescribeLimits`): the runtime callable passes the caller's request
 * through unchanged and the deploy-time half grants `actions` on `*`
 * (these DynamoDB actions do not support resource-level permissions).
 */
export const makeAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.DynamoDB.ListTables`. */
  tag: string;
  /**
   * The distilled operation, invoked with the caller's request as-is.
   * Resolved with the host's credentials (see `AWSBindings.withCredentials`),
   * signing in the stack's region on a host with a created key.
   */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*`. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const grantTables = yield* GrantTables;
    const op = yield* AWSBindings.withCredentials(options.operation);

    return Effect.fn(function* () {
      yield* grantTables(`${options.tag}()`, () => [
        {
          Effect: "Allow",
          Action: [...options.actions],
          Resource: ["*"],
        },
      ]);
      return Effect.fn(options.tag)(function* (request?: I) {
        return yield* op((request ?? {}) as I);
      });
    });
  });

/**
 * Build the impl Effect for a table-scoped operation: the runtime callable
 * injects the bound {@link Table}'s physical name as `TableName` and the
 * deploy-time half grants `actions` on `resources` (default: the table ARN).
 */
export const makeTableHttpBinding = <I extends { TableName?: string }, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.DynamoDB.GetItem`. */
  tag: string;
  /**
   * The distilled operation; `TableName` is injected from the table.
   * Resolved with the host's credentials (see `AWSBindings.withCredentials`),
   * signing in the table's region on a host with a created key.
   */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `resources`. */
  actions: readonly string[];
  /** ARNs the actions are granted on. @default the table ARN */
  resources?: (table: Table) => (string | Output.Output<string>)[];
}) =>
  Effect.gen(function* () {
    const grantTables = yield* GrantTables;
    return Effect.fn(function* (table: Table) {
      const TableName = yield* table.tableName;
      // resolved per bind because a host with a created key signs in the table's own region
      const op = yield* AWSBindings.withCredentials(options.operation, tablesRegion([table]));
      yield* grantTables(`${options.tag}(${table.LogicalId})`, () => [
        {
          Effect: "Allow",
          Action: [...options.actions],
          Resource: options.resources?.(table) ?? [table.tableArn],
        },
      ]);
      return Effect.fn(`${options.tag}(${table.LogicalId})`)(function* (
        request?: Omit<I, "TableName">,
      ) {
        return yield* op({
          ...request,
          TableName: yield* TableName,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for an ARN-scoped operation: the runtime callable
 * injects the bound {@link Table}'s ARN under `key` (`ResourceArn` for the
 * tagging APIs, `TableArn` for the export APIs) and the deploy-time half
 * grants `actions` on `resources` (default: the table ARN).
 */
export const makeTableArnHttpBinding = <
  K extends "ResourceArn" | "TableArn",
  I extends { [P in K]?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.DynamoDB.ListTagsOfResource`. */
  tag: string;
  /** The request field the table ARN is injected under. */
  key: K;
  /**
   * The distilled operation; the table ARN is injected under `key`.
   * Resolved with the host's credentials (see `AWSBindings.withCredentials`),
   * signing in the table's region on a host with a created key.
   */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `resources`. */
  actions: readonly string[];
  /** ARNs the actions are granted on. @default the table ARN */
  resources?: (table: Table) => (string | Output.Output<string>)[];
}) =>
  Effect.gen(function* () {
    const grantTables = yield* GrantTables;
    return Effect.fn(function* (table: Table) {
      const TableArn = yield* table.tableArn;
      // resolved per bind because a host with a created key signs in the table's own region
      const op = yield* AWSBindings.withCredentials(
        options.operation,
        Effect.succeed(Effect.map(TableArn, regionFromArn)),
      );
      yield* grantTables(`${options.tag}(${table.LogicalId})`, () => [
        {
          Effect: "Allow",
          Action: [...options.actions],
          Resource: options.resources?.(table) ?? [table.tableArn],
        },
      ]);
      return Effect.fn(`${options.tag}(${table.LogicalId})`)(function* (request?: Omit<I, K>) {
        return yield* op({
          ...request,
          [options.key]: yield* TableArn,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for an operation whose request carries its own
 * identifiers (a PartiQL statement, a backup or export ARN): the bound
 * {@link Table} only scopes the deploy-time IAM grant (and, on an external
 * host, the signing region); the request passes through unchanged.
 */
export const makeTableIamHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.DynamoDB.ExecuteStatement`. */
  tag: string;
  /**
   * The distilled operation, invoked with the caller's request as-is.
   * Resolved with the host's credentials (see `AWSBindings.withCredentials`),
   * signing in the table's region on a host with a created key.
   */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `resources`. */
  actions: readonly string[];
  /** ARNs the actions are granted on. */
  resources: (table: Table) => (string | Output.Output<string>)[];
}) =>
  Effect.gen(function* () {
    const grantTables = yield* GrantTables;
    return Effect.fn(function* (table: Table) {
      // resolved per bind because a host with a created key signs in the table's own region
      const op = yield* AWSBindings.withCredentials(options.operation, tablesRegion([table]));
      yield* grantTables(`${options.tag}(${table.LogicalId})`, () => [
        {
          Effect: "Allow",
          Action: [...options.actions],
          Resource: options.resources(table),
        },
      ]);
      return Effect.fn(`${options.tag}(${table.LogicalId})`)(function* (request: I) {
        return yield* op(request);
      });
    });
  });
