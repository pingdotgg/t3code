import * as codedeploy from "@distilled.cloud/aws/codedeploy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  CreateDeployment,
  type CreateDeploymentRequest,
} from "./CreateDeployment.ts";
import type { DeploymentGroup } from "./DeploymentGroup.ts";

/**
 * Bespoke (multi-statement IAM): besides `codedeploy:CreateDeployment` on
 * the group, creating a deployment reads the deployment configuration and
 * the application revision on the caller's behalf, so the grant also covers
 * `GetDeploymentConfig` on the account's configs and
 * `GetApplicationRevision`/`RegisterApplicationRevision` on the group's
 * application.
 */
export const CreateDeploymentHttp = Layer.effect(
  CreateDeployment,
  Effect.gen(function* () {
    const op = yield* codedeploy.createDeployment;

    return Effect.fn(function* <G extends DeploymentGroup>(group: G) {
      // Outputs yield a DEFERRED effect — resolve again per invocation below.
      const ApplicationName = yield* group.applicationName;
      const DeploymentGroupName = yield* group.deploymentGroupName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.CodeDeploy.CreateDeployment(${group}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["codedeploy:CreateDeployment"],
                  Resource: [Output.interpolate`${group.deploymentGroupArn}`],
                },
                {
                  Effect: "Allow",
                  Action: ["codedeploy:GetDeploymentConfig"],
                  Resource: [
                    Output.map(group.deploymentGroupArn, (arn) =>
                      arn.replace(
                        /:deploymentgroup:.*$/,
                        ":deploymentconfig:*",
                      ),
                    ),
                  ],
                },
                {
                  Effect: "Allow",
                  Action: [
                    "codedeploy:GetApplicationRevision",
                    "codedeploy:RegisterApplicationRevision",
                  ],
                  Resource: [
                    Output.map(group.deploymentGroupArn, (arn) =>
                      arn.replace(
                        /:deploymentgroup:([^/]+)\/.*$/,
                        ":application:$1",
                      ),
                    ),
                  ],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.CodeDeploy.CreateDeployment(${group.LogicalId})`)(
        function* (request?: CreateDeploymentRequest) {
          return yield* op({
            ...request,
            applicationName: yield* ApplicationName,
            deploymentGroupName: yield* DeploymentGroupName,
          });
        },
      );
    });
  }),
);
