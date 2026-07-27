import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { IdMappingWorkflow } from "./IdMappingWorkflow.ts";
import type { MatchingWorkflow } from "./MatchingWorkflow.ts";

/**
 * Shared scaffolding for Entity Resolution HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, makeWorkflowHttpBinding({ … }))` over the builder
 * below. Everything except the operation and the IAM action is boilerplate:
 * all Entity Resolution data-plane operations are scoped to a matching or ID
 * mapping workflow and inject the bound workflow's name as the request's
 * `workflowName` field.
 */
export const makeWorkflowHttpBinding = <
  I extends { workflowName: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.EntityResolution.GetMatchId`. */
  tag: string;
  /** The distilled operation; `workflowName` is injected from the resource. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the workflow ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (
      workflow: MatchingWorkflow | IdMappingWorkflow,
    ) {
      const WorkflowName = yield* workflow.workflowName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${workflow}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [workflow.workflowArn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${workflow.LogicalId})`)(function* (
        request: Omit<I, "workflowName">,
      ) {
        return yield* op({
          ...request,
          workflowName: yield* WorkflowName,
        } as I);
      });
    });
  });
