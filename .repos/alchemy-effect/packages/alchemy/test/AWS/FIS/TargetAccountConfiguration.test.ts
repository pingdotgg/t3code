import * as AWS from "@/AWS";
import { ExperimentTemplate, TargetAccountConfiguration } from "@/AWS/FIS";
import { Role } from "@/AWS/IAM/Role.ts";
import * as Test from "@/Test/Alchemy";
import * as fis from "@distilled.cloud/aws/fis";
import * as sts from "@distilled.cloud/aws/sts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const findConfiguration = (experimentTemplateId: string, accountId: string) =>
  fis.getTargetAccountConfiguration({ experimentTemplateId, accountId }).pipe(
    Effect.map((r) => r.targetAccountConfiguration),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );

test.provider(
  "create, update, delete target account configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Multi-account experiments accept the orchestrator account itself as a
      // target account, so the whole lifecycle runs single-account.
      const { Account } = yield* sts.getCallerIdentity({});
      const accountId = Account!;

      const program = (description: string) =>
        Effect.gen(function* () {
          const role = yield* Role("FisTargetAccountRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "fis.amazonaws.com" },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
          });
          const template = yield* ExperimentTemplate("MultiAccountTemplate", {
            roleArn: role.roleArn,
            experimentOptions: { accountTargeting: "multi-account" },
            actions: {
              Wait: {
                actionId: "aws:fis:wait",
                parameters: { duration: "PT1M" },
              },
            },
          });
          const config = yield* TargetAccountConfiguration("TargetAccount", {
            experimentTemplateId: template.id,
            accountId,
            roleArn: role.roleArn,
            description,
          });
          return { template, config };
        });

      const { template, config } = yield* stack.deploy(
        program("alchemy fis tac test"),
      );
      expect(config.experimentTemplateId).toBe(template.id);
      expect(config.accountId).toBe(accountId);
      expect(config.roleArn).toContain(":role/");

      // out-of-band verification via distilled
      const created = yield* findConfiguration(template.id, accountId);
      expect(created).toBeDefined();
      expect(created?.accountId).toBe(accountId);
      expect(created?.roleArn).toBe(config.roleArn);
      expect(created?.description).toBe("alchemy fis tac test");

      // update in place — same identity, new description
      const updated = yield* stack.deploy(
        program("alchemy fis tac test updated"),
      );
      expect(updated.config.experimentTemplateId).toBe(template.id);
      expect(updated.config.accountId).toBe(accountId);

      const afterUpdate = yield* findConfiguration(template.id, accountId);
      expect(afterUpdate?.description).toBe("alchemy fis tac test updated");

      yield* stack.destroy();
      const afterDestroy = yield* findConfiguration(template.id, accountId);
      expect(afterDestroy).toBeUndefined();
    }),
  { timeout: 120_000 },
);
