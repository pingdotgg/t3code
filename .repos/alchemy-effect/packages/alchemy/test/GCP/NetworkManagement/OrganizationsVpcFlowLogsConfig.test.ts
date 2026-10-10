import { GcpEnvironment } from "@/GCP/Environment";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as networkmanagement from "@distilled.cloud/gcp/networkmanagement_v1";
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
// Organization flow-log configs need Network Management admin on the org; the
// testing credentials are rejected (probe). Set GOOGLE_ORGANIZATION_ID when the
// credentials administer the org.
const runOrgLifecycle = !!process.env.GOOGLE_ORGANIZATION_ID;

const waitUntilGone = (name: string) =>
  networkmanagement.getOrganizationsLocationsVpcFlowLogsConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const resolveOrganization = () =>
  Effect.gen(function* () {
    const { project } = yield* GcpEnvironment.current;

    const resource = yield* resourcemanager.getProjects({
      name: `projects/${project}`,
    });
    const parent = resource.parent ?? "organizations/0";
    if (parent.startsWith("organizations/")) {
      return parent.slice("organizations/".length);
    }
    return process.env.GOOGLE_ORGANIZATION_ID ?? "0";
  });

test.provider(
  "getOrganizationsLocationsVpcFlowLogsConfigs on a missing config fails with NotFound (Forbidden without org IAM)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = yield* resolveOrganization();
      const error = yield* Effect.flip(
        networkmanagement.getOrganizationsLocationsVpcFlowLogsConfigs({
          name: `organizations/${organization}/locations/global/vpcFlowLogsConfigs/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual(runOrgLifecycle ? "NotFound" : "Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkmanagement", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(runOrgLifecycle)(
  "createOrganizationsLocationsVpcFlowLogsConfigs without org IAM fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = yield* resolveOrganization();
      const error = yield* Effect.flip(
        networkmanagement.createOrganizationsLocationsVpcFlowLogsConfigs({
          parent: `organizations/${organization}/locations/global`,
          vpcFlowLogsConfigId: "alchemy-org-flow-logs-probe",
          body: {
            state: "ENABLED",
            aggregationInterval: "INTERVAL_5_SEC",
            flowSampling: 1,
          },
        }),
      );
      expect(error._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkmanagement", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runOrgLifecycle)(
  "create, update, and delete an organization vpc flow logs config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkManagement.OrganizationsVpcFlowLogsConfig(
            "OrgLogs",
            {
              description: "org flow logs a",
              labels: { env: "test" },
              aggregationInterval: "INTERVAL_5_SEC",
            },
          );
        }),
      );

      expect(created.name).toContain("/vpcFlowLogsConfigs/");
      expect(created.name).toContain("organizations/");
      expect(created.location).toEqual("global");
      expect(created.description).toEqual("org flow logs a");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* networkmanagement.getOrganizationsLocationsVpcFlowLogsConfigs({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.NetworkManagement.OrganizationsVpcFlowLogsConfig(
            "OrgLogs",
            {
              vpcFlowLogsConfigId: created.vpcFlowLogsConfigId,
              organization: created.organization,
              description: "org flow logs b",
              labels: { env: "prod", role: "logs" },
              aggregationInterval: "INTERVAL_1_MIN",
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("org flow logs b");
      expect(updated.labels).toMatchObject({ env: "prod", role: "logs" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkmanagement", "live"],
    timeout: 180_000,
  },
);
