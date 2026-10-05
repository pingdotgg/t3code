import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as apihub from "@distilled.cloud/gcp/apihub_v1";
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

// Needs a provisioned API Hub instance in us-central1 (one per project,
// behind a host project registration); without one writes fail with
// BadRequest ("Invalid resource state … API Hub instance …"). Set
// GCP_TEST_APIHUB_INSTANCE=1 when the hub exists.
const runLifecycle = !!process.env.GCP_TEST_APIHUB_INSTANCE;
const location = "us-central1";

const waitUntilGone = (name: string) =>
  apihub.getProjectsLocationsDependencies({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsDependencies on a missing dependency fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apihub.getProjectsLocationsDependencies({
          name: `projects/${project}/locations/${location}/dependencies/alchemy-missing-dep`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apihub", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an API Hub dependency",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const consumerApi = yield* GCP.ApiHub.Api("Consumer", {
            location,
            displayName: "consumer",
          });
          const supplierApi = yield* GCP.ApiHub.Api("Supplier", {
            location,
            displayName: "supplier",
          });
          const consumerVersion = yield* GCP.ApiHub.ApisVersion("ConsumerV1", {
            api: consumerApi.name,
            location,
            displayName: "v1",
          });
          const supplierVersion = yield* GCP.ApiHub.ApisVersion("SupplierV1", {
            api: supplierApi.name,
            location,
            displayName: "v1",
          });
          const consumerOp = yield* GCP.ApiHub.ApisVersionsOperation(
            "ListPets",
            {
              version: consumerVersion.name,
              location,
              details: {
                httpOperation: {
                  method: "GET",
                  path: { path: "/pets" },
                },
                description: "list pets",
              },
            },
          );
          const supplierOp = yield* GCP.ApiHub.ApisVersionsOperation("GetPet", {
            version: supplierVersion.name,
            location,
            details: {
              httpOperation: {
                method: "GET",
                path: { path: "/pets/{id}" },
              },
              description: "get pet",
            },
          });
          const dependency = yield* GCP.ApiHub.Dependency("Calls", {
            location,
            description: "listPets calls getPet",
            consumer: { operationResourceName: consumerOp.name },
            supplier: { operationResourceName: supplierOp.name },
          });
          return { consumerOp, supplierOp, dependency };
        }),
      );

      expect(created.dependency.name).toContain("/dependencies/");
      expect(created.dependency.consumer?.operationResourceName).toEqual(
        created.consumerOp.name,
      );
      expect(created.dependency.supplier?.operationResourceName).toEqual(
        created.supplierOp.name,
      );
      expect(created.dependency.description).toEqual("listPets calls getPet");

      const fetched = yield* apihub.getProjectsLocationsDependencies({
        name: created.dependency.name,
      });
      expect(fetched.name).toEqual(created.dependency.name);
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const consumerApi = yield* GCP.ApiHub.Api("Consumer", {
            location,
            displayName: "consumer",
          });
          const supplierApi = yield* GCP.ApiHub.Api("Supplier", {
            location,
            displayName: "supplier",
          });
          const consumerVersion = yield* GCP.ApiHub.ApisVersion("ConsumerV1", {
            api: consumerApi.name,
            location,
            displayName: "v1",
          });
          const supplierVersion = yield* GCP.ApiHub.ApisVersion("SupplierV1", {
            api: supplierApi.name,
            location,
            displayName: "v1",
          });
          const consumerOp = yield* GCP.ApiHub.ApisVersionsOperation(
            "ListPets",
            {
              version: consumerVersion.name,
              location,
              details: {
                httpOperation: {
                  method: "GET",
                  path: { path: "/pets" },
                },
                description: "list pets",
              },
            },
          );
          const supplierOp = yield* GCP.ApiHub.ApisVersionsOperation("GetPet", {
            version: supplierVersion.name,
            location,
            details: {
              httpOperation: {
                method: "GET",
                path: { path: "/pets/{id}" },
              },
              description: "get pet",
            },
          });
          const dependency = yield* GCP.ApiHub.Dependency("Calls", {
            dependencyId: created.dependency.dependencyId,
            location,
            description: "listPets still calls getPet",
            consumer: { operationResourceName: consumerOp.name },
            supplier: { operationResourceName: supplierOp.name },
          });
          return { consumerOp, supplierOp, dependency };
        }),
      );

      expect(updated.dependency.name).toEqual(created.dependency.name);
      expect(updated.dependency.description).toEqual(
        "listPets still calls getPet",
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.dependency.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apihub", "live"], timeout: 90_000 },
);
