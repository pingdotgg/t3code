import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as bigquery from "@distilled.cloud/gcp/bigquery_v2";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

/**
 * Grants on services without a per-resource `setIamPolicy`: BigQuery
 * datasets (the dataset access list) and Firestore databases (a project
 * grant under an IAM Condition naming the database). Image-only hosts, so
 * no container build is needed.
 */

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const HELLO_IMAGE = "us-docker.pkg.dev/cloudrun/container/hello";

const Warehouse = GCP.BigQuery.Dataset("ScopedWarehouse", {
  location: "US-CENTRAL1",
  forceDestroy: true,
});

const Docs = GCP.Firestore.Database("ScopedDocs", {
  location: "us-central1",
  type: "FIRESTORE_NATIVE",
});

class ScopedService extends GCP.Function<ScopedService>()(
  "ScopedService",
  {
    location: "us-central1",
    template: { containers: [{ image: HELLO_IMAGE }] },
  },
  Effect.gen(function* () {
    yield* GCP.BigQuery.Query(Warehouse);
    yield* GCP.Firestore.ReadWriteDatabase(Docs);
    return {};
  }).pipe(
    Effect.provide(GCP.BigQuery.QueryHttp),
    Effect.provide(GCP.Firestore.ReadWriteDatabaseHttp),
  ),
) {}

const rolesOf = (
  bindings: ReadonlyArray<{
    role?: string;
    members?: ReadonlyArray<string>;
    condition?: unknown;
  }>,
  member: string,
) =>
  bindings
    .filter((binding) => (binding.members ?? []).includes(member))
    .map((binding) => ({
      role: binding.role,
      condition: (binding.condition as { expression?: string } | undefined)
        ?.expression,
    }));

test.provider(
  "dataset grants use the access list; Firestore grants are conditioned on the database",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const service = yield* ScopedService;
          const dataset = yield* Warehouse;
          const docs = yield* Docs;
          return {
            database: docs.name,
            project: service.project,
            serviceAccount: service.serviceAccount,
            datasetId: dataset.datasetId,
          };
        }),
      );
      const email = out.serviceAccount!;

      const projectPolicy = yield* resourcemanager.getIamPolicyProjects({
        resource: `projects/${out.project}`,
        body: { options: { requestedPolicyVersion: 3 } },
      });
      // bigquery.jobs.create is project-only; data access is not.
      expect(
        rolesOf(projectPolicy.bindings ?? [], `serviceAccount:${email}`),
      ).toEqual(
        expect.arrayContaining([
          { role: "roles/bigquery.jobUser", condition: undefined },
          // Firestore has no per-database policy: a project grant scoped
          // to this database by an IAM Condition.
          {
            role: "roles/datastore.user",
            condition: `resource.name == "${out.database}" || resource.name.startsWith("${out.database}/")`,
          },
        ]),
      );
      expect(
        rolesOf(projectPolicy.bindings ?? [], `serviceAccount:${email}`),
      ).toHaveLength(2);

      const dataset = yield* bigquery.getDatasets({
        projectId: out.project,
        datasetId: out.datasetId,
      });
      expect(
        (dataset.access ?? []).filter((item) => item.userByEmail === email),
        // BigQuery stores roles/bigquery.dataViewer as the legacy READER.
      ).toEqual([{ role: "READER", userByEmail: email }]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:run", "live"], timeout: 240_000 },
);
