import * as GCP from "@/GCP";
import type { StackServices } from "@/Stack";
import * as Test from "@/Test/Alchemy";
import * as sqladmin from "@distilled.cloud/gcp/sqladmin_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({
  providers: GCP.providers() as Layer.Layer<
    GCP.ProviderRequirements,
    never,
    StackServices
  >,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Runs against an existing Cloud SQL instance (creating one takes well over
// 5 minutes); set GCP_SQL_INSTANCE to its name.
const sqlInstance =
  process.env.GCP_SQL_INSTANCE || process.env.GCP_TEST_SQL_INSTANCE;
const runLifecycle = !!sqlInstance && !process.env.FAST;

const waitUntilGone = (
  instance: string,
  userName: string,
  host: string | undefined,
) =>
  GcpEnvironment.current.pipe(
    Effect.flatMap(({ project }) =>
      sqladmin
        .getUsers({
          project,
          instance,
          name: userName,
          ...(host ? { host } : {}),
        })
        .pipe(
          Effect.as("found" as const),
          Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (status) => status === "gone",
            times: 10,
          }),
        ),
    ),
  );

test.provider(
  "getUsers on a missing instance fails with SqlInstanceNotAuthorized",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sqladmin.getUsers({
          project,
          instance: "alchemy-sql-instance-does-not-exist",
          name: "alchemy_user_does_not_exist",
        }),
      );
      // Cloud SQL hides unknown instances behind 403 rather than 404.
      expect(error._tag).toBe("SqlInstanceNotAuthorized");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:sql", "live"], timeout: 90_000 },
);

test.provider(
  "listUsers on a missing instance fails with SqlInstanceNotAuthorized",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        sqladmin.listUsers({
          project,
          instance: "alchemy-sql-instance-does-not-exist",
        }),
      );
      expect(error._tag).toBe("SqlInstanceNotAuthorized");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:sql", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a sql user",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const instance = sqlInstance!;
      const live = yield* sqladmin.getInstances({
        project,
        instance,
      });
      const isMysql = (live.databaseVersion ?? "")
        .toUpperCase()
        .startsWith("MYSQL");
      const host = isMysql ? "%" : undefined;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SQL.User("AppUser", {
            instance,
            host,
            password: "Alchemy-test-pass-1",
          });
        }),
      );

      expect(created.userName).toEqual(expect.any(String));
      expect(created.userName).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
      expect(created.instance).toEqual(instance);
      expect(created.project).toEqual(project);
      if (isMysql) {
        expect(created.host).toEqual("%");
      }

      const fetched = yield* sqladmin.getUsers({
        project: created.project,
        instance: created.instance,
        name: created.userName,
        ...(created.host ? { host: created.host } : {}),
      });
      expect(fetched.name).toEqual(created.userName);
      expect(fetched.instance).toEqual(created.instance);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SQL.User("AppUser", {
            instance,
            userName: created.userName,
            host: created.host,
            password: "Alchemy-test-pass-2",
          });
        }),
      );

      expect(updated.userName).toEqual(created.userName);
      expect(updated.instance).toEqual(created.instance);

      const refetched = yield* sqladmin.getUsers({
        project: updated.project,
        instance: updated.instance,
        name: updated.userName,
        ...(updated.host ? { host: updated.host } : {}),
      });
      expect(refetched.name).toEqual(updated.userName);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.instance,
        created.userName,
        created.host,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:sql", "live"], timeout: 120_000 },
);
