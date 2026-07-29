import * as backup from "@distilled.cloud/aws/backup";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import type { Role } from "../IAM/Role.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  StartRestoreJob,
  type StartRestoreJobRequest,
} from "./StartRestoreJob.ts";

export const StartRestoreJobHttp = Layer.effect(
  StartRestoreJob,
  Effect.gen(function* () {
    const startRestoreJob = yield* backup.startRestoreJob;

    return Effect.fn(function* <R extends Role>(restoreRole: R) {
      const RoleArn = yield* restoreRole.roleArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Backup.StartRestoreJob(${restoreRole}))`(
            {
              policyStatements: [
                // StartRestoreJob authorizes on the recovery point's
                // underlying resource ARN (a snapshot ARN unknowable at
                // deploy time), so the grant is on `*`.
                {
                  Effect: "Allow",
                  Action: ["backup:StartRestoreJob"],
                  Resource: ["*"],
                },
                // CRITICAL: without iam:PassRole on the restore role,
                // StartRestoreJob fails only at runtime with an AccessDenied.
                {
                  Effect: "Allow",
                  Action: ["iam:PassRole"],
                  Resource: [Output.interpolate`${restoreRole.roleArn}`],
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
      return Effect.fn(`AWS.Backup.StartRestoreJob(${restoreRole.LogicalId})`)(
        function* (request: StartRestoreJobRequest) {
          return yield* startRestoreJob({
            ...request,
            IamRoleArn: request.IamRoleArn ?? (yield* RoleArn),
          });
        },
      );
    });
  }),
);
