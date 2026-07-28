import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Output } from "../../Output.ts";
import type { ResourceLike } from "../../Resource.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import { isBindingHost } from "../Lambda/Function.ts";

/**
 * Shared scaffolding for the Amazon HealthOmics HTTP bindings.
 *
 * Every Omics data-plane operation is either addressed by a store/workflow id
 * (read-set jobs by `sequenceStoreId`, reference jobs by `referenceStoreId`,
 * runs by `workflowId`) or account-level (run control by `runId`, a runtime
 * value). Two builders cover both shapes; every thin `{Op}Http.ts` in this
 * service is a `Layer.effect(Cap, make…HttpBinding({ … }))`.
 *
 * NOT exported from `index.ts` — leaking the generic helper names into the
 * flat `AWS` namespace would collide across services.
 */

/**
 * Build the impl Effect for a resource-scoped operation: the runtime callable
 * injects the bound resource's id under `key` (`sequenceStoreId`,
 * `referenceStoreId`, or `workflowId`) and the deploy-time half grants
 * `actions` on the resource ARN. Operations that hand the service a role to
 * assume (`Start*ImportJob`, `Start*ExportJob`, `StartRun`) set `passRole`.
 */
export const makeOmicsResourceHttpBinding = <
  Res extends ResourceLike,
  K extends string,
  I extends { [P in K]?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Omics.GetReadSet`. */
  tag: string;
  /** The distilled operation; the resource id is injected under `key`. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the resource ARN. */
  actions: readonly string[];
  /** The request field the resource id is injected under. */
  key: K;
  /**
   * Resolve the injected id from the bound resource. `Req` is pinned to
   * `never` (resource attributes are `Output<string, never>`): the default
   * `Output<string>` widens `Req` to `any`, which leaks into the per-resource
   * Effect's requirements and breaks the binding contract's `never`.
   */
  id: (res: Res) => Output<string, never>;
  /** Resolve the ARN the IAM grant targets from the bound resource. */
  arn: (res: Res) => Output<string> | string;
  /** Grant `iam:PassRole` (conditioned to `omics.amazonaws.com`). */
  passRole?: boolean;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (res: Res) {
      // Outputs yield a DEFERRED effect — resolve again per invocation below.
      const Id = yield* options.id(res);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          // Inline (not a `PolicyStatement[]`-typed local) so the bind data's
          // `Input<…>` contextual typing accepts the `Output<string>` ARN.
          yield* host.bind`Allow(${host}, ${options.tag}(${res}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [options.arn(res)],
              },
              ...(options.passRole
                ? ([
                    {
                      Effect: "Allow",
                      Action: ["iam:PassRole"],
                      Resource: ["*"],
                      Condition: {
                        StringEquals: {
                          "iam:PassedToService": "omics.amazonaws.com",
                        },
                      },
                    },
                  ] satisfies PolicyStatement[])
                : []),
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${res.LogicalId})`)(function* (
        request?: Omit<I, K>,
      ) {
        return yield* op({ ...request, [options.key]: yield* Id } as I);
      });
    });
  });

/**
 * Build the impl Effect for an account-level run-control operation
 * (`GetRun`, `ListRuns`, `CancelRun`, `DeleteRun`, `GetRunTask`,
 * `ListRunTasks`): the runtime callable passes the caller's request through
 * unchanged (the `runId` is a runtime value) and the deploy-time half grants
 * `actions` on `*`.
 */
export const makeOmicsAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Omics.GetRun`. */
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
