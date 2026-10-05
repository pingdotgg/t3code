import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as scc from "@distilled.cloud/gcp/securitycenter_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const alwaysTrue = {
  predicate: { expression: 'resource.name == "alchemy-nonexistent"' },
  resourceSelector: {
    resourceTypes: ["compute.googleapis.com/Instance"],
  },
  severity: "LOW" as const,
  description: "always true",
  recommendation: "n/a",
};

const waitUntilGone = (name: string) =>
  scc
    .getOrganizationsSecurityHealthAnalyticsSettingsCustomModules({ name })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

// Organization-level Security Command Center needs SCC activated on the
// organization and org-level SCC roles for the test identity. Set
// GCP_TEST_SECURITY_CENTER=1 and GOOGLE_ORGANIZATION_ID when both hold.
const organizationId = process.env.GOOGLE_ORGANIZATION_ID;
const runLifecycle = !!process.env.GCP_TEST_SECURITY_CENTER && !!organizationId;

const organizationOf = () =>
  Effect.succeed(
    organizationId === undefined
      ? ""
      : organizationId.startsWith("organizations/")
        ? organizationId
        : `organizations/${organizationId}`,
  );

test.provider(
  "getOrganizationsSecurityHealthAnalyticsSettingsCustomModules on a missing module fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = (yield* organizationOf()) || "organizations/0";
      const error = yield* Effect.flip(
        scc.getOrganizationsSecurityHealthAnalyticsSettingsCustomModules({
          name: `${organization}/securityHealthAnalyticsSettings/customModules/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("ServiceDisabled");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:securitycenter", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an organization security health analytics custom module",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = yield* organizationOf();

      const parent = `${organization}/securityHealthAnalyticsSettings`;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SecurityCenter.OrganizationsSecurityHealthAnalyticsSettingsCustomModule(
            "AlwaysTrue",
            {
              organization,
              displayName: "AlchemyOrgAlwaysTrue",
              customConfig: alwaysTrue,
            },
          );
        }),
      );

      expect(created.moduleId).toEqual(expect.any(String));
      expect(created.organization).toEqual(organization);
      expect(created.name).toEqual(
        `${parent}/customModules/${created.moduleId}`,
      );
      expect(created.displayName).toEqual("AlchemyOrgAlwaysTrue");
      expect(created.customConfig?.description).toEqual("always true");

      const fetched =
        yield* scc.getOrganizationsSecurityHealthAnalyticsSettingsCustomModules(
          {
            name: created.name,
          },
        );
      expect(fetched.name).toEqual(created.name);
      expect(fetched.customConfig?.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SecurityCenter.OrganizationsSecurityHealthAnalyticsSettingsCustomModule(
            "AlwaysTrue",
            {
              organization,
              moduleId: created.moduleId,
              displayName: "AlchemyOrgAlwaysTrue",
              enablementState: "DISABLED",
              customConfig: {
                ...alwaysTrue,
                description: "always true disabled",
                severity: "MEDIUM",
              },
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.enablementState).toEqual("DISABLED");
      expect(updated.customConfig?.description).toEqual("always true disabled");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:securitycenter", "live"],
    timeout: 90_000,
  },
);
