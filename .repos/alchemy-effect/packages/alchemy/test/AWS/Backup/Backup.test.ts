import * as AWS from "@/AWS";
import { BackupPlan } from "@/AWS/Backup/BackupPlan.ts";
import { BackupSelection } from "@/AWS/Backup/BackupSelection.ts";
import { BackupVault } from "@/AWS/Backup/BackupVault.ts";
import {
  normalizePolicyDocument,
  type PolicyDocument,
} from "@/AWS/IAM/Policy.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as backup from "@distilled.cloud/aws/backup";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const vaultName = "alchemy-test-backup-vault-lifecycle";

// A structured PolicyDocument (not a JSON string) — proves the typed prop
// deploys and that a re-deploy of the equivalent document is drift-free.
// NOTE: two actions on purpose — AWS Backup canonicalizes a single-element
// Action array to a bare string in the stored document, which would defeat
// a verbatim round-trip comparison.
const vaultAccessPolicy: PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "DenyRecoveryPointDeletion",
      Effect: "Deny",
      Principal: { AWS: "*" },
      Action: [
        "backup:DeleteRecoveryPoint",
        "backup:UpdateRecoveryPointLifecycle",
      ],
      Resource: "*",
    },
  ],
};

// AWS Backup reports a missing vault as AccessDeniedException, not
// ResourceNotFoundException.
const getVault = backup
  .describeBackupVault({ BackupVaultName: vaultName })
  .pipe(
    Effect.catchTag(
      ["ResourceNotFoundException", "AccessDeniedException"],
      () => Effect.succeed(undefined),
    ),
  );

test.provider(
  "lifecycle: vault + plan + selection, update plan, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create — vault, an IAM role AWS Backup can assume, a plan targeting the
      // vault, and a tag-based selection assigned to that plan.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const vault = yield* BackupVault("LifecycleVault", {
            backupVaultName: vaultName,
            accessPolicy: vaultAccessPolicy,
            tags: { env: "test" },
          });
          const role = yield* AWS.IAM.Role("LifecycleBackupRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "backup.amazonaws.com" },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
            managedPolicyArns: [
              "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup",
            ],
          });
          const plan = yield* BackupPlan("LifecyclePlan", {
            rules: [
              {
                ruleName: "DailyBackups",
                targetBackupVaultName: vault.backupVaultName,
                scheduleExpression: "cron(0 5 ? * * *)",
                startWindow: "1 hour",
                completionWindow: "180 minutes",
                lifecycle: { deleteAfter: "30 days" },
              },
            ],
            tags: { env: "test" },
          });
          const selection = yield* BackupSelection("LifecycleSelection", {
            backupPlanId: plan.backupPlanId,
            iamRoleArn: role.roleArn,
            listOfTags: [
              {
                conditionType: "STRINGEQUALS",
                conditionKey: "aws:ResourceTag/backup",
                conditionValue: "daily",
              },
            ],
          });
          return {
            vaultArn: vault.backupVaultArn,
            planId: plan.backupPlanId,
            planName: plan.backupPlanName,
            selectionId: selection.selectionId,
          };
        }),
      );

      expect(deployed.vaultArn).toContain(`backup-vault:${vaultName}`);

      // Out-of-band verification via distilled.
      const vault = yield* getVault;
      expect(vault?.BackupVaultName).toBe(vaultName);

      const plan = yield* backup.getBackupPlan({
        BackupPlanId: deployed.planId,
      });
      expect(plan.BackupPlan?.BackupPlanName).toBe(deployed.planName);
      expect(plan.BackupPlan?.Rules?.[0]?.RuleName).toBe("DailyBackups");
      expect(plan.BackupPlan?.Rules?.[0]?.Lifecycle?.DeleteAfterDays).toBe(30);

      const selection = yield* backup.getBackupSelection({
        BackupPlanId: deployed.planId,
        SelectionId: deployed.selectionId,
      });
      expect(selection.BackupSelection?.ListOfTags?.[0]?.ConditionKey).toBe(
        "aws:ResourceTag/backup",
      );

      // Vault tags applied.
      const vaultTags = yield* backup.listTags({
        ResourceArn: deployed.vaultArn,
      });
      expect(vaultTags.Tags?.env).toBe("test");

      // The PolicyDocument-valued access policy round-trips: the document
      // AWS stored is canonically equal to the one we deployed.
      const storedPolicy = yield* backup.getBackupVaultAccessPolicy({
        BackupVaultName: vaultName,
      });
      expect(storedPolicy.Policy).toBeDefined();
      expect(normalizePolicyDocument(storedPolicy.Policy!)).toBe(
        normalizePolicyDocument(vaultAccessPolicy),
      );

      // Canonical list() coverage.
      const vaultProvider = yield* Provider.findProvider(BackupVault);
      const allVaults = yield* vaultProvider.list();
      expect(allVaults.some((v) => v.backupVaultName === vaultName)).toBe(true);

      // Update the plan in place — change retention and start window. The
      // vault re-deploys with an equivalent PolicyDocument (statement keys
      // reordered) plus a tag change, so its reconcile runs and the policy
      // sync must conclude "no drift" against the stored document.
      yield* stack.deploy(
        Effect.gen(function* () {
          const vault = yield* BackupVault("LifecycleVault", {
            backupVaultName: vaultName,
            accessPolicy: {
              Statement: [
                {
                  Resource: "*",
                  Action: [
                    "backup:DeleteRecoveryPoint",
                    "backup:UpdateRecoveryPointLifecycle",
                  ],
                  Principal: { AWS: "*" },
                  Effect: "Deny",
                  Sid: "DenyRecoveryPointDeletion",
                },
              ],
              Version: "2012-10-17",
            },
            tags: { env: "test", phase: "two" },
          });
          const role = yield* AWS.IAM.Role("LifecycleBackupRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "backup.amazonaws.com" },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
            managedPolicyArns: [
              "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup",
            ],
          });
          const plan = yield* BackupPlan("LifecyclePlan", {
            rules: [
              {
                ruleName: "DailyBackups",
                targetBackupVaultName: vault.backupVaultName,
                scheduleExpression: "cron(0 6 ? * * *)",
                startWindow: "2 hours",
                completionWindow: "6 hours",
                lifecycle: { deleteAfter: "60 days" },
              },
            ],
            tags: { env: "test" },
          });
          yield* BackupSelection("LifecycleSelection", {
            backupPlanId: plan.backupPlanId,
            iamRoleArn: role.roleArn,
            listOfTags: [
              {
                conditionType: "STRINGEQUALS",
                conditionKey: "aws:ResourceTag/backup",
                conditionValue: "daily",
              },
            ],
          });
          return { planId: plan.backupPlanId };
        }),
      );

      const updatedPlan = yield* backup.getBackupPlan({
        BackupPlanId: deployed.planId,
      });
      expect(
        updatedPlan.BackupPlan?.Rules?.[0]?.Lifecycle?.DeleteAfterDays,
      ).toBe(60);
      expect(updatedPlan.BackupPlan?.Rules?.[0]?.CompletionWindowMinutes).toBe(
        360,
      );

      // Re-deploy was clean: the stored access policy is still canonically
      // equal to the original document, and the tag update landed.
      const policyAfterRedeploy = yield* backup.getBackupVaultAccessPolicy({
        BackupVaultName: vaultName,
      });
      expect(normalizePolicyDocument(policyAfterRedeploy.Policy!)).toBe(
        normalizePolicyDocument(vaultAccessPolicy),
      );
      const tagsAfterRedeploy = yield* backup.listTags({
        ResourceArn: deployed.vaultArn,
      });
      expect(tagsAfterRedeploy.Tags?.phase).toBe("two");

      // Destroy — provider recursively deletes and everything is gone.
      yield* stack.destroy();
      const afterVault = yield* getVault;
      expect(afterVault).toBeUndefined();

      // The plan no longer appears in the account listing.
      const planProvider = yield* Provider.findProvider(BackupPlan);
      const remainingPlans = yield* planProvider.list();
      expect(
        remainingPlans.some((p) => p.backupPlanId === deployed.planId),
      ).toBe(false);
    }),
  { timeout: 240_000 },
);
