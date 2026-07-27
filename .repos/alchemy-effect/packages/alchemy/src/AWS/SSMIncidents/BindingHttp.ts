import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { ResponsePlan } from "./ResponsePlan.ts";

/**
 * Shared scaffolding for AWS Systems Manager Incident Manager HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the two builders
 * below. Everything except the operation and the IAM action list is
 * boilerplate.
 */

/**
 * Build the impl Effect for an operation scoped to a {@link ResponsePlan}
 * (`StartIncident`): the deploy-time half grants `actions` on the bound
 * response plan's ARN and the runtime half injects the plan's
 * `responsePlanArn` into every request.
 */
export const makeIncidentsResponsePlanHttpBinding = <
  I extends { responsePlanArn: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.SSMIncidents.StartIncident`. */
  tag: string;
  /** The distilled operation; `responsePlanArn` is injected from the plan. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the response plan ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (plan: ResponsePlan) {
      const ResponsePlanArn = yield* plan.arn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${plan}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [plan.arn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${plan.LogicalId})`)(function* (
        request?: Omit<I, "responsePlanArn">,
      ) {
        return yield* op({
          ...request,
          responsePlanArn: yield* ResponsePlanArn,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for an incident-record-plane operation (incident
 * records, timeline events, related items, findings). Incident records are
 * runtime entities — their ARNs embed the response-plan name plus a UUID
 * minted when the incident starts — so there is no deployed resource to
 * scope the grant to and the deploy-time half grants `actions` on `*`. The
 * runtime callable passes the caller's request through unchanged.
 */
export const makeIncidentsAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.SSMIncidents.GetIncidentRecord`. */
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
      return Effect.fn(options.tag)(function* (request: I) {
        return yield* op(request);
      });
    });
  });
