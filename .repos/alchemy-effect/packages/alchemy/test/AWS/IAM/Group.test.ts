import * as AWS from "@/AWS";
import { Group } from "@/AWS/IAM";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as IAM from "@distilled.cloud/aws/iam";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

test.provider("list enumerates the deployed group", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const group = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Group("ListGroup", {
          groupName: "alchemy-test-group-list",
          inlinePolicies: {
            SupportReadOnly: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Action: ["cloudwatch:Get*", "cloudwatch:List*"],
                  Resource: ["*"],
                },
              ],
            },
          },
        });
      }),
    );

    const provider = yield* Provider.findProvider(Group);
    const all = yield* provider.list();

    const found = all.find((g) => g.groupName === group.groupName);
    expect(found).toBeDefined();
    expect(found?.groupArn).toBe(group.groupArn);
    expect(found?.inlinePolicies.SupportReadOnly).toBeDefined();

    yield* stack.destroy();

    const deleted = yield* IAM.getGroup({
      GroupName: group.groupName,
    }).pipe(Effect.option);
    expect(deleted._tag).toBe("None");
  }),
);
