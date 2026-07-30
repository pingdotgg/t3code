import * as AWS from "@/AWS";
import { WorkGroup } from "@/AWS/Athena/WorkGroup.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as athena from "@distilled.cloud/aws/athena";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const wgName = "alchemy-test-athena-wg-lifecycle";

const getWorkGroup = athena.getWorkGroup({ WorkGroup: wgName }).pipe(
  Effect.map((res) => res.WorkGroup),
  Effect.catchTag("WorkGroupNotFound", () => Effect.succeed(undefined)),
);

test.provider(
  "lifecycle: create with result config, update settings, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create — enforced result location + a bytes-scanned guardrail.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* WorkGroup("LifecycleWG", {
            workGroupName: wgName,
            outputLocation: "s3://alchemy-athena-wg-test-results/prefix/",
            enforceWorkGroupConfiguration: true,
            bytesScannedCutoffPerQuery: 10_000_000,
            tags: { env: "test" },
          });
        }),
      );
      expect(deployed.workGroupArn).toContain(`workgroup/${wgName}`);
      expect(deployed.state).toBe("ENABLED");

      // Out-of-band verification via distilled.
      const created = yield* getWorkGroup;
      expect(created?.Name).toBe(wgName);
      expect(created?.State).toBe("ENABLED");
      expect(created?.Configuration?.ResultConfiguration?.OutputLocation).toBe(
        "s3://alchemy-athena-wg-test-results/prefix/",
      );
      expect(created?.Configuration?.EnforceWorkGroupConfiguration).toBe(true);
      expect(created?.Configuration?.BytesScannedCutoffPerQuery).toBe(
        10_000_000,
      );

      // Tags applied.
      const tags = yield* athena.listTagsForResource({
        ResourceARN: deployed.workGroupArn,
      });
      expect(
        tags.Tags?.some((t) => t.Key === "env" && t.Value === "test"),
      ).toBe(true);

      // Canonical list() coverage.
      const provider = yield* Provider.findProvider(WorkGroup);
      const all = yield* provider.list();
      expect(all.some((wg) => wg.workGroupName === wgName)).toBe(true);

      // Update — remove the cutoff, disable, retag (in-place, no replacement).
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* WorkGroup("LifecycleWG", {
            workGroupName: wgName,
            outputLocation: "s3://alchemy-athena-wg-test-results/prefix/",
            enforceWorkGroupConfiguration: true,
            state: "DISABLED",
            tags: { env: "prod" },
          });
        }),
      );
      const updated = yield* getWorkGroup;
      expect(updated?.State).toBe("DISABLED");
      expect(
        updated?.Configuration?.BytesScannedCutoffPerQuery,
      ).toBeUndefined();
      const updatedTags = yield* athena.listTagsForResource({
        ResourceARN: deployed.workGroupArn,
      });
      expect(
        updatedTags.Tags?.some((t) => t.Key === "env" && t.Value === "prod"),
      ).toBe(true);

      // Destroy — provider recursively deletes and it's gone.
      yield* stack.destroy();
      const after = yield* getWorkGroup;
      expect(after).toBeUndefined();
    }),
  { timeout: 180_000 },
);
