import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import { quotaTolerant } from "./parent.ts";
import * as Test from "@/Test/Alchemy";
import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Identity mapping stores need a workforce identity provider configured for
// the project (BadRequest "IdP must be configured before creating an Identity
// Mapping Store"). Set GCP_TEST_DISCOVERYENGINE_IDP=1 once one is configured.
const runLifecycle = !!process.env.GCP_TEST_DISCOVERYENGINE_IDP;

const waitUntilGone = (name: string) =>
  discoveryengine.getProjectsLocationsIdentityMappingStores({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsIdentityMappingStores on a missing store fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        discoveryengine.getProjectsLocationsIdentityMappingStores({
          name: `projects/${project}/locations/global/identityMappingStores/alchemy-ims-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:discoveryengine", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "createProjectsLocationsIdentityMappingStores without an IdP is rejected with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        discoveryengine.createProjectsLocationsIdentityMappingStores({
          parent: `projects/${project}/locations/global`,
          identityMappingStoreId: "alchemyimismissing",
          disableCmek: true,
          body: {
            name: `projects/${project}/locations/global/identityMappingStores/alchemyimismissing`,
          },
        }),
      );
      expect(error._tag).toEqual("IdentityProviderNotConfigured");

      yield* stack.destroy();
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:discoveryengine", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete an identity mapping store",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.DiscoveryEngine.IdentityMappingStore("Users", {
            location: "global",
            disableCmek: true,
          });
        }),
      );

      expect(created.name).toContain("/identityMappingStores/");
      expect(created.identityMappingStoreId.startsWith("alch")).toEqual(true);
      expect(created.location).toEqual("global");

      const fetched =
        yield* discoveryengine.getProjectsLocationsIdentityMappingStores({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, quotaTolerant),
  {
    tags: ["provider:gcp", "provider:gcp:discoveryengine", "live"],
    timeout: 120_000,
  },
);
