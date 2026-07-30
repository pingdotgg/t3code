import * as location from "@distilled.cloud/aws/location";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import type { Role } from "../IAM/Role.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { StartJob, type StartJobRequest } from "./StartJob.ts";

/**
 * Bespoke (not via `BindingHttp.ts`): StartJob is the one Location binding
 * that injects an identifier from a *foreign* resource (the IAM execution
 * role) and needs a second `iam:PassRole` grant alongside the `geo:` action.
 */
export const StartJobHttp = Layer.effect(
  StartJob,
  Effect.gen(function* () {
    const startJob = yield* location.startJob;

    return Effect.fn(function* (executionRole: Role) {
      const RoleArn = yield* executionRole.roleArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Location.StartJob(${executionRole}))`(
            {
              policyStatements: [
                // Jobs are named at runtime, so their ARNs are unknowable at
                // deploy time.
                {
                  Effect: "Allow",
                  Action: ["geo:StartJob"],
                  Resource: ["*"],
                },
                // CRITICAL: without iam:PassRole on the execution role,
                // StartJob fails only at runtime with an AccessDenied.
                {
                  Effect: "Allow",
                  Action: ["iam:PassRole"],
                  Resource: [Output.interpolate`${executionRole.roleArn}`],
                  Condition: {
                    StringEquals: {
                      "iam:PassedToService": "location.amazonaws.com",
                    },
                  },
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`AWS.Location.StartJob(${executionRole.LogicalId})`)(
        function* (request: StartJobRequest) {
          return yield* startJob({
            ...request,
            ExecutionRoleArn: yield* RoleArn,
          });
        },
      );
    });
  }),
);
