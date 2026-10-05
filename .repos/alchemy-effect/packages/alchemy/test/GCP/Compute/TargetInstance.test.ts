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
const vmName = "alchemy-ti-backend";

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

const waitUntilGone = (targetInstance: string) =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      compute.getTargetInstances({ project, zone, targetInstance }).pipe(
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

const ensureVm = () =>
  Effect.gen(function* () {
    const { project } = yield* GcpEnvironment.current;
    const existing = yield* getVm();
    if (existing !== undefined) return existing;
    const operation = yield* compute
      .insertInstances({
        project,
        zone,
        body: {
          name: vmName,
          machineType: `zones/${zone}/machineTypes/e2-micro`,
          canIpForward: true,
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
      yield* waitZoneOp(operation);
    }
    return yield* compute
      .getInstances({ project, zone, instance: vmName })
      .pipe(
        Effect.retry({
          while: (error) => error._tag === "NotFound",
          schedule: Schedule.spaced("2 seconds"),
          times: 10,
        }),
      );
  });

const deleteVm = () =>
  Effect.gen(function* () {
    const { project } = yield* GcpEnvironment.current;
    const operation = yield* compute
      .deleteInstances({ project, zone, instance: vmName })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    if (operation !== undefined) {
      yield* waitZoneOp(operation).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
      );
    }
    yield* waitVmGone();
  });

test.provider.skipIf(!!process.env.FAST)(
  "create, update, and delete a target instance",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();
      yield* deleteVm().pipe(Effect.ignore);

      const vm = yield* ensureVm();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.TargetInstance("Target", {
            description: "protocol frontend",
            instance: vmName,
            zone,
          });
        }),
      );

      expect(created.targetInstanceName).toEqual(expect.any(String));
      expect(created.zone).toEqual(zone);
      expect(created.description).toEqual("protocol frontend");
      expect(lastSegment(created.instance)).toEqual(vmName);
      expect(created.natPolicy).toEqual("NO_NAT");

      const fetched = yield* compute.getTargetInstances({
        project,
        zone,
        targetInstance: created.targetInstanceName,
      });
      expect(fetched.name).toEqual(created.targetInstanceName);
      expect(lastSegment(fetched.instance)).toEqual(vmName);
      expect(fetched.description).toContain("[alchemy ");
      expect(fetched.description).toContain("protocol frontend");
      expect(fetched.natPolicy).toEqual("NO_NAT");
      expect(lastSegment(vm.name)).toEqual(vmName);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.TargetInstance("Target", {
            targetInstanceName: created.targetInstanceName,
            description: "updated protocol frontend",
            instance: vmName,
            zone,
          });
        }),
      );

      expect(updated.targetInstanceName).toEqual(created.targetInstanceName);
      expect(updated.description).toEqual("updated protocol frontend");
      expect(lastSegment(updated.instance)).toEqual(vmName);

      const refetched = yield* compute.getTargetInstances({
        project,
        zone,
        targetInstance: updated.targetInstanceName,
      });
      expect(refetched.description).toContain("updated protocol frontend");
      expect(lastSegment(refetched.instance)).toEqual(vmName);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.targetInstanceName);
      expect(gone).toEqual("gone");

      yield* deleteVm();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:compute", "live"], timeout: 180_000 },
);
