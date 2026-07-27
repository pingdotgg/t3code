import * as AWS from "@/AWS";
import { Stage } from "@/AWS/IVSRealtime";
import * as Test from "@/Test/Alchemy";
import * as ivsrealtime from "@distilled.cloud/aws/ivs-realtime";
import * as sts from "@distilled.cloud/aws/sts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: proves the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "getStage on a nonexistent ARN fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const region = yield* yield* AWS.Region;
      const { Account } = yield* sts.getCallerIdentity({});
      const error = yield* Effect.flip(
        ivsrealtime.getStage({
          arn: `arn:aws:ivs:${region}:${Account}:stage/AbCdEfGh1234`,
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 60_000 },
);

const assertStageGone = (arn: string) =>
  Effect.gen(function* () {
    const stage = yield* ivsrealtime.getStage({ arn }).pipe(
      Effect.map((r) => r.stage),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
    if (stage !== undefined) {
      return yield* Effect.fail(new Error(`stage '${arn}' still exists`));
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(8)]),
    }),
  );

// Stages are free while idle and provision synchronously — the full
// lifecycle (create, no-op, rename-in-place, destroy) runs ungated.
test.provider(
  "create, update, and destroy an IVS Real-Time stage",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const props = {
        stageName: "alchemy-test-ivs-stage",
        tags: { fixture: "ivs-realtime-stage" },
      };

      // Create.
      const created = yield* stack.deploy(Stage("Room", props));
      expect(created.stageName).toBe("alchemy-test-ivs-stage");
      expect(created.stageArn).toContain(":stage/");
      expect(created.whipEndpoint).toBeDefined();

      // Out-of-band verification via distilled.
      const observed = yield* ivsrealtime.getStage({ arn: created.stageArn });
      expect(observed.stage?.name).toBe("alchemy-test-ivs-stage");
      expect(observed.stage?.tags?.fixture).toBe("ivs-realtime-stage");
      expect(observed.stage?.tags?.["alchemy::id"]).toBe("Room");

      // No-op redeploy keeps the same stage.
      const noop = yield* stack.deploy(Stage("Room", props));
      expect(noop.stageArn).toBe(created.stageArn);

      // Rename in place — the ARN must not change.
      const renamed = yield* stack.deploy(
        Stage("Room", { ...props, stageName: "alchemy-test-ivs-stage-b" }),
      );
      expect(renamed.stageArn).toBe(created.stageArn);
      expect(renamed.stageName).toBe("alchemy-test-ivs-stage-b");

      const reobserved = yield* ivsrealtime.getStage({
        arn: created.stageArn,
      });
      expect(reobserved.stage?.name).toBe("alchemy-test-ivs-stage-b");

      // Destroy and verify out-of-band with a typed wait-until-gone.
      yield* stack.destroy();
      yield* assertStageGone(created.stageArn);
    }),
  { timeout: 240_000 },
);
