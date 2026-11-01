import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
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

const waitUntilGone = (name: string) =>
  networksecurity.getOrganizationsLocationsFirewallEndpoints({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getOrganizationsLocationsFirewallEndpoints on a missing endpoint fails with NotFound (Forbidden without org IAM)",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const resource = yield* resourcemanager.getProjects({
        name: `projects/${project}`,
      });
      const parent = resource.parent ?? "organizations/0";
      const organization = parent.startsWith("organizations/")
        ? parent.slice("organizations/".length)
        : "0";
      const error = yield* Effect.flip(
        networksecurity.getOrganizationsLocationsFirewallEndpoints({
          name: `organizations/${organization}/locations/us-central1-a/firewallEndpoints/alchemy-missing-fwep`,
        }),
      );
      expect(error._tag).toEqual(
        process.env.GCP_TEST_ORG_NETWORKSECURITY ? "NotFound" : "Forbidden",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 90_000,
  },
);

// The testing credentials lack org-level Network Security IAM (Forbidden:
// "Permission 'networksecurity.….get' denied on 'organizations/…'"). Set
// GCP_TEST_ORG_NETWORKSECURITY=1 when they administer the organization.
test.provider.skipIf(!!process.env.GCP_TEST_ORG_NETWORKSECURITY)(
  "createOrganizationsLocationsFirewallEndpoints without org IAM fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const resource = yield* resourcemanager.getProjects({
        name: `projects/${project}`,
      });
      const parent = resource.parent ?? "organizations/0";
      const organization = parent.startsWith("organizations/")
        ? parent.slice("organizations/".length)
        : "0";
      const error = yield* Effect.flip(
        networksecurity.createOrganizationsLocationsFirewallEndpoints({
          parent: `organizations/${organization}/locations/us-central1-a`,
          firewallEndpointId: "alchemy-org-fwep-probe",
          body: { billingProjectId: project },
        }),
      );
      expect(error._tag).toBe("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(
  !!process.env.FAST || !process.env.GCP_TEST_ORG_NETWORKSECURITY,
)(
  "create, update, and delete an organization firewall endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkSecurity.OrganizationsFirewallEndpoint(
            "Ngfw",
            {
              location: "us-central1-a",
              description: "fwep a",
              labels: { env: "test" },
            },
          );
        }),
      );

      expect(created.name).toContain("/firewallEndpoints/");
      expect(created.name).toContain("organizations/");
      expect(created.location).toEqual("us-central1-a");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* networksecurity.getOrganizationsLocationsFirewallEndpoints({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkSecurity.OrganizationsFirewallEndpoint(
            "Ngfw",
            {
              firewallEndpointId: created.firewallEndpointId,
              organization: created.organization,
              location: "us-central1-a",
              billingProjectId: created.billingProjectId,
              description: "fwep b",
              labels: { env: "prod", role: "ngfw" },
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("fwep b");
      expect(updated.labels).toMatchObject({ env: "prod", role: "ngfw" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networksecurity", "live"],
    timeout: 120_000,
  },
);
