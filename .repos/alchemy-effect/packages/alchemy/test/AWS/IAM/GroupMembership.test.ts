import * as AWS from "@/AWS";
import { Group, GroupMembership, User } from "@/AWS/IAM";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as IAM from "@distilled.cloud/aws/iam";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

test.provider("list enumerates the deployed group membership", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const resources = yield* stack.deploy(
      Effect.gen(function* () {
        const user = yield* User("MembershipUser", {
          userName: "alchemy-test-membership-user",
        });
        const group = yield* Group("MembershipGroup", {
          groupName: "alchemy-test-membership-group",
        });
        const membership = yield* GroupMembership("MembershipList", {
          groupName: group.groupName,
          userNames: [user.userName],
        });
        return { user, group, membership };
      }),
    );

    const provider = yield* Provider.findProvider(GroupMembership);
    const all = yield* provider.list();

    const found = all.find((m) => m.groupName === resources.group.groupName);
    expect(found).toBeDefined();
    expect(found?.userNames).toContain(resources.user.userName);

    yield* stack.destroy();

    const deleted = yield* IAM.getGroup({
      GroupName: resources.group.groupName,
    }).pipe(Effect.option);
    expect(deleted._tag).toBe("None");
  }),
);
