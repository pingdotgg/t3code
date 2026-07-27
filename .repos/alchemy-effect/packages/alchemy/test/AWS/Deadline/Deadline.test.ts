import * as AWS from "@/AWS";
import { Budget, Farm, Fleet, Queue, StorageProfile } from "@/AWS/Deadline";
import { Role } from "@/AWS/IAM/Role.ts";
import * as Test from "@/Test/Alchemy";
import * as deadline from "@distilled.cloud/aws/deadline";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Ungated typed-error probes: prove the distilled error union carries the
// not-found tag every provider read/delete path in this service depends on.
test.provider(
  "getFarm on a nonexistent farm fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        deadline.getFarm({
          farmId: "farm-00000000000000000000000000000000",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "getMonitor on a nonexistent monitor fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        deadline.getMonitor({
          monitorId: "monitor-00000000000000000000000000000000",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

class FarmStillExists extends Data.TaggedError("FarmStillExists") {}

const assertFarmDeleted = Effect.fn(function* (farmId: string) {
  yield* deadline.getFarm({ farmId }).pipe(
    Effect.flatMap(() => Effect.fail(new FarmStillExists())),
    Effect.retry({
      while: (e) => e._tag === "FarmStillExists",
      schedule: Schedule.max([
        Schedule.spaced("6 seconds"),
        Schedule.recurs(9),
      ]),
    }),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
  );
});

// Farms, queues, storage profiles, and budgets are free configuration —
// exercised ungated.
test.provider(
  "create, update, delete farm + queue + storage profile + budget",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Deadline rejects budget windows over 120 days, and clamps a past
      // startTime to the creation instant. Compute one window per run and
      // reuse it across both deploy phases so the schedule never drifts.
      const schedule = yield* Effect.sync(() => {
        const now = Date.now();
        return {
          fixed: {
            startTime: new Date(now - 24 * 3600 * 1000).toISOString(),
            endTime: new Date(now + 90 * 24 * 3600 * 1000).toISOString(),
          },
        };
      });

      // Phase 1 — create.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const farm = yield* Farm("TestFarm", {
            description: "alchemy deadline test farm",
            tags: { fixture: "deadline" },
          });
          const profile = yield* StorageProfile("LinuxHosts", {
            farmId: farm.farmId,
            osFamily: "LINUX",
            fileSystemLocations: [
              { name: "Assets", path: "/mnt/assets", type: "SHARED" },
            ],
          });
          const queue = yield* Queue("RenderQueue", {
            farmId: farm.farmId,
            description: "alchemy deadline test queue",
            tags: { fixture: "deadline" },
          });
          const budget = yield* Budget("QueueBudget", {
            farmId: farm.farmId,
            queueId: queue.queueId,
            approximateDollarLimit: 1,
            actions: [
              {
                type: "STOP_SCHEDULING_AND_COMPLETE_TASKS",
                thresholdPercentage: 100,
              },
            ],
            schedule,
          });
          return { farm, profile, queue, budget };
        }),
      );

      expect(created.farm.farmId).toMatch(/^farm-/);
      expect(created.farm.farmArn).toContain(":farm/");
      expect(created.farm.costScaleFactor).toBe(1);
      expect(created.queue.queueId).toMatch(/^queue-/);
      expect(created.queue.farmId).toBe(created.farm.farmId);
      expect(created.profile.storageProfileId).toMatch(/^sp-/);
      expect(created.profile.osFamily).toBe("LINUX");
      expect(created.budget.budgetId).toMatch(/^budget-/);
      expect(created.budget.queueId).toBe(created.queue.queueId);
      expect(created.budget.approximateDollarLimit).toBe(1);

      // Verify out-of-band via distilled.
      const farm = yield* deadline.getFarm({ farmId: created.farm.farmId });
      expect(farm.displayName).toBe(created.farm.displayName);
      const queue = yield* deadline.getQueue({
        farmId: created.farm.farmId,
        queueId: created.queue.queueId,
      });
      expect(queue.displayName).toBe(created.queue.displayName);
      const tags = yield* deadline.listTagsForResource({
        resourceArn: created.farm.farmArn,
      });
      expect(tags.tags?.fixture).toBe("deadline");
      expect(tags.tags?.["alchemy::id"]).toBe("TestFarm");

      // Phase 2 — update mutable settings across all four resources.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const farm = yield* Farm("TestFarm", {
            description: "alchemy deadline test farm (updated)",
            costScaleFactor: 2,
            tags: { fixture: "deadline", phase: "two" },
          });
          const profile = yield* StorageProfile("LinuxHosts", {
            farmId: farm.farmId,
            osFamily: "LINUX",
            fileSystemLocations: [
              { name: "Assets", path: "/mnt/assets", type: "SHARED" },
              { name: "Cache", path: "/mnt/cache", type: "LOCAL" },
            ],
          });
          const queue = yield* Queue("RenderQueue", {
            farmId: farm.farmId,
            description: "alchemy deadline test queue",
            allowedStorageProfileIds: [profile.storageProfileId],
            tags: { fixture: "deadline" },
          });
          const budget = yield* Budget("QueueBudget", {
            farmId: farm.farmId,
            queueId: queue.queueId,
            approximateDollarLimit: 2,
            actions: [
              {
                type: "STOP_SCHEDULING_AND_CANCEL_TASKS",
                thresholdPercentage: 90,
              },
            ],
            schedule,
          });
          return { farm, profile, queue, budget };
        }),
      );

      // Stable identifiers survive the in-place update.
      expect(updated.farm.farmId).toBe(created.farm.farmId);
      expect(updated.queue.queueId).toBe(created.queue.queueId);
      expect(updated.profile.storageProfileId).toBe(
        created.profile.storageProfileId,
      );
      expect(updated.budget.budgetId).toBe(created.budget.budgetId);
      expect(updated.farm.costScaleFactor).toBe(2);
      expect(updated.budget.approximateDollarLimit).toBe(2);
      expect(updated.profile.fileSystemLocations).toHaveLength(2);

      // Verify the update landed out-of-band.
      const updatedQueue = yield* deadline.getQueue({
        farmId: created.farm.farmId,
        queueId: created.queue.queueId,
      });
      expect(updatedQueue.allowedStorageProfileIds).toEqual([
        created.profile.storageProfileId,
      ]);
      const updatedBudget = yield* deadline.getBudget({
        farmId: created.farm.farmId,
        budgetId: created.budget.budgetId,
      });
      expect(updatedBudget.approximateDollarLimit).toBe(2);
      expect(updatedBudget.actions).toHaveLength(1);
      expect(updatedBudget.actions[0]?.type).toBe(
        "STOP_SCHEDULING_AND_CANCEL_TASKS",
      );
      const updatedFarmTags = yield* deadline.listTagsForResource({
        resourceArn: created.farm.farmArn,
      });
      expect(updatedFarmTags.tags?.phase).toBe("two");

      yield* stack.destroy();
      yield* assertFarmDeleted(created.farm.farmId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

// A customer-managed fleet provisions no EC2 capacity, but fleet lifecycle
// is gated per the service plan (service-managed fleets can provision
// costly workers; entitlement/limits vary by account).
test.provider.skipIf(!process.env.AWS_TEST_DEADLINE)(
  "create and destroy a customer-managed fleet (AWS_TEST_DEADLINE=1)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { farm, fleet } = yield* stack.deploy(
        Effect.gen(function* () {
          const farm = yield* Farm("FleetFarm", {
            description: "alchemy deadline fleet test farm",
          });
          const role = yield* Role("FleetWorkerRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "credentials.deadline.amazonaws.com" },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
            managedPolicyArns: [
              "arn:aws:iam::aws:policy/AWSDeadlineCloud-FleetWorker",
            ],
          });
          const fleet = yield* Fleet("Workers", {
            farmId: farm.farmId,
            roleArn: role.roleArn,
            maxWorkerCount: 1,
            configuration: {
              customerManaged: {
                mode: "NO_SCALING",
                workerCapabilities: {
                  vCpuCount: { min: 1 },
                  memoryMiB: { min: 1024 },
                  osFamily: "LINUX",
                  cpuArchitectureType: "x86_64",
                },
              },
            },
            tags: { fixture: "deadline-fleet" },
          });
          return { farm, fleet };
        }),
      );

      expect(fleet.fleetId).toMatch(/^fleet-/);
      expect(fleet.status).toBe("ACTIVE");
      expect(fleet.workerCount).toBe(0);
      expect(fleet.maxWorkerCount).toBe(1);

      // Verify out-of-band via distilled.
      const described = yield* deadline.getFleet({
        farmId: fleet.farmId,
        fleetId: fleet.fleetId,
      });
      expect(described.status).toBe("ACTIVE");
      expect(described.configuration.customerManaged?.mode).toBe("NO_SCALING");

      yield* stack.destroy();
      yield* assertFarmDeleted(farm.farmId);
    }).pipe(logLevel),
  { timeout: 300_000 },
);
