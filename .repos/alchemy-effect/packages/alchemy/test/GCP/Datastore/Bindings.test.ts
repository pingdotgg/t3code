import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as crm from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as datastore from "@distilled.cloud/gcp/datastore_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import DatastoreBindingsHost, {
  apiDatabaseId,
  COMMITTED,
  SEEDED,
  Tasks,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "DatastoreBindings");

let baseUrl: string;
let hostAccount: string;
let project: string;
let databaseName: string;
let databaseId: string;

const keyOf = (path: { kind: string; name: string }) => ({
  partitionId: { projectId: project, databaseId },
  path: [path],
});

/** Named databases require the routing header. */
const requestParams = () =>
  databaseId.length > 0
    ? `project_id=${project}&database_id=${databaseId}`
    : undefined;

/** Look an entity up out of band, as the deployer. */
const lookupOutOfBand = (path: { kind: string; name: string }) =>
  datastore.lookupProjects({
    projectId: project,
    requestParams: requestParams(),
    body: { databaseId, keys: [keyOf(path)] },
  });

/** Seed the entity the Lookup / RunQuery probes read, as the deployer. */
const seed = Effect.suspend(() =>
  datastore.commitProjects({
    projectId: project,
    requestParams: requestParams(),
    body: {
      databaseId,
      mode: "NON_TRANSACTIONAL",
      mutations: [
        {
          upsert: {
            key: keyOf(SEEDED),
            properties: { title: { stringValue: "seeded" } },
          },
        },
      ],
    },
  }),
);

/**
 * The host's project-level grants. Datastore has no per-database IAM
 * policy, so each binding grants its role on the project under an IAM
 * Condition matching only the bound database and its children.
 */
const projectGrants = Effect.gen(function* () {
  const policy = yield* crm.getIamPolicyProjects({
    resource: `projects/${project}`,
    body: { options: { requestedPolicyVersion: 3 } },
  });
  return (policy.bindings ?? [])
    .filter((binding) =>
      (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
    )
    .map((binding) => ({
      role: binding.role,
      condition: binding.condition?.expression,
    }))
    .sort((a, b) => (a.role ?? "").localeCompare(b.role ?? ""));
});

const expectScopedGrants = Effect.gen(function* () {
  const condition = `resource.name == "${databaseName}" || resource.name.startsWith("${databaseName}/")`;
  expect(yield* projectGrants).toEqual([
    { role: "roles/datastore.user", condition },
    { role: "roles/datastore.viewer", condition },
  ]);
});

describe.skipIf(!dockerAvailable || !!process.env.FAST)(
  "Datastore Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:datastore",
      "provider:gcp:firestore",
      "provider:gcp:run",
      "live",
    ],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* DatastoreBindingsHost;
            const database = yield* Tasks;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              name: database.name,
              project: database.project,
              databaseId: database.databaseId,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        project = out.project;
        databaseName = out.name;
        databaseId = apiDatabaseId(out.databaseId);
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("Commit", () => {
      test.provider(
        "upserts an entity as the host's service account, scoped to the database",
        (_stack) =>
          Effect.gen(function* () {
            const committed = yield* expectProbe<datastore.CommitResponse>(
              baseUrl,
              "commit",
            );
            expect(committed.mutationResults?.length).toEqual(1);

            const found = yield* lookupOutOfBand(COMMITTED);
            expect(
              found.found?.map(
                (result) => result.entity?.properties?.title?.stringValue,
              ),
            ).toEqual(["committed"]);

            yield* expectScopedGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:datastore", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("Lookup", () => {
      test.provider(
        "reads the seeded entity as the host's service account, scoped to the database",
        (_stack) =>
          Effect.gen(function* () {
            yield* seed;
            const found = yield* expectProbe<datastore.LookupResponse>(
              baseUrl,
              "lookup",
            );
            expect(
              found.found?.map(
                (result) => result.entity?.properties?.title?.stringValue,
              ),
            ).toEqual(["seeded"]);
            expect(found.missing ?? []).toEqual([]);

            yield* expectScopedGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:datastore", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("RunQuery", () => {
      test.provider(
        "queries the seeded kind as the host's service account, scoped to the database",
        (_stack) =>
          Effect.gen(function* () {
            yield* seed;
            const page = yield* expectProbe<datastore.RunQueryResponse>(
              baseUrl,
              "runQuery",
            );
            expect(
              page.batch?.entityResults?.map(
                (result) => result.entity?.key?.path?.[0]?.name,
              ),
            ).toEqual([SEEDED.name]);

            yield* expectScopedGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:datastore", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
