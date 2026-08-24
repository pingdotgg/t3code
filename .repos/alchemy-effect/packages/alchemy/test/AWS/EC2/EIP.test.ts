import * as AWS from "@/AWS";
import { EIP } from "@/AWS/EC2";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { assertEipGone } from "./Gone.ts";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("list enumerates the deployed EIP", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* EIP("ListEIP", {});
      }),
    );

    const provider = yield* Provider.findProvider(EIP);
    const all = yield* provider.list();

    expect(all.some((x) => x.allocationId === deployed.allocationId)).toBe(
      true,
    );

    yield* stack.destroy();

    yield* assertEipGone(deployed.allocationId);
  }).pipe(logLevel),
);
