import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as acm from "@distilled.cloud/gcp/accesscontextmanager_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, projectContext, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  acm.getAccessPoliciesServicePerimeters({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getAccessPoliciesServicePerimeters on an inaccessible perimeter fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        acm.getAccessPoliciesServicePerimeters({
          name: "accessPolicies/123456789012/servicePerimeters/alchemy_missing_perimeter",
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
  "create, update, and delete a service perimeter",
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
            "PerimeterPolicy",
            {
              title: "perimeter policy",
              scopes,
            },
          );
          const perimeter =
            yield* GCP.AccessContextManager.AccessPoliciesServicePerimeter(
              "Storage",
              {
                policy: policy.name,
                title: "storage perimeter",
                description: "storage only",
                status: {
                  restrictedServices: ["storage.googleapis.com"],
                },
              },
            );
          return { policy, perimeter };
        }),
      );

      expect(created.perimeter.name).toContain("/servicePerimeters/");
      expect(created.perimeter.policy).toEqual(created.policy.name);
      expect(created.perimeter.title).toEqual("storage perimeter");
      expect(created.perimeter.description).toEqual("storage only");
      expect(created.perimeter.status?.restrictedServices).toContain(
        "storage.googleapis.com",
      );

      const fetched = yield* acm.getAccessPoliciesServicePerimeters({
        name: created.perimeter.name,
      });
      expect(fetched.name).toEqual(created.perimeter.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("storage only");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const policy = yield* GCP.AccessContextManager.AccessPolicy(
            "PerimeterPolicy",
            {
              title: "perimeter policy",
              scopes,
            },
          );
          const perimeter =
            yield* GCP.AccessContextManager.AccessPoliciesServicePerimeter(
              "Storage",
              {
                policy: policy.name,
                servicePerimeterId: created.perimeter.servicePerimeterId,
                title: "data perimeter",
                description: "storage and bigquery",
                status: {
                  restrictedServices: [
                    "storage.googleapis.com",
                    "bigquery.googleapis.com",
                  ],
                },
              },
            );
          return { policy, perimeter };
        }),
      );

      expect(updated.perimeter.name).toEqual(created.perimeter.name);
      expect(updated.perimeter.title).toEqual("data perimeter");
      expect(updated.perimeter.description).toEqual("storage and bigquery");
      expect(updated.perimeter.status?.restrictedServices).toEqual(
        expect.arrayContaining([
          "storage.googleapis.com",
          "bigquery.googleapis.com",
        ]),
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.perimeter.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:accesscontextmanager", "live"],
    timeout: 120_000,
  },
);
