import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
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

const zone = "us-central1-a";
const vmName = "alchemy-mi-src";

const lastSegment = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const parts = value.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? "";
};

const waitZoneOp = (operation: compute.Operation) => {
  if (operation.status === "DONE") return Effect.succeed(operation);
  const name = lastSegment(operation.name);
  return GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute.getZoneOperations({ project, zone, operation: name }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (op) => op.status === "DONE",
          times: 20,
        }),
      ),
    ),
  );
};

const waitUntilGone = (machineImage: string) =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute.getMachineImages({ project, machineImage }).pipe(
        Effect.as("found" as const),
        Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (status) => status === "gone",
          times: 10,
        }),
      ),
    ),
  );

const waitVmGone = () =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute.getInstances({ project, zone, instance: vmName }).pipe(
        Effect.as("found" as const),
        Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (status) => status === "gone",
          times: 16,
        }),
      ),
    ),
  );

const getVm = () =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute
        .getInstances({ project, zone, instance: vmName })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined))),
    ),
  );

const waitVmRunning = () =>
  getVm().pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (instance) => instance?.status === "RUNNING",
      times: 10,
    }),
    Effect.flatMap((instance) =>
      instance?.status === "RUNNING"
        ? Effect.succeed(instance)
        : Effect.fail(
            new Error(
              `source vm ${vmName} is ${instance?.status ?? "MISSING"}`,
            ),
          ),
    ),
  );

const ensureVm = () =>
  Effect.gen(function* () {
    const { project } = yield* GcpEnvironment.current;
    const existing = yield* getVm();
    if (
      existing?.status === "STOPPING" ||
      existing?.status === "DELETING" ||
      existing?.status === "TERMINATED"
    ) {
      const operation = yield* compute
        .deleteInstances({ project, zone, instance: vmName })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitZoneOp(operation).pipe(Effect.ignore);
      }
      yield* waitVmGone();
    } else if (existing?.status === "RUNNING") {
      return existing;
    }
    if ((yield* getVm()) === undefined) {
      const operation = yield* compute
        .insertInstances({
          project,
          zone,
          body: {
            name: vmName,
            machineType: `zones/${zone}/machineTypes/e2-micro`,
            disks: [
              {
                boot: true,
                autoDelete: true,
                type: "PERSISTENT",
                initializeParams: {
                  sourceImage:
                    "projects/debian-cloud/global/images/family/debian-12",
                  diskSizeGb: "10",
                },
              },
            ],
            networkInterfaces: [{ network: "global/networks/default" }],
          },
        })
        .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitZoneOp(operation).pipe(Effect.ignore);
      }
    }
    return yield* waitVmRunning();
  });

const deleteVm = () =>
  Effect.gen(function* () {
    const { project } = yield* GcpEnvironment.current;
    const operation = yield* compute
      .deleteInstances({ project, zone, instance: vmName })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    if (operation !== undefined) {
      yield* waitZoneOp(operation).pipe(Effect.ignore);
    }
    yield* waitVmGone();
  });

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete a machine image",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const vm = yield* ensureVm();
      const sourceInstance =
        vm.selfLink ?? `projects/${project}/zones/${zone}/instances/${vmName}`;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.MachineImage("Backup", {
            sourceInstance,
            description: "alchemy test machine image",
            labels: { env: "test" },
            storageLocations: ["us-central1"],
          });
        }),
      );

      expect(created.machineImageName).toEqual(expect.any(String));
      expect(created.status).toEqual("READY");
      expect(created.description).toEqual("alchemy test machine image");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.project).toEqual(expect.any(String));
      expect(created.selfLink).toEqual(expect.any(String));
      expect(created.sourceInstance).toEqual(expect.any(String));

      const fetched = yield* compute.getMachineImages({
        project: created.project,
        machineImage: created.machineImageName,
      });
      expect(fetched.name).toEqual(created.machineImageName);
      expect(fetched.status).toEqual("READY");
      expect(fetched.description).toEqual("alchemy test machine image");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));
      expect(lastSegment(fetched.sourceInstance)).toEqual(vmName);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.MachineImage("Backup", {
            machineImageName: created.machineImageName,
            sourceInstance,
            description: "alchemy test machine image",
            labels: { env: "prod", role: "golden" },
            storageLocations: ["us-central1"],
          });
        }),
      );

      expect(updated.machineImageName).toEqual(created.machineImageName);
      expect(updated.machineImageId).toEqual(created.machineImageId);
      expect(updated.labels).toMatchObject({
        env: "prod",
        role: "golden",
      });

      const refetched = yield* compute.getMachineImages({
        project: updated.project,
        machineImage: updated.machineImageName,
      });
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("golden");
      expect(refetched.name).toEqual(created.machineImageName);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.machineImageName);
      expect(gone).toEqual("gone");

      yield* deleteVm();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 240_000 },
);
