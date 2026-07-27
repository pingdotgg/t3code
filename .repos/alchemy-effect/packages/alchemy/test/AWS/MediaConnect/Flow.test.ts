import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment";
import { Flow } from "@/AWS/MediaConnect";
import * as Test from "@/Test/Alchemy";
import * as mediaconnect from "@distilled.cloud/aws/mediaconnect";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on. Runs in every
// CI pass at near-zero cost, unlike the gated lifecycle below.
test.provider(
  "describeFlow on a nonexistent flow ARN fails with NotFoundException",
  () =>
    Effect.gen(function* () {
      const { accountId, region } = yield* AWSEnvironment.current;
      const error = yield* Effect.flip(
        mediaconnect.describeFlow({
          FlowArn: `arn:aws:mediaconnect:${region}:${accountId}:flow:1-00000000000000000000000000000000:alchemy-nonexistent-flow-probe`,
        }),
      );
      expect(error._tag).toBe("NotFoundException");
    }),
);

// Deletion is initiated by the provider and verified as fully gone here;
// bounded out-of-band re-check in case the final read raced DELETING.
const assertFlowGone = (flowArn: string) =>
  Effect.gen(function* () {
    const status = yield* mediaconnect.describeFlow({ FlowArn: flowArn }).pipe(
      Effect.map((r) => r.Flow?.Status ?? "gone"),
      Effect.catchTag("NotFoundException", () =>
        Effect.succeed("gone" as const),
      ),
    );
    if (status !== "gone") {
      return yield* Effect.fail(
        new Error(`flow '${flowArn}' still exists (status: ${status})`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("10 seconds"),
        Schedule.recurs(18),
      ]),
    }),
  );

// MediaConnect flows bill hourly while ACTIVE and provisioning is async, so
// the full lifecycle is gated behind AWS_TEST_MEDIACONNECT=1. Create leaves
// the flow in STANDBY (the provider never calls StartFlow) and the test
// always destroys what it created.
test.provider.skipIf(!process.env.AWS_TEST_MEDIACONNECT)(
  "create flow (STANDBY), add output, sync source, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Step 1: create with a single RTP source and no outputs.
      const { flow } = yield* stack.deploy(
        Effect.gen(function* () {
          const flow = yield* Flow("Broadcast", {
            source: {
              Name: "primary",
              Protocol: "rtp",
              WhitelistCidr: "10.24.34.0/23",
              IngestPort: 5000,
            },
            tags: { fixture: "mediaconnect-flow" },
          });
          return { flow };
        }),
      );

      expect(flow.flowArn).toContain(":flow:");
      expect(flow.status).toBe("STANDBY");
      expect(flow.availabilityZone).toBeDefined();
      expect(flow.sourceArn).toContain(":source:");
      expect(flow.sourceIngestPort).toBe(5000);
      expect(flow.outputs).toEqual([]);
      expect(flow.tags.fixture).toBe("mediaconnect-flow");

      // Out-of-band verification via distilled: created but NOT started.
      const described = yield* mediaconnect.describeFlow({
        FlowArn: flow.flowArn,
      });
      expect(described.Flow?.Status).toBe("STANDBY");
      expect(described.Flow?.Source?.WhitelistCidr).toBe("10.24.34.0/23");

      // Step 2: update in place — widen the source whitelist and add an
      // output. Same logical id, same name → no replacement.
      const { flow: updated } = yield* stack.deploy(
        Effect.gen(function* () {
          const flow = yield* Flow("Broadcast", {
            source: {
              Name: "primary",
              Protocol: "rtp",
              WhitelistCidr: "10.24.32.0/20",
              IngestPort: 5000,
            },
            outputs: [
              {
                Name: "affiliate-east",
                Protocol: "rtp",
                Destination: "198.51.100.11",
                Port: 5010,
              },
            ],
            tags: { fixture: "mediaconnect-flow", stage: "updated" },
          });
          return { flow };
        }),
      );

      // Update, not replacement: the ARN is stable.
      expect(updated.flowArn).toBe(flow.flowArn);
      expect(updated.status).toBe("STANDBY");
      expect(updated.outputs).toHaveLength(1);
      expect(updated.outputs[0]?.name).toBe("affiliate-east");
      expect(updated.outputs[0]?.destination).toBe("198.51.100.11");
      expect(updated.outputs[0]?.port).toBe(5010);
      expect(updated.tags.stage).toBe("updated");

      const redescribed = yield* mediaconnect.describeFlow({
        FlowArn: flow.flowArn,
      });
      expect(redescribed.Flow?.Source?.WhitelistCidr).toBe("10.24.32.0/20");
      expect(redescribed.Flow?.Outputs?.map((o) => o.Name)).toContain(
        "affiliate-east",
      );

      // Step 3: drop the output again — the reconciler removes extras.
      const { flow: pruned } = yield* stack.deploy(
        Effect.gen(function* () {
          const flow = yield* Flow("Broadcast", {
            source: {
              Name: "primary",
              Protocol: "rtp",
              WhitelistCidr: "10.24.32.0/20",
              IngestPort: 5000,
            },
            tags: { fixture: "mediaconnect-flow" },
          });
          return { flow };
        }),
      );
      expect(pruned.flowArn).toBe(flow.flowArn);
      expect(pruned.outputs).toEqual([]);
      expect(pruned.tags.stage).toBeUndefined();

      // Destroy and verify the flow is fully gone out-of-band.
      yield* stack.destroy();
      yield* assertFlowGone(flow.flowArn);
    }),
  // create + 2 in-place updates + delete-until-gone.
  { timeout: 900_000 },
);
