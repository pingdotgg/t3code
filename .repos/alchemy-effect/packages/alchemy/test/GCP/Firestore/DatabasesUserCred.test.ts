import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as firestore from "@distilled.cloud/gcp/firestore_v1";
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

const runLifecycle = !process.env.FAST;
const enterpriseDatabaseId = "alchfsucreds2";
const enterpriseDatabaseNameOf = (project: string) =>
  `projects/${project}/databases/${enterpriseDatabaseId}`;

const waitUntilGone = (name: string) =>
  firestore.getProjectsDatabasesUserCreds({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const waitUntilDatabase = (name: string, want: "ready" | "gone") =>
  firestore.getProjectsDatabases({ name }).pipe(
    Effect.map((database) =>
      database.deleteTime !== undefined
        ? ("gone" as const)
        : ("ready" as const),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === want,
      times: 10,
    }),
  );

const waitForDatabaseOperation = (
  operation: firestore.GoogleLongrunningOperation,
) =>
  Effect.gen(function* () {
    if (operation.done === true || operation.name === undefined) {
      return operation;
    }
    return yield* firestore
      .getProjectsDatabasesOperations({ name: operation.name })
      .pipe(
        Effect.repeat({
          schedule: Schedule.spaced("4 seconds"),
          until: (current) => current.done === true,
          times: 10,
        }),
      );
  });

const ensureEnterpriseDatabase = Effect.gen(function* () {
  const { project } = yield* GcpEnvironment.current;
  const existing = yield* firestore
    .getProjectsDatabases({
      name: enterpriseDatabaseNameOf(project),
    })
    .pipe(
      Effect.map((database) =>
        database.deleteTime !== undefined ? undefined : database,
      ),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );
  if (
    existing !== undefined &&
    (existing.databaseEdition ?? "").toUpperCase() === "ENTERPRISE"
  ) {
    return enterpriseDatabaseNameOf(project);
  }
  if (existing !== undefined) {
    yield* firestore
      .deleteProjectsDatabases({ name: enterpriseDatabaseNameOf(project) })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
    yield* waitUntilDatabase(enterpriseDatabaseNameOf(project), "gone");
  }

  const created = yield* firestore
    .createProjectsDatabases({
      parent: `projects/${project}`,
      databaseId: enterpriseDatabaseId,
      body: {
        locationId: "us-central1",
        type: "FIRESTORE_NATIVE",
        databaseEdition: "ENTERPRISE",
        mongodbCompatibleDataAccessMode: "DATA_ACCESS_MODE_ENABLED",
        deleteProtectionState: "DELETE_PROTECTION_DISABLED",
      },
    })
    .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
  if (created !== undefined) {
    yield* waitForDatabaseOperation(created);
  }
  yield* waitUntilDatabase(enterpriseDatabaseNameOf(project), "ready");
  return enterpriseDatabaseNameOf(project);
});

test.provider(
  "getProjectsDatabasesUserCreds on a missing user creds fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        firestore.getProjectsDatabasesUserCreds({
          name: `projects/${project}/databases/alchemy-missing-xxxx/userCreds/alchemy-missing`,
        }),
      );
      expect(error._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:firestore", "live"], timeout: 90_000 },
);

test.provider.skipIf(!!process.env.FAST)(
  "createProjectsDatabasesUserCreds on Standard edition fails with EnterpriseDatabaseRequired",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Firestore.Database("App", {
            location: "us-central1",
            type: "FIRESTORE_NATIVE",
          });
        }),
      );

      const error = yield* Effect.flip(
        firestore.createProjectsDatabasesUserCreds({
          parent: created.name,
          userCredsId: "alchemyusercreds",
          body: {},
        }),
      );
      expect(error._tag).toEqual("EnterpriseDatabaseRequired");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:firestore", "live"],
    timeout: 180_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete firestore user creds on Enterprise",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const parent = yield* ensureEnterpriseDatabase;
      yield* firestore
        .deleteProjectsDatabasesUserCreds({
          name: `${parent}/userCreds/appuser`,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Firestore.DatabasesUserCred("AppUser", {
            database: parent,
            userCredsId: "appuser",
          });
        }),
      );

      expect(created.name).toContain("/userCreds/");
      expect(created.databaseId).toEqual(enterpriseDatabaseId);
      expect(created.disabled).toEqual(false);
      expect(created.securePassword).toEqual(expect.any(String));

      const fetched = yield* firestore.getProjectsDatabasesUserCreds({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.state).toEqual("ENABLED");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Firestore.DatabasesUserCred("AppUser", {
            database: parent,
            userCredsId: created.userCredsId,
            disabled: true,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.disabled).toEqual(true);

      const refetched = yield* firestore.getProjectsDatabasesUserCreds({
        name: created.name,
      });
      expect(refetched.state).toEqual("DISABLED");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:firestore", "live"],
    timeout: 180_000,
  },
);
