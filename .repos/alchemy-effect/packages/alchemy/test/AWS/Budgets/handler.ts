import * as Budgets from "@/AWS/Budgets";
import * as IAM from "@/AWS/IAM";
import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export const fixtureBudgetName = "alchemy-test-budgets-bindings";

export class BudgetsTestFunction extends Lambda.Function<Lambda.Function>()(
  "BudgetsTestFunction",
) {}

export default BudgetsTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const execRole = yield* IAM.Role("BindingsExecRole", {
      roleName: "alchemy-test-budgets-bind-exec",
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "budgets.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      managedPolicyArns: [
        "arn:aws:iam::aws:policy/AWSBudgetsActionsWithAWSResourceControlAccess",
      ],
    });

    const targetRole = yield* IAM.Role("BindingsTargetRole", {
      roleName: "alchemy-test-budgets-bind-target",
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "ec2.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
    });

    const budget = yield* Budgets.Budget("BindingsBudget", {
      budgetName: fixtureBudgetName,
      budgetType: "COST",
      timeUnit: "MONTHLY",
      // Large limit so the action's 100% threshold is never crossed by real
      // account spend — the fixture action must stay in STANDBY.
      budgetLimit: { amount: "1000000", unit: "USD" },
      notifications: [
        {
          notificationType: "ACTUAL",
          comparisonOperator: "GREATER_THAN",
          threshold: 80,
          thresholdType: "PERCENTAGE",
          subscribers: [
            { subscriptionType: "EMAIL", address: "budget-test@example.com" },
          ],
        },
      ],
    });

    const action = yield* Budgets.BudgetAction("BindingsAction", {
      budgetName: budget.budgetName,
      notificationType: "ACTUAL",
      actionType: "APPLY_IAM_POLICY",
      actionThreshold: {
        actionThresholdValue: 100,
        actionThresholdType: "PERCENTAGE",
      },
      definition: {
        iamActionDefinition: {
          policyArn: "arn:aws:iam::aws:policy/AWSDenyAll",
          roles: [targetRole.roleName],
        },
      },
      executionRoleArn: execRole.roleArn,
      approvalModel: "MANUAL",
      subscribers: [
        { subscriptionType: "EMAIL", address: "budget-test@example.com" },
      ],
    });

    // --- budget-scoped bindings ---
    const describeBudget = yield* Budgets.DescribeBudget(budget);
    const performanceHistory =
      yield* Budgets.DescribeBudgetPerformanceHistory(budget);
    const notifications = yield* Budgets.DescribeNotificationsForBudget(budget);
    const subscribers =
      yield* Budgets.DescribeSubscribersForNotification(budget);
    const listActions = yield* Budgets.DescribeBudgetActionsForBudget(budget);

    // --- action-scoped bindings ---
    const executeAction = yield* Budgets.ExecuteBudgetAction(action);
    const actionHistories =
      yield* Budgets.DescribeBudgetActionHistories(action);

    const bound = {
      describeBudget,
      performanceHistory,
      notifications,
      subscribers,
      listActions,
      executeAction,
      actionHistories,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/budget") {
          const result = yield* describeBudget();
          return yield* HttpServerResponse.json({
            name: result.Budget?.BudgetName ?? null,
            limitAmount: result.Budget?.BudgetLimit?.Amount ?? null,
            limitUnit: result.Budget?.BudgetLimit?.Unit ?? null,
            timeUnit: result.Budget?.TimeUnit ?? null,
          });
        }

        if (request.method === "GET" && pathname === "/history") {
          const result = yield* performanceHistory();
          return yield* HttpServerResponse.json({
            budgetName: result.BudgetPerformanceHistory?.BudgetName ?? null,
            periods: (
              result.BudgetPerformanceHistory?.BudgetedAndActualAmountsList ??
              []
            ).length,
          });
        }

        if (request.method === "GET" && pathname === "/notifications") {
          const result = yield* notifications();
          return yield* HttpServerResponse.json({
            thresholds: (result.Notifications ?? []).map((n) => n.Threshold),
          });
        }

        if (request.method === "GET" && pathname === "/subscribers") {
          // Enumerate notifications, then list each one's subscribers — the
          // round trip proves the ViewBudget grant and identifier injection.
          const notifs = yield* notifications();
          const first = (notifs.Notifications ?? [])[0];
          if (!first) {
            return yield* HttpServerResponse.json({
              count: 0,
              subscriptionTypes: [],
            });
          }
          const result = yield* subscribers({ Notification: first });
          return yield* HttpServerResponse.json({
            count: (result.Subscribers ?? []).length,
            subscriptionTypes: (result.Subscribers ?? []).map(
              (s) => s.SubscriptionType,
            ),
          });
        }

        if (request.method === "GET" && pathname === "/actions") {
          const result = yield* listActions();
          return yield* HttpServerResponse.json({
            actions: (result.Actions ?? []).map((a) => ({
              actionId: a.ActionId,
              status: a.Status,
              actionType: a.ActionType,
            })),
          });
        }

        if (request.method === "GET" && pathname === "/action-histories") {
          const result = yield* actionHistories({});
          return yield* HttpServerResponse.json({
            count: result.ActionHistories.length,
            eventTypes: result.ActionHistories.map((h) => h.EventType),
          });
        }

        if (request.method === "GET" && pathname === "/execute-reset") {
          // A STANDBY action can't meaningfully be reset — the point is to
          // prove the `budgets:ExecuteBudgetAction` grant and identifier
          // injection: any typed budgets-service outcome (success or a
          // business error) proves the call was authorized. An IAM gap would
          // surface AccessDeniedException and fail the route with a 500.
          const outcome = yield* executeAction({
            ExecutionType: "RESET_BUDGET_ACTION",
          }).pipe(
            Effect.map((r) => ({
              outcome: "ok",
              executionType: r.ExecutionType,
            })),
            Effect.catchTag(
              ["ResourceLockedException", "InvalidParameterException"],
              (e) => Effect.succeed({ outcome: e._tag, executionType: null }),
            ),
          );
          return yield* HttpServerResponse.json(outcome);
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Budgets.DescribeBudgetHttp,
        Budgets.DescribeBudgetPerformanceHistoryHttp,
        Budgets.DescribeNotificationsForBudgetHttp,
        Budgets.DescribeSubscribersForNotificationHttp,
        Budgets.DescribeBudgetActionsForBudgetHttp,
        Budgets.ExecuteBudgetActionHttp,
        Budgets.DescribeBudgetActionHistoriesHttp,
      ),
    ),
  ),
);
