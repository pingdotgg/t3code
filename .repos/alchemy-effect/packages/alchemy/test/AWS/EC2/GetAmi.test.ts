import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// `GetAmi.execute` (aliased `getAmi`) is the data-source form of the
// capability: the lookup runs during plan/deploy resolution against the
// stack's services (GetAmiHttp is registered by AWS.providers()), never
// inside a deployed runtime. No cloud resources are created — the stack is
// outputs-only — so this pins the whole invoke path cheaply: Binding.Service
// execute → EffectExpr resolution → distilled describeImages.
test.provider(
  "getAmi resolves images as plan-time Outputs",
  (stack) =>
    Effect.gen(function* () {
      const { image, imageId, fallbackId } = yield* stack.deploy(
        Effect.gen(function* () {
          return {
            // The generic data source: the full image description.
            image: AWS.EC2.getAmi({
              owners: ["amazon"],
              name: ["al2023-ami-2023.*"],
            }),
            // The id-only helper built on it.
            imageId: AWS.EC2.amazonLinux2023(),
            // The preference-chain helper (flatMap over the data source).
            fallbackId: AWS.EC2.amazonLinux(),
          };
        }),
      );

      expect(image?.ImageId).toMatch(/^ami-/);
      expect(image?.CreationDate).toBeTruthy();
      expect(imageId).toMatch(/^ami-/);
      // AL2023 exists, so the fallback chain resolves to the same image id.
      expect(fallbackId).toBe(imageId);

      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
