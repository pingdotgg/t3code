import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { ServiceLevelObjective } from "./ServiceLevelObjective.ts";

/**
 * Shared scaffolding for Application Signals HTTP bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the builders
 * below. Everything except the operation, the IAM action list, and (for
 * SLO-scoped operations) the injected identifier is boilerplate.
 */

/**
 * Build the impl Effect for an account-level operation (the service
 * discovery, audit, and change-event read APIs). The deploy-time half
 * grants `actions` on `*` because the Application Signals discovery
 * actions do not support resource-level scoping.
 */
export const makeApplicationSignalsAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.ApplicationSignals.ListServices`. */
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

/**
 * Build the impl Effect for an SLO-scoped operation taking a single `Id`
 * (`GetServiceLevelObjective`, `ListServiceLevelObjectiveExclusionWindows`):
 * the runtime callable injects the bound SLO's ARN as `Id` and the
 * deploy-time half grants `actions` on the SLO ARN.
 */
export const makeSloIdHttpBinding = <
  I extends { Id: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag. */
  tag: string;
  /** The distilled operation; `Id` is injected from the SLO. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the SLO ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (slo: ServiceLevelObjective) {
      const SloArn = yield* slo.sloArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${slo}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [Output.interpolate`${slo.sloArn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${slo.LogicalId})`)(function* (
        request?: Omit<I, "Id">,
      ) {
        return yield* op({
          ...request,
          Id: yield* SloArn,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for a batch SLO operation taking `SloIds`
 * (`BatchGetServiceLevelObjectiveBudgetReport`,
 * `BatchUpdateExclusionWindows`), narrowed to the single bound SLO: the
 * runtime callable injects `SloIds: [sloArn]` and the deploy-time half
 * grants `actions` on the SLO ARN.
 */
export const makeSloBatchHttpBinding = <
  I extends { SloIds: string[] },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag. */
  tag: string;
  /** The distilled operation; `SloIds` is injected from the SLO. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the SLO ARN. */
  actions: readonly string[];
  /**
   * Additional IAM actions granted on `*` — dependent permissions the
   * operation exercises with the caller's credentials (e.g. budget reports
   * read the SLI metric via `cloudwatch:GetMetricData`).
   */
  accountActions?: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (slo: ServiceLevelObjective) {
      const SloArn = yield* slo.sloArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${slo}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [Output.interpolate`${slo.sloArn}`],
              },
              ...(options.accountActions?.length
                ? [
                    {
                      Effect: "Allow" as const,
                      Action: [...options.accountActions],
                      Resource: ["*"],
                    },
                  ]
                : []),
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${slo.LogicalId})`)(function* (
        request: Omit<I, "SloIds">,
      ) {
        return yield* op({
          ...request,
          SloIds: [yield* SloArn],
        } as I);
      });
    });
  });
