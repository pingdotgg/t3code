import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Budget } from "./Budget.ts";
import type { BudgetAction } from "./BudgetAction.ts";

/**
 * Shared scaffolding for the AWS Budgets HTTP bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the two
 * builders below. Everything except the operation, the IAM action list, and
 * the injected identifiers (`AccountId` + `BudgetName`, plus `ActionId` for
 * action-scoped operations) is boilerplate.
 *
 * Budgets is a global service — its ARNs have no region component and the
 * endpoint resolver routes every standard-partition region to the global
 * endpoint.
 */

/**
 * Build the impl Effect for a budget-scoped operation: the runtime callable
 * injects the bound {@link Budget}'s `AccountId` and `BudgetName` and the
 * deploy-time half grants `actions` on the budget ARN (or, for budget-action
 * listings, on `budget/{name}/action/*` via `actionWildcard`).
 */
export const makeBudgetHttpBinding = <
  I extends { AccountId: string; BudgetName: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Budgets.DescribeBudget`. */
  tag: string;
  /** The distilled operation; `AccountId`/`BudgetName` are injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the budget ARN. */
  actions: readonly string[];
  /**
   * Grant on `{budgetArn}/action/*` instead of the budget ARN — the
   * budget-action listing operations authorize on the budgetAction resource
   * type, whose IDs are unknowable at deploy time.
   */
  actionWildcard?: boolean;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (budget: Budget) {
      const AccountId = yield* budget.accountId;
      const BudgetName = yield* budget.budgetName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${budget}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [
                  options.actionWildcard
                    ? Output.interpolate`${budget.budgetArn}/action/*`
                    : Output.interpolate`${budget.budgetArn}`,
                ],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${budget.LogicalId})`)(function* (
        request?: Omit<I, "AccountId" | "BudgetName">,
      ) {
        return yield* op({
          ...request,
          AccountId: yield* AccountId,
          BudgetName: yield* BudgetName,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for a budget-action-scoped operation: the runtime
 * callable injects the bound {@link BudgetAction}'s `AccountId`,
 * `BudgetName`, and `ActionId`, and the deploy-time half grants `actions` on
 * the action ARN.
 */
export const makeBudgetActionHttpBinding = <
  I extends { AccountId: string; BudgetName: string; ActionId: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Budgets.ExecuteBudgetAction`. */
  tag: string;
  /** The distilled operation; the action identifiers are injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the budget action ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (action: BudgetAction) {
      const AccountId = yield* action.accountId;
      const BudgetName = yield* action.budgetName;
      const ActionId = yield* action.actionId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${action}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [Output.interpolate`${action.actionArn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${action.LogicalId})`)(function* (
        request: Omit<I, "AccountId" | "BudgetName" | "ActionId">,
      ) {
        return yield* op({
          ...request,
          AccountId: yield* AccountId,
          BudgetName: yield* BudgetName,
          ActionId: yield* ActionId,
        } as I);
      });
    });
  });
