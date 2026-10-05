import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cloudidentity from "@distilled.cloud/gcp/cloudidentity_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { customer, domain, logLevel, runGroupLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  cloudidentity.getInboundSsoAssignments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getInboundSsoAssignments on a missing assignment fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cloudidentity.getInboundSsoAssignments({
          name: "inboundSsoAssignments/alchemy-missing",
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
  "createInboundSsoAssignments without Cloud Identity access fails with a typed entitlement error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cloudidentity.createInboundSsoAssignments({
          body: {
            customer,
            targetGroup: "groups/alchemy-missing-group",
            ssoMode: "SSO_OFF",
            rank: 1,
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
  "create, update, and delete an SSO assignment on a group",
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
          const assignment = yield* GCP.CloudIdentity.InboundSsoAssignment(
            "EngSso",
            {
              customer,
              targetGroup: group.name,
              ssoMode: "SSO_OFF",
              rank: 1,
            },
          );
          return { group, assignment };
        }),
      );

      expect(
        created.assignment.name.startsWith("inboundSsoAssignments/"),
      ).toEqual(true);
      expect(created.assignment.ssoMode).toEqual("SSO_OFF");

      const fetched = yield* cloudidentity.getInboundSsoAssignments({
        name: created.assignment.name,
      });
      expect(fetched.name).toEqual(created.assignment.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* GCP.CloudIdentity.Group("Eng", {
            parent: customer,
            groupKeyId: created.group.groupKeyId,
            displayName: "Engineering",
          });
          const assignment = yield* GCP.CloudIdentity.InboundSsoAssignment(
            "EngSso",
            {
              customer,
              targetGroup: group.name,
              ssoMode: "SSO_OFF",
              rank: 2,
            },
          );
          return { group, assignment };
        }),
      );

      expect(updated.assignment.name).toEqual(created.assignment.name);
      expect(updated.assignment.rank).toEqual(2);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.assignment.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudidentity", "live"],
    timeout: 90_000,
  },
);
