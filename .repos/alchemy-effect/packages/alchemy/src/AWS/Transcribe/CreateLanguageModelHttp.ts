import * as transcribe from "@distilled.cloud/aws/transcribe";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import type { Role } from "../IAM/Role.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  CreateLanguageModel,
  type CreateLanguageModelRequest,
} from "./CreateLanguageModel.ts";

// Bespoke (not makeTranscribeRoleHttpBinding): CreateLanguageModel nests the
// data-access role inside `InputDataConfig.DataAccessRoleArn` rather than as
// a top-level request field.
export const CreateLanguageModelHttp = Layer.effect(
  CreateLanguageModel,
  Effect.gen(function* () {
    const createLanguageModel = yield* transcribe.createLanguageModel;

    return Effect.fn(function* <Rl extends Role>(dataAccessRole: Rl) {
      const RoleArn = yield* dataAccessRole.roleArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Transcribe.CreateLanguageModel(${dataAccessRole}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["transcribe:CreateLanguageModel"],
                  Resource: ["*"],
                },
                // CRITICAL: without iam:PassRole on the data-access role,
                // CreateLanguageModel fails only at runtime with an
                // AccessDenied.
                {
                  Effect: "Allow",
                  Action: ["iam:PassRole"],
                  Resource: [Output.interpolate`${dataAccessRole.roleArn}`],
                  Condition: {
                    StringEquals: {
                      "iam:PassedToService": "transcribe.amazonaws.com",
                    },
                  },
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.Transcribe.CreateLanguageModel(${dataAccessRole.LogicalId})`,
      )(function* (request: CreateLanguageModelRequest) {
        return yield* createLanguageModel({
          ...request,
          InputDataConfig: {
            ...request.InputDataConfig,
            DataAccessRoleArn:
              request.InputDataConfig.DataAccessRoleArn ?? (yield* RoleArn),
          },
        });
      });
    });
  }),
);
