import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cloudidentity from "@distilled.cloud/gcp/cloudidentity_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { customer, domain, logLevel, runGroupLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  cloudidentity.getGroups({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getGroups on a missing group fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cloudidentity.getGroups({ name: "groups/alchemy-missing-group" }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudidentity", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!!process.env.GCP_TEST_CLOUDIDENTITY)(
  "createGroups without Cloud Identity access fails with a typed entitlement error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cloudidentity.createGroups({
          initialGroupConfig: "EMPTY",
          body: {
            parent: customer,
            groupKey: { id: "alchemy-probe@example.com" },
            labels: {
              "cloudidentity.googleapis.com/groups.discussion_forum": "",
            },
            displayName: "Alchemy Cloud Identity Probe",
          },
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudidentity", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runGroupLifecycle)(
  "create, update, and delete a group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudIdentity.Group("Eng", {
            parent: customer,
            domain,
            displayName: "Engineering",
            description: "product engineering",
          });
        }),
      );

      expect(created.name.startsWith("groups/")).toEqual(true);
      expect(created.displayName).toEqual("Engineering");
      expect(created.description).toEqual("product engineering");
      expect(created.groupKeyId).toContain("@");

      const fetched = yield* cloudidentity.getGroups({ name: created.name });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("product engineering");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudIdentity.Group("Eng", {
            parent: customer,
            groupKeyId: created.groupKeyId,
            displayName: "Engineering 2026",
            description: "product engineering and platform",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("Engineering 2026");
      expect(updated.description).toEqual("product engineering and platform");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudidentity", "live"],
    timeout: 90_000,
  },
);
