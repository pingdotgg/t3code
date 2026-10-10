import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as iap from "@distilled.cloud/gcp/iap_v1";
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

// IAP OAuth clients hang off an OAuth brand, which only an org-internal project
// with a Workspace support email can create (createProjectsBrands otherwise
// fails with BadRequest "invalid argument", see probe). Set GCP_TEST_IAP_BRAND
// to an existing brand name (projects/{number}/brands/{id}) to run it.
const brandName = process.env.GCP_TEST_IAP_BRAND?.trim();

const waitUntilGone = (name: string) =>
  iap.getProjectsBrandsIdentityAwareProxyClients({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsBrandsIdentityAwareProxyClients on a missing client fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        iap.getProjectsBrandsIdentityAwareProxyClients({
          name: `projects/${project}/brands/1/identityAwareProxyClients/missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:iap", "live"], timeout: 90_000 },
);

test.provider.skipIf(!!brandName)(
  "createProjectsBrands without a Workspace support email fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        iap.createProjectsBrands({
          parent: `projects/${project}`,
          body: {
            applicationTitle: "Alchemy IAP probe",
            supportEmail: "iap@example.com",
          },
        }),
      );
      expect(error._tag).toEqual("BadRequest");
      expect(error.message).toContain("invalid argument");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:iap", "live"], timeout: 90_000 },
);

test.provider.skipIf(!!brandName)(
  "createProjectsBrandsIdentityAwareProxyClients without a Workspace brand fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        iap.createProjectsBrandsIdentityAwareProxyClients({
          parent: `projects/${project}/brands/missing`,
          body: { displayName: "Alchemy IAP client probe" },
        }),
      );
      expect(error._tag).toEqual("BadRequest");
      expect(error.message).toContain(
        "Unable to parse project number and brand",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:iap", "live"], timeout: 90_000 },
);

test.provider.skipIf(!brandName)(
  "create, replace, and delete an IAP OAuth client",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const brand = brandName!;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.IAP.BrandsIdentityAwareProxyClient("Console", {
            brand,
            displayName: "Alchemy console",
          });
        }),
      );

      expect(created.name).toContain("/identityAwareProxyClients/");
      expect(created.brand).toEqual(brand);
      expect(created.displayName).toEqual("Alchemy console");
      expect(created.identityAwareProxyClientId.length).toBeGreaterThan(0);

      const fetched = yield* iap.getProjectsBrandsIdentityAwareProxyClients({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("[alchemy ");
      expect(fetched.displayName).toContain("Alchemy console");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.IAP.BrandsIdentityAwareProxyClient("Console", {
            brand,
            displayName: "Alchemy portal",
          });
        }),
      );

      expect(replaced.displayName).toEqual("Alchemy portal");
      expect(replaced.brand).toEqual(brand);

      const fetchedReplace =
        yield* iap.getProjectsBrandsIdentityAwareProxyClients({
          name: replaced.name,
        });
      expect(fetchedReplace.displayName).toContain("Alchemy portal");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:iap", "live"], timeout: 90_000 },
);
