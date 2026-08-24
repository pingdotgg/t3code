import * as AWS from "@/AWS";
import { SyncConfiguration } from "@/AWS/CodeConnections/SyncConfiguration.ts";
import * as Test from "@/Test/Alchemy";
import * as codeconnections from "@distilled.cloud/aws/codeconnections";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// A sync configuration requires a repository link, which itself requires a
// connection in the AVAILABLE state — and completing a connection's OAuth
// handshake is a manual console step with no API. The ungated probe proves
// the read wiring end-to-end (typed NotFound from the real service); the
// full lifecycle is gated on a manually-provisioned repository link + role.
const REPOSITORY_LINK_ID = process.env.AWS_TEST_CODECONNECTIONS_REPO_LINK_ID;
const GIT_SYNC_ROLE_ARN = process.env.AWS_TEST_CODECONNECTIONS_SYNC_ROLE_ARN;

test.provider(
  "probe: reading a nonexistent sync configuration surfaces the typed NotFound",
  () =>
    Effect.gen(function* () {
      const tag = yield* codeconnections
        .getSyncConfiguration({
          SyncType: "CFN_STACK_SYNC",
          ResourceName: "alchemy-test-nonexistent-stack",
        })
        .pipe(
          Effect.map(() => "Found" as const),
          Effect.catchTag("ResourceNotFoundException", (e) =>
            Effect.succeed(e._tag),
          ),
        );
      expect(tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 60_000 },
);

test.provider.skipIf(!REPOSITORY_LINK_ID || !GIT_SYNC_ROLE_ARN)(
  "lifecycle: create stack sync, update trigger, destroy (gated: AWS_TEST_CODECONNECTIONS_REPO_LINK_ID)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* SyncConfiguration("StackSync", {
            branch: "main",
            configFile: "deployments/alchemy-test-stack.yaml",
            repositoryLinkId: REPOSITORY_LINK_ID!,
            resourceName: "alchemy-test-sync-stack",
            roleArn: GIT_SYNC_ROLE_ARN!,
          });
        }),
      );
      expect(deployed.syncType).toBe("CFN_STACK_SYNC");
      expect(deployed.resourceName).toBe("alchemy-test-sync-stack");
      expect(deployed.branch).toBe("main");

      // Update — trigger mode is mutable via UpdateSyncConfiguration.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* SyncConfiguration("StackSync", {
            branch: "main",
            configFile: "deployments/alchemy-test-stack.yaml",
            repositoryLinkId: REPOSITORY_LINK_ID!,
            resourceName: "alchemy-test-sync-stack",
            roleArn: GIT_SYNC_ROLE_ARN!,
            triggerResourceUpdateOn: "FILE_CHANGE",
          });
        }),
      );
      expect(updated.resourceName).toBe(deployed.resourceName);
      const observed = yield* codeconnections.getSyncConfiguration({
        SyncType: "CFN_STACK_SYNC",
        ResourceName: "alchemy-test-sync-stack",
      });
      expect(observed.SyncConfiguration.TriggerResourceUpdateOn).toBe(
        "FILE_CHANGE",
      );

      // Destroy — configuration is deleted; verify out-of-band.
      yield* stack.destroy();
      const after = yield* codeconnections
        .getSyncConfiguration({
          SyncType: "CFN_STACK_SYNC",
          ResourceName: "alchemy-test-sync-stack",
        })
        .pipe(
          Effect.map((res) => res.SyncConfiguration),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      expect(after).toBeUndefined();
    }),
  { timeout: 120_000 },
);
