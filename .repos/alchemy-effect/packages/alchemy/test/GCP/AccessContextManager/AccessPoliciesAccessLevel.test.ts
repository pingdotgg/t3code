import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as acm from "@distilled.cloud/gcp/accesscontextmanager_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, projectContext, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  acm.getAccessPoliciesAccessLevels({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getAccessPoliciesAccessLevels on an inaccessible level fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        acm.getAccessPoliciesAccessLevels({
          name: "accessPolicies/123456789012/accessLevels/alchemy_missing_level",
        }),
      );
      expect(error._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:accesscontextmanager", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an access level",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const ctx = yield* projectContext();
      const scopes =
        ctx.projectNumber.length > 0
          ? [`projects/${ctx.projectNumber}`]
          : undefined;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const policy = yield* GCP.AccessContextManager.AccessPolicy(
            "LevelPolicy",
            {
              title: "access level policy",
              scopes,
            },
          );
          const level =
            yield* GCP.AccessContextManager.AccessPoliciesAccessLevel(
              "CorpUsers",
              {
                policy: policy.name,
                title: "corp users",
                description: "us region",
                basic: { conditions: [{ regions: ["US"] }] },
              },
            );
          return { policy, level };
        }),
      );

      expect(created.level.name).toContain("/accessLevels/");
      expect(created.level.policy).toEqual(created.policy.name);
      expect(created.level.title).toEqual("corp users");
      expect(created.level.description).toEqual("us region");
      expect(created.level.basic?.conditions?.[0]?.regions).toContain("US");

      const fetched = yield* acm.getAccessPoliciesAccessLevels({
        name: created.level.name,
      });
      expect(fetched.name).toEqual(created.level.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("us region");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const policy = yield* GCP.AccessContextManager.AccessPolicy(
            "LevelPolicy",
            {
              title: "access level policy",
              scopes,
            },
          );
          const level =
            yield* GCP.AccessContextManager.AccessPoliciesAccessLevel(
              "CorpUsers",
              {
                policy: policy.name,
                accessLevelId: created.level.accessLevelId,
                title: "corp users prod",
                description: "ca region",
                basic: { conditions: [{ regions: ["CA"] }] },
              },
            );
          return { policy, level };
        }),
      );

      expect(updated.level.name).toEqual(created.level.name);
      expect(updated.level.title).toEqual("corp users prod");
      expect(updated.level.description).toEqual("ca region");
      expect(updated.level.basic?.conditions?.[0]?.regions).toContain("CA");

      const fetchedUpdate = yield* acm.getAccessPoliciesAccessLevels({
        name: updated.level.name,
      });
      expect(fetchedUpdate.description).toContain("ca region");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.level.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:accesscontextmanager", "live"],
    timeout: 120_000,
  },
);
