import * as resourcegroups from "@distilled.cloud/aws/resource-groups";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import type { Role } from "../IAM/Role.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Group } from "./Group.ts";
import {
  StartTagSyncTask,
  type StartTagSyncTaskRequest,
} from "./StartTagSyncTask.ts";

// Bespoke (not on the shared scaffold): the only Resource Groups binding
// that passes an IAM role to the service, so it needs the second
// `iam:PassRole` statement and injects a default `RoleArn`.
export const StartTagSyncTaskHttp = Layer.effect(
  StartTagSyncTask,
  Effect.gen(function* () {
    const startTagSyncTask = yield* resourcegroups.startTagSyncTask;

    return Effect.fn(function* <R extends Role>(group: Group, syncRole: R) {
      const GroupName = yield* group.groupName;
      const RoleArn = yield* syncRole.roleArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.ResourceGroups.StartTagSyncTask(${group}, ${syncRole}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["resource-groups:StartTagSyncTask"],
                  Resource: [group.groupArn],
                },
                // Tag-sync maintains group membership, and the service
                // authorizes that as CreateGroup against the bare group
                // namespace (`arn:…:group/` — no name), which a specific
                // group ARN can never match. Scope to the namespace instead.
                {
                  Effect: "Allow",
                  Action: ["resource-groups:CreateGroup"],
                  Resource: ["arn:aws:resource-groups:*:*:group/*"],
                },
                // CRITICAL: without iam:PassRole on the sync role,
                // StartTagSyncTask fails only at runtime with AccessDenied.
                {
                  Effect: "Allow",
                  Action: ["iam:PassRole"],
                  Resource: [syncRole.roleArn],
                  Condition: {
                    StringEquals: {
                      "iam:PassedToService": "resource-groups.amazonaws.com",
                    },
                  },
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.ResourceGroups.StartTagSyncTask(${group.LogicalId})`,
      )(function* (request: StartTagSyncTaskRequest) {
        return yield* startTagSyncTask({
          ...request,
          Group: yield* GroupName,
          RoleArn: request.RoleArn ?? (yield* RoleArn),
        });
      });
    });
  }),
);
