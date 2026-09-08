import * as AWS from "@/AWS";
import { amazonLinux2023, Instance, Subnet, Vpc } from "@/AWS/EC2";
import * as Test from "./VpcTest.ts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { assertInstanceTerminated, assertVpcGone } from "./Gone.ts";

const { test } = Test.make({ providers: AWS.providers() });

// A change confined to the hosted runtime program must participate in
// planning (#1025): before the fix, `code.hash` was only computed during
// reconcile, so a code-only edit planned `noop` and the stale bundle stayed
// live. The program is `isExternal` (a plain script) so the test can rewrite
// the source between plans.
test.provider.skipIf(!!process.env.FAST)(
  "code-only change to the hosted program plans an in-place update",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const imageId = amazonLinux2023();
      const dir = yield* fs.makeTempDirectory({ prefix: "alchemy-ec2-code-" });
      const mainPath = path.join(dir, "main.ts");
      // A marker-bearing long-running program; only its bundle hash matters
      // to this test, never its runtime behavior.
      const writeProgram = (marker: string) =>
        fs.writeFileString(
          mainPath,
          `setInterval(() => console.log(${JSON.stringify(marker)}), 60_000);\n`,
        );
      yield* writeProgram("generation-one");

      const makeStack = Effect.gen(function* () {
        const vpc = yield* Vpc("CodeInstanceVpc", {
          cidrBlock: "10.0.0.0/16",
        });
        const subnet = yield* Subnet("CodeInstanceSubnet", {
          vpcId: vpc.vpcId,
          cidrBlock: "10.0.1.0/24",
        });
        const instance = yield* Instance("CodeInstance", {
          imageId,
          instanceType: "t3.micro",
          subnetId: subnet.subnetId,
          main: mainPath,
          isExternal: true,
        });
        return { vpc, instance };
      });

      const { vpc, instance } = yield* stack.deploy(makeStack);

      // Unchanged source replans as noop (bundling is deterministic)...
      const before = yield* stack.plan(makeStack);
      expect(before.resources.CodeInstance).toMatchObject({ action: "noop" });

      // ...and a code-only edit plans an in-place update.
      yield* writeProgram("generation-two");
      const after = yield* stack.plan(makeStack);
      expect(after.resources.CodeInstance).toMatchObject({ action: "update" });

      yield* stack.destroy();

      // Zero-orphan proof.
      yield* assertInstanceTerminated(instance.instanceId);
      yield* assertVpcGone(vpc.vpcId);
    }),
  { timeout: 600_000 },
);
