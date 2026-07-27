import * as backup from "@distilled.cloud/aws/backup";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import type { Role } from "../IAM/Role.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { BackupVault } from "./BackupVault.ts";
import {
  StartBackupJob,
  type StartBackupJobRequest,
} from "./StartBackupJob.ts";

export const StartBackupJobHttp = Layer.effect(
  StartBackupJob,
  Effect.gen(function* () {
    const startBackupJob = yield* backup.startBackupJob;

    return Effect.fn(function* <R extends Role>(
      vault: BackupVault,
      backupRole: R,
    ) {
      const BackupVaultName = yield* vault.backupVaultName;
      const RoleArn = yield* backupRole.roleArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Backup.StartBackupJob(${vault}, ${backupRole}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["backup:StartBackupJob"],
                  Resource: [Output.interpolate`${vault.backupVaultArn}`],
                },
                // CRITICAL: without iam:PassRole on the backup role,
                // StartBackupJob fails only at runtime with an AccessDenied.
                {
                  Effect: "Allow",
                  Action: ["iam:PassRole"],
                  Resource: [Output.interpolate`${backupRole.roleArn}`],
                  Condition: {
                    StringEquals: {
                      "iam:PassedToService": "backup.amazonaws.com",
                    },
                  },
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.Backup.StartBackupJob(${vault.LogicalId})`)(
        function* (request: StartBackupJobRequest) {
          return yield* startBackupJob({
            ...request,
            BackupVaultName: yield* BackupVaultName,
            IamRoleArn: request.IamRoleArn ?? (yield* RoleArn),
          });
        },
      );
    });
  }),
);
