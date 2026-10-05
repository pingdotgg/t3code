import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cloudcontrolspartner from "@distilled.cloud/gcp/cloudcontrolspartner_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);
const location = "us-central1";

const organizationOf = () =>
  Effect.gen(function* () {
    const { project } = yield* GcpEnvironment.current;

    const fromEnv =
      process.env.GOOGLE_CLOUDCONTROLSPARTNER_ORGANIZATION ??
      process.env.GOOGLE_ORGANIZATION_ID;
    if (fromEnv && fromEnv.length > 0) {
      return fromEnv.startsWith("organizations/")
        ? fromEnv
        : `organizations/${fromEnv}`;
    }
    let current: string | undefined = `projects/${project}`;
    for (let i = 0; i < 8; i++) {
      if (current === undefined) return "";
      if (current.startsWith("organizations/")) return current;
      current = current.startsWith("projects/")
        ? yield* resourcemanager.getProjects({ name: current }).pipe(
            Effect.map((resource) => resource.parent),
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          )
        : current.startsWith("folders/")
          ? yield* resourcemanager.getFolders({ name: current }).pipe(
              Effect.map((folder) => folder.parent),
              Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
            )
          : undefined;
    }
    return "";
  });

const waitUntilGone = (name: string) =>
  cloudcontrolspartner.getOrganizationsLocationsCustomers({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const customerOrgId = (
  process.env.GOOGLE_CLOUDCONTROLSPARTNER_CUSTOMER_ID ?? ""
).trim();

// Cloud Controls Partner is for allow-listed Sovereign Cloud partners: without
// partner permissions on the organization every call answers 403 ("Permission
// ... denied ... (or it may not exist)"). Set GCP_TEST_CLOUDCONTROLSPARTNER=1
// and GOOGLE_CLOUDCONTROLSPARTNER_CUSTOMER_ID on a partner organization.
const runLifecycle =
  !process.env.FAST &&
  process.env.GCP_TEST_CLOUDCONTROLSPARTNER === "1" &&
  customerOrgId.length > 0;

test.provider.skipIf(!runLifecycle)(
  "getOrganizationsLocationsCustomers on a missing customer fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = (yield* organizationOf()) || "organizations/0";
      const error = yield* Effect.flip(
        cloudcontrolspartner.getOrganizationsLocationsCustomers({
          name: `${organization}/locations/${location}/customers/0`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudcontrolspartner", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runLifecycle)(
  "createOrganizationsLocationsCustomers without partner permissions fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = (yield* organizationOf()) || "organizations/0";
      const error = yield* Effect.flip(
        cloudcontrolspartner.createOrganizationsLocationsCustomers({
          parent: `${organization}/locations/${location}`,
          customerId: "0",
          body: { displayName: "Alchemy Cloudcontrolspartner Probe" },
        }),
      );
      expect(error._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudcontrolspartner", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a customer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = (yield* organizationOf()) || "organizations/0";
      const parent = `${organization}/locations/${location}`;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudControlsPartner.Customer("Acme", {
            organization,
            location,
            customerId: customerOrgId,
            displayName: "Acme Corp",
          });
        }),
      );

      expect(created.name).toEqual(`${parent}/customers/${customerOrgId}`);
      expect(created.customerId).toEqual(customerOrgId);
      expect(created.displayName).toEqual("Acme Corp");
      expect(created.location).toEqual(location);

      const fetched =
        yield* cloudcontrolspartner.getOrganizationsLocationsCustomers({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("[alchemy ");
      expect(fetched.displayName).toContain("Acme Corp");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudControlsPartner.Customer("Acme", {
            organization,
            location,
            customerId: created.customerId,
            displayName: "Acme Corporation",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("Acme Corporation");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudcontrolspartner", "live"],
    timeout: 90_000,
  },
);
