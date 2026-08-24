import * as AWS from "@/AWS";
import { KxDatabase, KxEnvironment } from "@/AWS/FinSpace";
import { Key } from "@/AWS/KMS";
import * as Test from "@/Test/Alchemy";
import * as finspace from "@distilled.cloud/aws/finspace";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probes: prove the distilled error union carries the
// not-found tags the Kx providers' read/delete paths depend on.
test.provider(
  "getKxEnvironment on a nonexistent environment fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        finspace.getKxEnvironment({
          environmentId: "zzzzzzzzzzzzzzzzzzzzzzzzzz",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "getKxDatabase on a nonexistent environment fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        finspace.getKxDatabase({
          environmentId: "zzzzzzzzzzzzzzzzzzzzzzzzzz",
          databaseName: "nodb",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "getKxCluster on a nonexistent environment fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        finspace.getKxCluster({
          environmentId: "zzzzzzzzzzzzzzzzzzzzzzzzzz",
          clusterName: "nocluster",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

// Probes for the scaling-group / volume binding operations: prove the typed
// not-found tag so runtime consumers can catch it without casts.
test.provider(
  "getKxScalingGroup on a nonexistent environment fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        finspace.getKxScalingGroup({
          environmentId: "zzzzzzzzzzzzzzzzzzzzzzzzzz",
          scalingGroupName: "nogroup",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "getKxVolume on a nonexistent environment fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        finspace.getKxVolume({
          environmentId: "zzzzzzzzzzzzzzzzzzzzzzzzzz",
          volumeName: "novolume",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

// Deletion is verified as INITIATED (irreversible) or fully gone.
const assertKxEnvironmentDeleting = (environmentId: string) =>
  Effect.gen(function* () {
    const status = yield* finspace.getKxEnvironment({ environmentId }).pipe(
      Effect.map((r) => r.status ?? "gone"),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed("gone" as const),
      ),
    );
    if (
      status !== "gone" &&
      status !== "DELETED" &&
      status !== "DELETING" &&
      status !== "DELETE_REQUESTED"
    ) {
      return yield* Effect.fail(
        new Error(
          `kdb environment '${environmentId}' still exists (${status})`,
        ),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("10 seconds"),
        Schedule.recurs(18),
      ]),
    }),
  );

// A managed kdb environment takes tens of minutes to provision and FinSpace
// is closed to non-onboarded accounts (CreateKxEnvironment rejects). The
// full lifecycle is gated behind AWS_TEST_FINSPACE=1 and always destroys
// what it created. KxCluster additionally needs a VPC and dedicated
// capacity (~30+ min, billed per node-hour) — it is covered by the typed
// probe above and exercised only in onboarded accounts.
test.provider.skipIf(!process.env.AWS_TEST_FINSPACE)(
  "create kdb environment + database, verify, update, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { env, db } = yield* stack.deploy(
        Effect.gen(function* () {
          const key = yield* Key("KdbKey", {
            description: "alchemy finspace kdb test key",
          });
          const env = yield* KxEnvironment("Kdb", {
            kmsKeyId: key.keyArn,
            description: "alchemy kdb test environment",
            tags: { fixture: "finspace-kx" },
          });
          const db = yield* KxDatabase("Ticks", {
            environmentId: env.environmentId,
            description: "alchemy kdb test database",
            tags: { fixture: "finspace-kx" },
          });
          return { env, db };
        }),
      );

      expect(env.environmentId).toBeDefined();
      expect(env.status).toBe("CREATED");
      expect(db.databaseArn).toContain(":kxEnvironment/");

      // Out-of-band verification via distilled.
      const observedDb = yield* finspace.getKxDatabase({
        environmentId: env.environmentId,
        databaseName: db.databaseName,
      });
      expect(observedDb.databaseName).toBe(db.databaseName);

      // Update the database description in place (no replacement).
      const { db: updated } = yield* stack.deploy(
        Effect.gen(function* () {
          const key = yield* Key("KdbKey", {
            description: "alchemy finspace kdb test key",
          });
          const env = yield* KxEnvironment("Kdb", {
            kmsKeyId: key.keyArn,
            description: "alchemy kdb test environment",
            tags: { fixture: "finspace-kx" },
          });
          const db = yield* KxDatabase("Ticks", {
            environmentId: env.environmentId,
            description: "alchemy kdb test database (updated)",
            tags: { fixture: "finspace-kx" },
          });
          return { env, db };
        }),
      );
      expect(updated.databaseName).toBe(db.databaseName);
      expect(updated.description).toBe("alchemy kdb test database (updated)");

      // Destroy — environments bill while they exist — and verify deletion
      // was initiated out-of-band.
      const environmentId = env.environmentId;
      yield* stack.destroy();
      yield* assertKxEnvironmentDeleting(environmentId);
    }),
  // kdb environment create (tens of minutes) + database + delete, one test.
  { timeout: 3_000_000 },
);
