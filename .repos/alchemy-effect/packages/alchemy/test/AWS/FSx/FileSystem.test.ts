import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as fsx from "@distilled.cloud/aws/fsx";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { getDefaultVpc } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

// FSx surfaces a missing file system as the typed FileSystemNotFound.
test.provider(
  "typed FileSystemNotFound on a nonexistent file system",
  () =>
    Effect.gen(function* () {
      const result = yield* fsx
        .describeFileSystems({ FileSystemIds: ["fs-00000000000000000"] })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        const err = result.failure as { _tag: string };
        expect(err._tag).toBe("FileSystemNotFound");
      }
    }),
  { timeout: 60_000 },
);

const describeById = (fileSystemId: string) =>
  fsx.describeFileSystems({ FileSystemIds: [fileSystemId] }).pipe(
    Effect.map((r) => r.FileSystems?.[0]),
    Effect.catchTag("FileSystemNotFound", () => Effect.succeed(undefined)),
  );

// FSx create → AVAILABLE takes ~5 minutes; slow polling is allowed only
// because the whole lifecycle is gated behind AWS_TEST_SLOW=1.
const waitUntilAvailable = (fileSystemId: string) =>
  describeById(fileSystemId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("15 seconds"),
      until: (fs) =>
        fs?.Lifecycle === "AVAILABLE" || fs?.Lifecycle === "FAILED",
      times: 60,
    }),
  );

const waitUntilGone = (fileSystemId: string) =>
  describeById(fileSystemId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("15 seconds"),
      until: (fs) => fs === undefined,
      times: 60,
    }),
  );

const fsxTags = (tags: readonly fsx.Tag[] | undefined) =>
  Object.fromEntries((tags ?? []).map((t) => [t.Key, t.Value]));

// A Lustre SCRATCH_2 file system takes several minutes to provision and a few
// more to delete (and bills hourly while up), so the live lifecycle is gated
// behind AWS_TEST_SLOW=1.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "create Lustre scratch file system, update tags, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const vpc = yield* getDefaultVpc;
      const subnets = yield* EC2.describeSubnets({
        Filters: [
          { Name: "vpc-id", Values: [vpc.vpcId] },
          { Name: "default-for-az", Values: ["true"] },
        ],
      });
      const subnetId = subnets.Subnets![0]!.SubnetId!;

      const build = (tags: Record<string, string>) =>
        Effect.gen(function* () {
          const scratch = yield* AWS.FSx.FileSystem("Scratch", {
            fileSystemType: "LUSTRE",
            storageCapacity: 1200,
            subnetIds: [subnetId],
            lustreConfiguration: { DeploymentType: "SCRATCH_2" },
            tags,
          });
          return { scratch };
        });

      // --- create ---
      const created = yield* stack.deploy(
        build({ purpose: "alchemy-fsx-test" }),
      );
      expect(created.scratch.fileSystemId).toContain("fs-");
      expect(created.scratch.fileSystemArn).toContain(":file-system/fs-");
      expect(created.scratch.fileSystemType).toBe("LUSTRE");
      const fileSystemId = created.scratch.fileSystemId;

      const available = yield* waitUntilAvailable(fileSystemId);
      expect(available?.Lifecycle).toBe("AVAILABLE");
      expect(available?.FileSystemType).toBe("LUSTRE");
      expect(available?.StorageCapacity).toBe(1200);
      const tags = fsxTags(available?.Tags);
      expect(tags.purpose).toBe("alchemy-fsx-test");
      expect(tags["alchemy::id"]).toBe("Scratch");

      // --- update: tags sync in place, identity preserved ---
      const updated = yield* stack.deploy(
        build({ purpose: "alchemy-fsx-test", stage: "prod" }),
      );
      expect(updated.scratch.fileSystemId).toBe(fileSystemId);
      const observed = yield* describeById(fileSystemId);
      expect(fsxTags(observed?.Tags).stage).toBe("prod");

      // --- delete ---
      yield* stack.destroy();
      const gone = yield* waitUntilGone(fileSystemId);
      expect(gone).toBeUndefined();
    }),
  { timeout: 1_500_000 },
);
