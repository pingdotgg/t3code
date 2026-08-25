import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { InvestigationGroup } from "./InvestigationGroup.ts";

/**
 * Shared scaffolding for the CloudWatch investigations (AIOps) HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the two builders
 * below. Everything except the operation, the IAM action list, and (for
 * group-scoped ops) how the group's ARN maps onto the request is boilerplate.
 */

/**
 * Build the impl Effect for an AIOps operation scoped to an
 * {@link InvestigationGroup}: the deploy-time half grants `actions` on the
 * bound group's ARN, and the runtime half injects the group's ARN into the
 * request via `input`. All group-scoped AIOps read requests consist solely of
 * the group identifier, so the runtime callable takes no arguments.
 */
export const makeAIOpsGroupHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.AIOps.GetInvestigationGroup`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the investigation group ARN. */
  actions: readonly string[];
  /** Map the bound group's ARN onto the operation's request shape. */
  input: (groupArn: string) => I;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (group: InvestigationGroup) {
      const Arn = yield* group.arn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${group}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [group.arn],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${group.LogicalId})`)(function* () {
        const arn = yield* Arn;
        return yield* op(options.input(arn));
      });
    });
  });

/**
 * Build the impl Effect for an account-level AIOps operation (enumerating
 * the Region's investigation groups). The deploy-time half grants `actions`
 * on `*` — `aiops:ListInvestigationGroups` is a list action that is not
 * scoped to a single group resource.
 */
export const makeAIOpsAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.AIOps.ListInvestigationGroups`. */
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
