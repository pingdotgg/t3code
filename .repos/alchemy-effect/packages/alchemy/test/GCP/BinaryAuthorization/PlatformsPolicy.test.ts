import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as binaryauthorization from "@distilled.cloud/gcp/binaryauthorization_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, currentProject } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  binaryauthorization.getProjectsPlatformsPolicies({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsPlatformsPolicies on a missing policy fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const project = yield* currentProject;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        binaryauthorization.getProjectsPlatformsPolicies({
          name: `projects/${project}/platforms/gke/policies/alchemy-missing-policy`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:binaryauthorization", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete a platform policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.BinaryAuthorization.PlatformsPolicy("Default", {
            description: "initial",
            gkePolicy: {
              imageAllowlist: {
                allowPattern: ["gcr.io/google-containers/*"],
              },
            },
          });
        }),
      );

      expect(created.name).toContain("/platforms/gke/policies/");
      expect(created.policyId).toEqual(expect.any(String));
      expect(created.platform).toEqual("gke");
      expect(created.description).toEqual("initial");
      expect(created.gkePolicy?.imageAllowlist?.allowPattern).toContain(
        "gcr.io/google-containers/*",
      );

      const fetched = yield* binaryauthorization.getProjectsPlatformsPolicies({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("initial");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.BinaryAuthorization.PlatformsPolicy("Default", {
            policyId: created.policyId,
            platform: "gke",
            description: "updated",
            gkePolicy: {
              imageAllowlist: {
                allowPattern: [
                  "gcr.io/google-containers/*",
                  "gcr.io/google-containers/**",
                ],
              },
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("updated");
      expect(updated.gkePolicy?.imageAllowlist?.allowPattern).toEqual([
        "gcr.io/google-containers/*",
        "gcr.io/google-containers/**",
      ]);

      const fetchedUpdate =
        yield* binaryauthorization.getProjectsPlatformsPolicies({
          name: updated.name,
        });
      expect(fetchedUpdate.description).toContain("updated");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:binaryauthorization", "live"],
    timeout: 90_000,
  },
);
