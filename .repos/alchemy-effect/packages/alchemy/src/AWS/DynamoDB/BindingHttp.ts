import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Output as OutputType } from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Table } from "./Table.ts";

/**
 * Shared scaffolding for AWS DynamoDB HTTP bindings.
 *
 * NOT exported from `index.ts` — every near-identical `{Op}Http.ts` in this
 * service is a thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of
 * the builders below. Everything except the operation, the IAM action list,
 * and the granted ARNs is boilerplate. Genuinely-different bindings
 * (multi-table batches/transactions, restores, the batched sink) stay bespoke.
 */

/**
 * Build the impl Effect for an account-level operation (`ListTables`,
 * `DescribeLimits`): the runtime callable passes the caller's request
 * through unchanged and the deploy-time half grants `actions` on `*`
 * (these DynamoDB actions do not support resource-level permissions).
 */
export const makeAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.DynamoDB.ListTables`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*`. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: ["*"],
              },
            ],
          });
        }
      }
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
export const makeTableHttpBinding = <
  I extends { TableName?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.DynamoDB.GetItem`. */
  tag: string;
  /** The distilled operation; `TableName` is injected from the table. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `resources`. */
  actions: readonly string[];
  /** ARNs the actions are granted on. @default the table ARN */
  resources?: (table: Table) => (string | OutputType<string>)[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (table: Table) {
      const TableName = yield* table.tableName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${table}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: options.resources?.(table) ?? [table.tableArn],
              },
            ],
          });
        }
      }
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
  /** The distilled operation; the table ARN is injected under `key`. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `resources`. */
  actions: readonly string[];
  /** ARNs the actions are granted on. @default the table ARN */
  resources?: (table: Table) => (string | OutputType<string>)[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (table: Table) {
      const TableArn = yield* table.tableArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${table}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: options.resources?.(table) ?? [table.tableArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${table.LogicalId})`)(function* (
        request?: Omit<I, K>,
      ) {
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
 * {@link Table} only scopes the deploy-time IAM grant; the request passes
 * through unchanged.
 */
export const makeTableIamHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.DynamoDB.ExecuteStatement`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `resources`. */
  actions: readonly string[];
  /** ARNs the actions are granted on. */
  resources: (table: Table) => (string | OutputType<string>)[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (table: Table) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${table}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: options.resources(table),
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${table.LogicalId})`)(function* (
        request: I,
      ) {
        return yield* op(request);
      });
    });
  });
