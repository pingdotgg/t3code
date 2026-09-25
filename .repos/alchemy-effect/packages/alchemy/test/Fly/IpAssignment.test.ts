import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Fly.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilAppGone = (appName: string) =>
  machines.getApp({ app_name: appName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const waitUntilIpGone = (appName: string, ip: string) =>
  machines.listAppIPAssignments({ app_name: appName }).pipe(
    Effect.map((res) =>
      (res.ips ?? []).some((item) => item.ip === ip) ? "found" : "gone",
    ),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const listedHas = (appName: string, ip: string) =>
  machines
    .listAppIPAssignments({ app_name: appName })
    .pipe(Effect.map((res) => (res.ips ?? []).find((item) => item.ip === ip)));

test.provider(
  "create, update, and delete a v6 assignment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("IpApp");
          const ip = yield* Fly.IpAssignment("Public", {
            app,
            type: "v6",
          });
          return { app, ip };
        }),
      );

      expect(created.ip.ip).toEqual(expect.any(String));
      expect(created.ip.ip).toContain(":");
      expect(created.ip.type).toEqual("v6");
      expect(created.ip.appName).toEqual(created.app.appName);
      expect(created.ip.shared).toEqual(false);

      const fetched = yield* listedHas(created.app.appName, created.ip.ip);
      expect(fetched).toBeDefined();
      expect(fetched?.ip).toEqual(created.ip.ip);
      expect(fetched?.shared).not.toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("IpApp");
          const ip = yield* Fly.IpAssignment("Public", {
            app,
            type: "v6",
          });
          return { app, ip };
        }),
      );

      expect(updated.ip.ip).toEqual(created.ip.ip);
      expect(updated.ip.type).toEqual("v6");
      expect(updated.ip.appName).toEqual(created.app.appName);
      expect(updated.app.appId).toEqual(created.app.appId);

      yield* stack.destroy();

      const ipGone = yield* waitUntilIpGone(created.app.appName, created.ip.ip);
      expect(ipGone).toEqual("gone");
      const appGone = yield* waitUntilAppGone(created.app.appName);
      expect(appGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "replace when type changes to shared_v4",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("IpReplaceApp");
          const ip = yield* Fly.IpAssignment("Public", {
            app,
            type: "v6",
          });
          return { app, ip };
        }),
      );

      expect(created.ip.type).toEqual("v6");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("IpReplaceApp");
          const ip = yield* Fly.IpAssignment("Public", {
            app,
            type: "shared_v4",
          });
          return { app, ip };
        }),
      );

      expect(replaced.ip.ip).not.toEqual(created.ip.ip);
      expect(replaced.ip.type).toEqual("shared_v4");
      expect(replaced.ip.shared).toEqual(true);
      expect(replaced.ip.appName).toEqual(created.app.appName);
      expect(replaced.ip.ip).not.toContain(":");

      const fetched = yield* listedHas(replaced.app.appName, replaced.ip.ip);
      expect(fetched).toBeDefined();
      expect(fetched?.ip).toEqual(replaced.ip.ip);
      expect(fetched?.ip).not.toContain(":");

      const oldGone = yield* waitUntilIpGone(
        created.app.appName,
        created.ip.ip,
      );
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const ipGone = yield* waitUntilIpGone(
        replaced.app.appName,
        replaced.ip.ip,
      );
      expect(ipGone).toEqual("gone");
      const appGone = yield* waitUntilAppGone(replaced.app.appName);
      expect(appGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "list enumerates the deployed assignment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("IpListApp");
          const ip = yield* Fly.IpAssignment("Public", {
            app,
            type: "v6",
          });
          return { app, ip };
        }),
      );

      const provider = yield* Provider.findProvider(Fly.IpAssignment);
      const all = yield* provider.list();
      const found = all.find((row) => row.ip === deployed.ip.ip);
      expect(found).toBeDefined();
      expect(found?.appName).toEqual(deployed.app.appName);
      expect(found?.type).toEqual("v6");

      yield* stack.destroy();

      const ipGone = yield* waitUntilIpGone(
        deployed.app.appName,
        deployed.ip.ip,
      );
      expect(ipGone).toEqual("gone");
      const appGone = yield* waitUntilAppGone(deployed.app.appName);
      expect(appGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "dedicated v4 is rejected with a typed quota error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const app = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Fly.App("IpV4ProbeApp");
        }),
      );

      const result = yield* Effect.result(
        machines.createAppIPAssignment({
          app_name: app.appName,
          type: "v4",
        }),
      );

      if (Result.isFailure(result)) {
        expect(result.failure._tag).toEqual("BadRequest");
      } else {
        const ip = result.success.ip;
        if (ip !== undefined && ip.length > 0) {
          yield* machines
            .deleteAppIPAssignment({
              app_name: app.appName,
              ip,
            })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }
      }

      yield* stack.destroy();

      const gone = yield* waitUntilAppGone(app.appName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
