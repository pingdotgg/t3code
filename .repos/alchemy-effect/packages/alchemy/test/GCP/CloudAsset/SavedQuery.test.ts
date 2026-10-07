import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cloudasset from "@distilled.cloud/gcp/cloudasset_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const projectNumber = Effect.gen(function* () {
  const { project } = yield* GcpEnvironment.current;
  const resource = yield* resourcemanager.getProjects({
    name: `projects/${project}`,
  });
  const parts = (resource.name ?? "").split("/");
  return parts[parts.length - 1] || project;
});

const waitUntilGone = (name: string) =>
  cloudasset.getSavedQueries({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getSavedQueries on a missing query fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const number = yield* projectNumber;
      const error = yield* Effect.flip(
        cloudasset.getSavedQueries({
          name: `projects/${number}/savedQueries/alchemy-missing-query`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudasset", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete a saved query",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudAsset.SavedQuery("IamAudit", {
            description: "who can act as service accounts",
            labels: { env: "test" },
            content: {
              iamPolicyAnalysisQuery: {
                scope: `projects/${project}`,
                accessSelector: {
                  permissions: ["iam.serviceAccounts.actAs"],
                },
              },
            },
          });
        }),
      );

      expect(created.name).toContain("/savedQueries/");
      expect(created.savedQueryId).toEqual(expect.any(String));
      expect(created.description).toEqual("who can act as service accounts");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(
        created.content?.iamPolicyAnalysisQuery?.accessSelector?.permissions,
      ).toEqual(expect.arrayContaining(["iam.serviceAccounts.actAs"]));

      const fetched = yield* cloudasset.getSavedQueries({ name: created.name });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toEqual("who can act as service accounts");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudAsset.SavedQuery("IamAudit", {
            savedQueryId: created.savedQueryId,
            description: "roles and permissions",
            labels: { env: "prod", role: "audit" },
            content: {
              iamPolicyAnalysisQuery: {
                scope: `projects/${project}`,
                accessSelector: {
                  roles: ["roles/owner"],
                },
              },
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.savedQueryId).toEqual(created.savedQueryId);
      expect(updated.description).toEqual("roles and permissions");
      expect(updated.labels).toMatchObject({ env: "prod", role: "audit" });
      expect(
        updated.content?.iamPolicyAnalysisQuery?.accessSelector?.roles,
      ).toEqual(expect.arrayContaining(["roles/owner"]));

      const refetched = yield* cloudasset.getSavedQueries({
        name: created.name,
      });
      expect(refetched.description).toEqual("roles and permissions");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("audit");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudasset", "live"],
    timeout: 90_000,
  },
);
