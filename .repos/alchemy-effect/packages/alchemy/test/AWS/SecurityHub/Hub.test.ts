import * as AWS from "@/AWS";
import { Hub } from "@/AWS/SecurityHub/Hub.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as securityhub from "@distilled.cloud/aws/securityhub";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { makeSecurityHubTestLease } from "./TestLease.ts";

const { test, beforeAll, afterAll } = Test.make({ providers: AWS.providers() });
const testLease = makeSecurityHubTestLease();

beforeAll(testLease.acquire, { timeout: 240_000 });
afterAll(testLease.release);

// `describeHub` throws `InvalidAccessException` when the account is not
// subscribed to Security Hub.
const describeHub = securityhub.describeHub({}).pipe(
  Effect.map((hub) => hub as securityhub.DescribeHubResponse | undefined),
  Effect.catchTag("InvalidAccessException", () => Effect.succeed(undefined)),
  Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)),
);

// The Security Hub Hub is an account/region singleton. This test only runs when
// the account is not already subscribed — it must never disable a Hub the user
// already operates (capture-and-restore safety).
test.provider(
  "lifecycle: enable Security Hub, update config, disable",
  (stack) =>
    Effect.gen(function* () {
      // Destroy OUR previous resources first — a crashed prior run leaves the
      // test's own Hub enabled, which must not be mistaken for a foreign one.
      yield* stack.destroy();

      const preexisting = yield* describeHub;
      if (preexisting) {
        yield* Effect.logInfo(
          `Security Hub already enabled (${preexisting.HubArn}) — skipping destructive lifecycle test`,
        );
        return;
      }

      // Create — enable without default standards to keep the test cheap/fast.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hub("Hub", {
            enableDefaultStandards: false,
            controlFindingGenerator: "SECURITY_CONTROL",
            tags: { env: "test" },
          });
        }),
      );
      expect(created.hubArn).toContain(":hub/default");

      // Out-of-band verification.
      const live = yield* securityhub.describeHub({});
      expect(live.HubArn).toBe(created.hubArn);
      const tags = yield* securityhub.listTagsForResource({
        ResourceArn: created.hubArn,
      });
      expect(tags.Tags?.["env"]).toBe("test");
      expect(tags.Tags?.["alchemy::id"]).toBe("Hub");

      // Canonical list() coverage.
      const provider = yield* Provider.findProvider(Hub);
      const all = yield* provider.list();
      expect(all.some((h) => h.hubArn === created.hubArn)).toBe(true);

      // Update — flip auto-enable-controls + retag in place.
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hub("Hub", {
            enableDefaultStandards: false,
            autoEnableControls: false,
            controlFindingGenerator: "SECURITY_CONTROL",
            tags: { env: "prod" },
          });
        }),
      );
      const afterUpdate = yield* securityhub.describeHub({});
      expect(afterUpdate.AutoEnableControls).toBe(false);
      const updatedTags = yield* securityhub.listTagsForResource({
        ResourceArn: created.hubArn,
      });
      expect(updatedTags.Tags?.["env"]).toBe("prod");

      // Destroy — Security Hub is disabled and the account is unsubscribed.
      yield* stack.destroy();
      const after = yield* describeHub;
      expect(after).toBeUndefined();
    }),
  { timeout: 180_000 },
);
