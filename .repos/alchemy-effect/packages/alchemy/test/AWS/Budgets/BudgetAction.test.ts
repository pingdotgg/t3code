import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as budgets from "@distilled.cloud/aws/budgets";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const budgetName = "alchemy-test-budget-action";
const execRoleName = "alchemy-test-budgets-action-exec";
const targetRoleName = "alchemy-test-budgets-action-target";

const getAction = (accountId: string, actionId: string) =>
  budgets
    .describeBudgetAction({
      AccountId: accountId,
      BudgetName: budgetName,
      ActionId: actionId,
    })
    .pipe(
      Effect.map((r) => r.Action),
      Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
    );

const deployAction = (thresholdValue: number) =>
  Effect.gen(function* () {
    const execRole = yield* AWS.IAM.Role("BudgetActionExecRole", {
      roleName: execRoleName,
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

    const targetRole = yield* AWS.IAM.Role("BudgetActionTargetRole", {
      roleName: targetRoleName,
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

    const budget = yield* AWS.Budgets.Budget("ActionBudget", {
      budgetName,
      budgetType: "COST",
      timeUnit: "MONTHLY",
      // Large limit so the 100% threshold is never crossed by real account
      // spend — the action must stay in STANDBY.
      budgetLimit: { amount: "1000000", unit: "USD" },
    });

    const action = yield* AWS.Budgets.BudgetAction("FreezeAction", {
      budgetName: budget.budgetName,
      notificationType: "ACTUAL",
      actionType: "APPLY_IAM_POLICY",
      actionThreshold: {
        actionThresholdValue: thresholdValue,
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
      tags: { Team: "alchemy-test" },
    });

    return {
      accountId: action.accountId,
      actionId: action.actionId,
      actionArn: action.actionArn,
      execRoleArn: execRole.roleArn,
    };
  });

test.provider(
  "lifecycle: create IAM budget action, update threshold, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(deployAction(100));
      const { accountId, actionId } = deployed;

      expect(deployed.actionArn).toBe(
        `arn:aws:budgets::${accountId}:budget/${budgetName}/action/${actionId}`,
      );

      // Out-of-band verification via distilled.
      const created = yield* getAction(accountId, actionId);
      expect(created?.ActionType).toBe("APPLY_IAM_POLICY");
      expect(created?.Status).toBe("STANDBY");
      expect(created?.ApprovalModel).toBe("MANUAL");
      expect(created?.ExecutionRoleArn).toBe(deployed.execRoleArn);
      expect(created?.ActionThreshold.ActionThresholdValue).toBe(100);
      expect(created?.Definition.IamActionDefinition?.PolicyArn).toBe(
        "arn:aws:iam::aws:policy/AWSDenyAll",
      );
      expect(created?.Definition.IamActionDefinition?.Roles).toEqual([
        targetRoleName,
      ]);

      // Tags — user tag plus the internal alchemy brand.
      const tags = yield* budgets
        .listTagsForResource({ ResourceARN: deployed.actionArn })
        .pipe(
          Effect.map((r) =>
            Object.fromEntries(
              (r.ResourceTags ?? []).map((t) => [t.Key, t.Value]),
            ),
          ),
        );
      expect(tags.Team).toBe("alchemy-test");
      expect(Object.keys(tags).some((k) => k.startsWith("alchemy:"))).toBe(
        true,
      );

      // Update — lower the threshold; the action id must be stable.
      const updated = yield* stack.deploy(deployAction(90));
      expect(updated.actionId).toBe(actionId);

      const afterUpdate = yield* getAction(accountId, actionId);
      expect(afterUpdate?.ActionThreshold.ActionThresholdValue).toBe(90);

      // Destroy — the action (and budget) are gone.
      yield* stack.destroy();
      const afterDestroy = yield* budgets
        .describeBudgetAction({
          AccountId: accountId,
          BudgetName: budgetName,
          ActionId: actionId,
        })
        .pipe(
          Effect.map(() => "found"),
          Effect.catchTag("NotFoundException", () =>
            Effect.succeed("not-found"),
          ),
        );
      expect(afterDestroy).toBe("not-found");
    }),
  { timeout: 240_000 },
);
