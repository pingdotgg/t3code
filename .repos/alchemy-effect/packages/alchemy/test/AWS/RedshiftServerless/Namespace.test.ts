import * as AWS from "@/AWS";
import { Namespace, Workgroup } from "@/AWS/RedshiftServerless";
import * as Test from "@/Test/Alchemy";
import * as redshiftserverless from "@distilled.cloud/aws/redshift-serverless";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probes: prove the distilled error union carries the
// not-found tag the providers' observe/read/delete paths depend on.
test.provider(
  "getWorkgroup on a nonexistent workgroup fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        redshiftserverless.getWorkgroup({
          workgroupName: "alchemy-nonexistent-probe-wg",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "getNamespace on a nonexistent namespace fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        redshiftserverless.getNamespace({
          namespaceName: "alchemy-nonexistent-probe-ns",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

const assertNamespaceGone = (name: string) =>
  Effect.gen(function* () {
    const status = yield* redshiftserverless
      .getNamespace({ namespaceName: name })
      .pipe(
        Effect.map((r) => (r.namespace?.status ?? "UNKNOWN").toUpperCase()),
        Effect.catchTag("ResourceNotFoundException", () =>
          Effect.succeed("GONE" as const),
        ),
      );
    if (status !== "GONE") {
      return yield* Effect.fail(
        new Error(`Redshift namespace still exists (status: ${status})`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(24),
      ]),
    }),
  );

const assertWorkgroupGone = (name: string) =>
  Effect.gen(function* () {
    const status = yield* redshiftserverless
      .getWorkgroup({ workgroupName: name })
      .pipe(
        Effect.map((r) => (r.workgroup?.status ?? "UNKNOWN").toUpperCase()),
        Effect.catchTag("ResourceNotFoundException", () =>
          Effect.succeed("GONE" as const),
        ),
      );
    if (status !== "GONE") {
      return yield* Effect.fail(
        new Error(`Redshift workgroup still exists (status: ${status})`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(24),
      ]),
    }),
  );

// A namespace is cheap but a workgroup bills against its RPU floor while it
// exists, so the full lifecycle is gated behind AWS_TEST_SLOW=1 and always
// destroys immediately (workgroup, then namespace).
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "create a namespace + minimal workgroup, verify AVAILABLE, destroy, verify gone",
  (stack) =>
    Effect.gen(function* () {
      // Clean slate in case a previous run died mid-flight.
      yield* stack.destroy();

      const { namespace, workgroup } = yield* stack.deploy(
        Effect.gen(function* () {
          const namespace = yield* Namespace("AnalyticsNamespace", {
            namespaceName: "alchemy-test-rs-lifecycle-ns",
            dbName: "dev",
            adminUsername: "alchemyadmin",
            manageAdminPassword: true,
          });
          const workgroup = yield* Workgroup("AnalyticsWorkgroup", {
            workgroupName: "alchemy-test-rs-lifecycle-wg",
            namespaceName: namespace.namespaceName,
            baseCapacity: 8,
            publiclyAccessible: false,
          });
          return { namespace, workgroup };
        }),
      );

      expect(namespace.namespaceName).toBe("alchemy-test-rs-lifecycle-ns");
      expect(namespace.namespaceArn).toContain(":namespace/");
      expect(namespace.status.toUpperCase()).toBe("AVAILABLE");
      // manageAdminPassword => a Secrets Manager secret is provisioned.
      expect(namespace.adminPasswordSecretArn).toBeDefined();

      expect(workgroup.workgroupName).toBe("alchemy-test-rs-lifecycle-wg");
      expect(workgroup.workgroupArn).toContain(":workgroup/");
      expect(workgroup.status.toUpperCase()).toBe("AVAILABLE");
      expect(workgroup.endpointAddress).toBeDefined();
      expect(workgroup.endpointPort).toBe(5439);
      expect(workgroup.publiclyAccessible).toBe(false);

      // Out-of-band verification via distilled.
      const observedWg = yield* redshiftserverless.getWorkgroup({
        workgroupName: workgroup.workgroupName,
      });
      expect(observedWg.workgroup?.status?.toUpperCase()).toBe("AVAILABLE");
      expect(observedWg.workgroup?.baseCapacity).toBe(8);
      expect(observedWg.workgroup?.namespaceName).toBe(namespace.namespaceName);

      const observedNs = yield* redshiftserverless.getNamespace({
        namespaceName: namespace.namespaceName,
      });
      expect(observedNs.namespace?.status?.toUpperCase()).toBe("AVAILABLE");

      // Destroy immediately — a running workgroup bills its RPU floor.
      yield* stack.destroy();
      yield* assertWorkgroupGone(workgroup.workgroupName);
      yield* assertNamespaceGone(namespace.namespaceName);
    }),
  // namespace (~1 min) + workgroup create (~2-5 min) + delete (~3-5 min).
  { timeout: 1_200_000 },
);
