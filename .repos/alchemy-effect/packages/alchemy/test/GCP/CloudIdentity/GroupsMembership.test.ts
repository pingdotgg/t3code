import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cloudidentity from "@distilled.cloud/gcp/cloudidentity_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  customer,
  domain,
  logLevel,
  memberEmail,
  runMembershipLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  cloudidentity.getGroupsMemberships({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getGroupsMemberships on a missing membership fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cloudidentity.getGroupsMemberships({
          name: "groups/alchemy-missing-group/memberships/alchemy-missing",
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

test.provider.skipIf(!!process.env.GCP_TEST_CLOUDIDENTITY)(
  "createGroupsMemberships without Cloud Identity access fails with a typed entitlement error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cloudidentity.createGroupsMemberships({
          parent: "groups/alchemy-missing-group",
          body: {
            preferredMemberKey: { id: "probe@example.com" },
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

test.provider.skipIf(!runMembershipLifecycle)(
  "create, update, and delete a membership",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* GCP.CloudIdentity.Group("Eng", {
            parent: customer,
            domain,
            displayName: "Engineering",
          });
          const membership = yield* GCP.CloudIdentity.GroupsMembership("Ada", {
            parent: group.name,
            memberKeyId: memberEmail!,
            roles: [{ name: "MEMBER" }],
          });
          return { group, membership };
        }),
      );

      expect(created.membership.name).toContain("/memberships/");
      expect(created.membership.memberKeyId).toEqual(memberEmail);
      expect(
        created.membership.roles.some((role) => role.name === "MEMBER"),
      ).toEqual(true);

      const fetched = yield* cloudidentity.getGroupsMemberships({
        name: created.membership.name,
      });
      expect(fetched.name).toEqual(created.membership.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* GCP.CloudIdentity.Group("Eng", {
            parent: customer,
            groupKeyId: created.group.groupKeyId,
            displayName: "Engineering",
          });
          const membership = yield* GCP.CloudIdentity.GroupsMembership("Ada", {
            parent: group.name,
            memberKeyId: memberEmail!,
            roles: [{ name: "MEMBER" }, { name: "MANAGER" }],
          });
          return { group, membership };
        }),
      );

      expect(updated.membership.name).toEqual(created.membership.name);
      expect(
        updated.membership.roles.some((role) => role.name === "MANAGER"),
      ).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.membership.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudidentity", "live"],
    timeout: 90_000,
  },
);
