import * as AWS from "@alchemy.run/aws";
import { EIP } from "@alchemy.run/aws/EC2";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { assertEipGone } from "./Gone.ts";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

test.provider(
  "list enumerates the deployed EIP",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* EIP("ListEIP", {});
        }),
      );

      const provider = yield* Provider.findProvider(EIP);
      const all = yield* provider.list();

      expect(all.some((x) => x.allocationId === deployed.allocationId)).toBe(true);

      yield* stack.destroy();

      yield* assertEipGone(deployed.allocationId);
    }).pipe(logLevel),
  { tags: ["provider:aws", "provider:aws:ec2", "live"] },
);
