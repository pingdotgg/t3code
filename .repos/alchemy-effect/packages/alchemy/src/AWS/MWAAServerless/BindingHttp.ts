import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Workflow } from "./Workflow.ts";

/**
 * Shared scaffolding for the Amazon MWAA Serverless HTTP bindings.
 *
 * Every MWAA Serverless data-plane operation is addressed by a
 * `WorkflowArn`, so every binding is scoped to a bound {@link Workflow}:
 * the deploy-time half grants `actions` on the workflow's ARN (plus the
 * `{workflowArn}/*` wildcard covering run- and task-scoped sub-resources),
 * and the runtime half injects the workflow's ARN into every request.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, makeMwaaServerlessHttpBinding({ … }))`.
 */
export const makeMwaaServerlessHttpBinding = <
  I extends { WorkflowArn: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.MWAAServerless.StartWorkflowRun`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the workflow ARN (+ `{arn}/*`). */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (workflow: Workflow) {
      // Outputs yield a DEFERRED effect — resolve again per invocation below.
      const WorkflowArn = yield* workflow.workflowArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${workflow}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [
                  workflow.workflowArn,
                  // run/task-scoped operations authorize against
                  // sub-resources below the workflow ARN
                  Output.interpolate`${workflow.workflowArn}/*`,
                ],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${workflow.LogicalId})`)(function* (
        request?: Omit<I, "WorkflowArn">,
      ) {
        return yield* op({
          ...request,
          WorkflowArn: yield* WorkflowArn,
        } as I);
      });
    });
  });
