import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as vmwareengine from "@distilled.cloud/gcp/vmwareengine_v1";
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

// Private clouds need VMware Engine node quota and bill thousands of dollars
// a month; set GCP_TEST_VMWAREENGINE=1 on an entitled project to opt in.
const runLifecycle = !!process.env.GCP_TEST_VMWAREENGINE && !process.env.FAST;

const waitUntilGone = (name: string) =>
  vmwareengine.getProjectsLocationsDatastores({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsDatastores on a missing datastore fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmwareengine.getProjectsLocationsDatastores({
          name: `projects/${project}/locations/us-central1/datastores/alchemy-ds-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:vmwareengine", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a datastore",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.VMwareEngine.Datastore("Nfs", {
            nfsDatastore: {
              thirdPartyFileService: {
                servers: ["10.0.0.8"],
                network: `projects/${project}/global/networks/default`,
                fileShare: "vol1",
              },
            },
            description: "alchemy-test-ds",
          });
        }),
      );

      expect(created.name).toContain("/datastores/");
      expect(created.datastoreId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.description).toEqual("alchemy-test-ds");

      const fetched = yield* vmwareengine.getProjectsLocationsDatastores({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("alchemy-test-ds");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.VMwareEngine.Datastore("Nfs", {
            datastoreId: created.datastoreId,
            nfsDatastore: created.nfsDatastore ?? {
              thirdPartyFileService: {
                servers: ["10.0.0.8"],
                network: `projects/${project}/global/networks/default`,
                fileShare: "vol1",
              },
            },
            description: "alchemy-prod-ds",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("alchemy-prod-ds");

      const refetched = yield* vmwareengine.getProjectsLocationsDatastores({
        name: created.name,
      });
      expect(refetched.description).toContain("alchemy-prod-ds");
      expect(refetched.description).toContain("alchemy-id=");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:vmwareengine", "live"],
    timeout: 120_000,
  },
);
