import * as AWS from "@/AWS";
import { User } from "@/AWS/IAM";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as IAM from "@distilled.cloud/aws/iam";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

test.provider("list enumerates the deployed user", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const user = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* User("ListUser", {
          tags: {
            env: "test",
          },
        });
      }),
    );

    const provider = yield* Provider.findProvider(User);
    const all = yield* provider.list();

    const found = all.find((u) => u.userName === user.userName);
    expect(found).toBeDefined();
    expect(found?.userArn).toBe(user.userArn);

    yield* stack.destroy();

    const deleted = yield* IAM.getUser({
      UserName: user.userName,
    }).pipe(Effect.option);
    expect(deleted._tag).toBe("None");
  }),
);
