import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Graph } from "./Graph.ts";

/**
 * Shared scaffolding for the AWS NeptuneGraph (Neptune Analytics) HTTP
 * bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the builders
 * below. Everything except the operation, the IAM action list, and the
 * identifier plumbing is boilerplate.
 */

/**
 * Graph snapshot ARNs embed a server-generated id that is only known at
 * runtime, so snapshot-scoped grants use this wildcard.
 */
export const SNAPSHOT_ARN_WILDCARD =
  "arn:aws:neptune-graph:*:*:graph-snapshot/*";

/**
 * Import-task ARNs embed a server-generated task id that is only known at
 * runtime, so import-task-scoped grants use this wildcard.
 */
export const IMPORT_TASK_ARN_WILDCARD =
  "arn:aws:neptune-graph:*:*:import-task/*";

/**
 * Export-task ARNs embed a server-generated task id that is only known at
 * runtime, so export-task-scoped grants use this wildcard.
 */
export const EXPORT_TASK_ARN_WILDCARD =
  "arn:aws:neptune-graph:*:*:export-task/*";

/**
 * `iam:PassRole` restricted to Neptune Analytics — required by the
 * import/export bindings, whose requests hand the service a data-access
 * role (`roleArn`) chosen at runtime.
 */
const passRoleStatement: PolicyStatement = {
  Effect: "Allow",
  Action: ["iam:PassRole"],
  Resource: ["*"],
  Condition: {
    StringEquals: {
      "iam:PassedToService": "neptune-graph.amazonaws.com",
    },
  },
};

/**
 * Build the impl Effect for a graph-scoped operation: the runtime callable
 * injects the bound {@link Graph}'s id as `graphIdentifier` and the
 * deploy-time half grants `actions` on the graph ARN (plus any
 * `extraResources`).
 */
export const makeNeptuneGraphGraphHttpBinding = <
  I extends { graphIdentifier?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.NeptuneGraph.StopGraph`. */
  tag: string;
  /** The distilled operation; `graphIdentifier` is injected from the graph. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the graph ARN. */
  actions: readonly string[];
  /** Static IAM resources granted in addition to the graph ARN. */
  extraResources?: readonly string[];
  /**
   * Grant `iam:PassRole` (conditioned to `neptune-graph.amazonaws.com`) so
   * the function can hand Neptune Analytics the role it assumes to read or
   * write Amazon S3 data. Set on `StartImportTask` / `StartExportTask`.
   */
  passRole?: boolean;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (graph: Graph) {
      const graphId = yield* graph.graphId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${graph}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [
                  Output.interpolate`${graph.graphArn}`,
                  ...(options.extraResources ?? []),
                ],
              },
              ...(options.passRole ? [passRoleStatement] : []),
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${graph.LogicalId})`)(function* (
        request?: Omit<I, "graphIdentifier">,
      ) {
        return yield* op({
          ...request,
          graphIdentifier: yield* graphId,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for an account-level operation (snapshot reads and
 * deletes, import/export task polling and cancellation). The deploy-time
 * half grants `actions` on `resources` (default `*`) — these operations
 * address snapshots and tasks by identifiers that are runtime data.
 */
export const makeNeptuneGraphAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.NeptuneGraph.GetImportTask`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted. */
  actions: readonly string[];
  /**
   * IAM resources the actions are granted on.
   * @default ["*"]
   */
  resources?: readonly string[];
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
                Resource: [...(options.resources ?? ["*"])],
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
