import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
import { adopt } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const waitUntilGone = (project: string, zone: string, instance: string) =>
  compute.getInstances({ project, zone, instance }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const CLOUD_PLATFORM = "https://www.googleapis.com/auth/cloud-platform";

test.provider.skipIf(!!process.env.FAST)(
  "adopting a VM and declaring its observed identity does not replace it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { project } = yield* GcpEnvironment.current;
      const zone = "us-central1-a";
      const instanceName = `adopt-${stack.stage}`
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .slice(0, 60);

      // A VM created outside Alchemy, with the default service account and
      // a Shielded VM config Alchemy never declared.
      const existing = yield* compute
        .getInstances({ project, zone, instance: instanceName })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (existing === undefined) {
        yield* compute.insertInstances({
          project,
          zone,
          body: {
            name: instanceName,
            machineType: `zones/${zone}/machineTypes/e2-micro`,
            disks: [
              {
                boot: true,
                autoDelete: true,
                initializeParams: {
                  sourceImage: "projects/debian-cloud/global/images/family/debian-12",
                },
              },
            ],
            networkInterfaces: [{ network: "global/networks/default" }],
            serviceAccounts: [{ email: "default", scopes: [CLOUD_PLATFORM] }],
            shieldedInstanceConfig: {
              enableSecureBoot: false,
              enableVtpm: true,
              enableIntegrityMonitoring: true,
            },
          },
        });
      }
      const foreign = yield* compute.getInstances({ project, zone, instance: instanceName }).pipe(
        Effect.retry({
          while: (error) => error._tag === "NotFound",
          schedule: Schedule.spaced("3 seconds"),
          times: 20,
        }),
      );

      const program = (identity: Partial<GCP.Compute.InstanceProps>) =>
        GCP.Compute.Instance("Adopted", {
          instanceName,
          zone,
          machineType: "e2-micro",
          associatePublicIp: false,
          ...identity,
        }).pipe(adopt(true));

      // Spelling out what already runs: "default" resolves to the observed
      // account and a partial Shielded VM config matches the observed one.
      const declared = {
        serviceAccount: "default",
        oauthScopes: [CLOUD_PLATFORM],
        shieldedInstanceConfig: { enableVtpm: true },
      };
      expect((yield* stack.plan(program(declared))).resources.Adopted.action).not.toBe("replace");
      const adopted = yield* stack.deploy(program(declared));
      expect(adopted.instanceId).toEqual(foreign.id);

      // Identity settings can only change on a stopped VM, so they replace.
      expect(
        (yield* stack.plan(
          program({ ...declared, shieldedInstanceConfig: { enableSecureBoot: true } }),
        )).resources.Adopted,
      ).toMatchObject({ action: "replace", deleteFirst: true });
      const runner = `runner@${project}.iam.gserviceaccount.com`;
      expect(
        (yield* stack.plan(program({ ...declared, serviceAccount: runner }))).resources.Adopted,
      ).toMatchObject({ action: "replace", deleteFirst: true });

      yield* stack.destroy();
      expect(yield* waitUntilGone(project, zone, instanceName)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 300_000 },
);

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete an instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.Instance("Vm", {
            zone: "us-central1-a",
            machineType: "e2-micro",
            labels: { env: "test" },
            tags: ["alchemy-test"],
            metadata: { role: "test" },
            associatePublicIp: false,
            bootDiskType: "pd-balanced",
            provisioningModel: "STANDARD",
            onHostMaintenance: "MIGRATE",
            serviceAccount: "default",
            oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
            shieldedInstanceConfig: {
              enableIntegrityMonitoring: true,
              enableSecureBoot: true,
              enableVtpm: true,
            },
          });
        }),
      );

      expect(created.instanceName).toEqual(expect.any(String));
      expect(created.zone).toEqual("us-central1-a");
      expect(created.machineType).toEqual("e2-micro");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.tags).toEqual(["alchemy-test"]);
      expect(created.metadata).toMatchObject({ role: "test" });
      expect(created.scheduling?.provisioningModel).toEqual("STANDARD");
      expect(created.scheduling?.onHostMaintenance).toEqual("MIGRATE");
      expect(created.serviceAccount).toMatch(/-compute@developer\.gserviceaccount\.com$/);
      expect(created.oauthScopes).toContain("https://www.googleapis.com/auth/cloud-platform");
      expect(created.shieldedInstanceConfig).toMatchObject({
        enableIntegrityMonitoring: true,
        enableSecureBoot: true,
        enableVtpm: true,
      });

      const fetched = yield* compute.getInstances({
        project: created.project,
        zone: created.zone,
        instance: created.instanceName,
      });
      expect(fetched.name).toEqual(created.instanceName);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.tags?.items).toEqual(["alchemy-test"]);
      expect(fetched.scheduling?.provisioningModel).toEqual("STANDARD");
      expect(fetched.serviceAccounts?.[0]?.email).toEqual(created.serviceAccount);
      expect(fetched.shieldedInstanceConfig).toMatchObject({
        enableIntegrityMonitoring: true,
        enableSecureBoot: true,
        enableVtpm: true,
      });

      const bootDisk = yield* compute.getDisks({
        project: created.project,
        zone: created.zone,
        disk: fetched.disks?.[0]?.source?.split("/").pop() ?? "",
      });
      expect(bootDisk.type).toMatch(/\/diskTypes\/pd-balanced$/);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.Instance("Vm", {
            instanceName: created.instanceName,
            zone: "us-central1-a",
            machineType: "e2-micro",
            labels: { env: "prod", role: "web" },
            tags: ["alchemy-prod"],
            metadata: { role: "prod" },
            description: "alchemy instance update",
            associatePublicIp: false,
            bootDiskType: "pd-balanced",
            provisioningModel: "STANDARD",
            onHostMaintenance: "MIGRATE",
            automaticRestart: false,
            serviceAccount: "default",
            oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
            shieldedInstanceConfig: {
              enableIntegrityMonitoring: true,
              enableSecureBoot: true,
              enableVtpm: true,
            },
          });
        }),
      );

      expect(updated.instanceName).toEqual(created.instanceName);
      expect(updated.instanceId).toEqual(created.instanceId);
      expect(updated.labels).toMatchObject({ env: "prod", role: "web" });
      expect(updated.tags).toEqual(["alchemy-prod"]);
      expect(updated.metadata).toMatchObject({ role: "prod" });
      expect(updated.scheduling?.automaticRestart).toEqual(false);
      expect(updated.scheduling?.onHostMaintenance).toEqual("MIGRATE");

      const refetched = yield* compute.getInstances({
        project: created.project,
        zone: created.zone,
        instance: created.instanceName,
      });
      expect(refetched.id).toEqual(created.instanceId);
      expect(refetched.scheduling?.automaticRestart).toEqual(false);
      expect(refetched.description).toEqual("alchemy instance update");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.project, created.zone, created.instanceName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 240_000 },
);
