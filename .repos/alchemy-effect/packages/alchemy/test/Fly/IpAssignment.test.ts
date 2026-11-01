import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import { fetchFrom, httpService, nginx } from "./fixtures/flycast.ts";

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
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:ipassignment",
      "provider:fly:machine",
      "live",
    ],
    timeout: 120_000,
  },
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
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:ipassignment",
      "provider:fly:machine",
      "live",
    ],
    timeout: 120_000,
  },
);

/** Fly marks Flycast addresses with a `network`; public addresses have none. */
const observedNetwork = (appName: string, ip: string) =>
  listedHas(appName, ip).pipe(Effect.map((found) => found?.network));

const tags = [
  "provider:fly",
  "provider:fly:app",
  "provider:fly:ipassignment",
  "provider:fly:machine",
  "live",
];

test.provider(
  "private_v6, v6, and shared_v4 on one App keep distinct addresses",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = Effect.gen(function* () {
        const app = yield* Fly.App("IpFlycastApp");
        const flycast = yield* Fly.IpAssignment("Flycast", {
          app,
          type: "private_v6",
        });
        const publicV6 = yield* Fly.IpAssignment("PublicV6", {
          app,
          type: "v6",
        });
        const sharedV4 = yield* Fly.IpAssignment("SharedV4", {
          app,
          type: "shared_v4",
        });
        return { app, flycast, publicV6, sharedV4 };
      });

      const created = yield* stack.deploy(program);
      expect(created.flycast.type).toEqual("private_v6");
      expect(created.flycast.shared).toBe(false);
      expect(created.flycast.network).toBeUndefined();
      expect(
        yield* observedNetwork(created.app.appName, created.flycast.ip),
      ).toMatchObject({ name: "" });
      expect(
        yield* observedNetwork(created.app.appName, created.publicV6.ip),
      ).toBeNull();
      expect(created.publicV6.type).toEqual("v6");
      expect(created.publicV6.ip).toContain(":");
      expect(created.sharedV4.type).toEqual("shared_v4");
      expect(created.sharedV4.shared).toBe(true);

      const listed = yield* machines.listAppIPAssignments({
        app_name: created.app.appName,
      });
      expect((listed.ips ?? []).map(({ ip }) => ip).sort()).toEqual(
        [created.flycast.ip, created.publicV6.ip, created.sharedV4.ip].sort(),
      );

      const updated = yield* stack.deploy(program);
      expect(updated.flycast).toEqual(created.flycast);
      expect(updated.publicV6).toEqual(created.publicV6);
      expect(updated.sharedV4).toEqual(created.sharedV4);

      const provider = yield* Provider.findProvider(Fly.IpAssignment);
      const all = yield* provider.list();
      const typeOf = (ip: string) => all.find((row) => row.ip === ip)?.type;
      expect(typeOf(created.flycast.ip)).toEqual("private_v6");
      expect(typeOf(created.publicV6.ip)).toEqual("v6");
      expect(typeOf(created.sharedV4.ip)).toEqual("shared_v4");

      yield* stack.destroy();
      for (const ip of [created.flycast.ip, created.publicV6.ip])
        expect(yield* waitUntilIpGone(created.app.appName, ip)).toEqual("gone");
      expect(yield* waitUntilAppGone(created.app.appName)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 120_000 },
);

test.provider(
  "an existing Flycast address is adopted and a public v6 is still allocated",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const app = yield* stack.deploy(Fly.App("IpFlycastAdoptApp"));
      // Allocate the Flycast address directly through the Fly API.
      const existing = yield* machines.createAppIPAssignment({
        app_name: app.appName,
        type: "private_v6",
      });
      expect(existing.network).toMatchObject({ name: "" });

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Fly.App("IpFlycastAdoptApp");
          const flycast = yield* Fly.IpAssignment("Flycast", {
            app,
            type: "private_v6",
          });
          const publicV6 = yield* Fly.IpAssignment("PublicV6", {
            app,
            type: "v6",
          });
          return { flycast, publicV6 };
        }),
      );
      expect(deployed.flycast.ip).toEqual(existing.ip);
      expect(deployed.flycast.type).toEqual("private_v6");
      expect(deployed.publicV6.type).toEqual("v6");
      expect(deployed.publicV6.ip).not.toEqual(existing.ip);
      expect(
        yield* observedNetwork(app.appName, deployed.publicV6.ip),
      ).toBeNull();
      const listed = yield* machines.listAppIPAssignments({
        app_name: app.appName,
      });
      expect(listed.ips ?? []).toHaveLength(2);

      yield* stack.destroy();
      expect(yield* waitUntilAppGone(app.appName)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 120_000 },
);

test.provider(
  "changing type between private_v6 and v6 replaces the address",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (type: "private_v6" | "v6") =>
        stack.deploy(
          Effect.gen(function* () {
            const app = yield* Fly.App("IpFlycastReplaceApp");
            const ip = yield* Fly.IpAssignment("Ip", { app, type });
            return { app, ip };
          }),
        );
      const flycast = yield* deploy("private_v6");
      expect(flycast.ip.type).toEqual("private_v6");
      expect(
        yield* observedNetwork(flycast.app.appName, flycast.ip.ip),
      ).toBeDefined();
      const publicV6 = yield* deploy("v6");
      expect(publicV6.ip.type).toEqual("v6");
      expect(publicV6.ip.ip).not.toEqual(flycast.ip.ip);
      expect(
        yield* observedNetwork(publicV6.app.appName, publicV6.ip.ip),
      ).toBeNull();
      expect(
        yield* waitUntilIpGone(flycast.app.appName, flycast.ip.ip),
      ).toEqual("gone");
      const back = yield* deploy("private_v6");
      expect(back.ip.type).toEqual("private_v6");
      expect(back.ip.ip).not.toEqual(publicV6.ip.ip);
      expect(
        yield* waitUntilIpGone(publicV6.app.appName, publicV6.ip.ip),
      ).toEqual("gone");
      yield* stack.destroy();
      expect(yield* waitUntilAppGone(flycast.app.appName)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 120_000 },
);

test.provider(
  "Flycast serves another App through the proxy and not the internet",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const backend = yield* Fly.App("FlycastBackend");
          const flycast = yield* Fly.IpAssignment("BackendFlycast", {
            app: backend,
            type: "private_v6",
          });
          const web = yield* Fly.Machine("BackendWeb", {
            app: backend,
            ...nginx,
            services: [httpService],
          });
          const client = yield* Fly.App("FlycastClient");
          const caller = yield* Fly.Machine("Caller", {
            app: client,
            ...nginx,
          });
          return { backend, flycast, web, caller };
        }),
      );
      expect(deployed.flycast.type).toEqual("private_v6");
      const flycastUrl = `http://${deployed.backend.appName}.flycast/`;
      expect(yield* fetchFrom(deployed.caller, flycastUrl)).toContain(
        "Welcome to nginx",
      );

      // No public address: the fly.dev hostname does not serve the backend.
      const publicResult = yield* HttpClient.get(
        `http://${deployed.backend.appName}.fly.dev/`,
      ).pipe(
        Effect.flatMap((response) => response.text),
        Effect.timeout("10 seconds"),
        Effect.result,
      );
      if (Result.isSuccess(publicResult))
        expect(publicResult.success).not.toContain("Welcome to nginx");

      // Requests still pass through Fly's proxy, so a stopped Machine autostarts.
      const target = {
        app_name: deployed.web.appName,
        machine_id: deployed.web.machineId,
      };
      yield* machines.stopMachine(target);
      yield* machines.waitMachine({ ...target, state: "stopped", timeout: 30 });
      expect(yield* fetchFrom(deployed.caller, flycastUrl)).toContain(
        "Welcome to nginx",
      );
      expect((yield* machines.getMachine(target)).state).toEqual("started");

      yield* stack.destroy();
      expect(yield* waitUntilAppGone(deployed.backend.appName)).toEqual("gone");
      expect(yield* waitUntilAppGone(deployed.caller.appName)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 180_000 },
);

test.provider(
  "network places Flycast on a named network and changing it replaces",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const networks = {
        a: "alchemy-flycast-tenant-a",
        b: "alchemy-flycast-tenant-b",
      };
      const deploy = (network: string | undefined) =>
        stack.deploy(
          Effect.gen(function* () {
            const backend = yield* Fly.App("NetworkBackend");
            yield* Fly.Machine("BackendWeb", {
              app: backend,
              ...nginx,
              services: [httpService],
            });
            const tenantA = yield* Fly.App("TenantA", { network: networks.a });
            const tenantB = yield* Fly.App("TenantB", { network: networks.b });
            const callerA = yield* Fly.Machine("CallerA", {
              app: tenantA,
              ...nginx,
            });
            const flycast = yield* Fly.IpAssignment("BackendFlycast", {
              app: backend,
              type: "private_v6",
              network,
            });
            return { backend, tenantA, tenantB, callerA, flycast };
          }),
        );

      const onA = yield* deploy(networks.a);
      expect(onA.tenantA.network).toEqual(networks.a);
      expect(onA.flycast.network).toEqual(networks.a);
      expect(
        yield* observedNetwork(onA.backend.appName, onA.flycast.ip),
      ).toMatchObject({ name: networks.a });
      expect(
        yield* fetchFrom(onA.callerA, `http://${onA.backend.appName}.flycast/`),
      ).toContain("Welcome to nginx");

      const onB = yield* deploy(networks.b);
      expect(onB.flycast.ip).not.toEqual(onA.flycast.ip);
      expect(onB.flycast.network).toEqual(networks.b);
      expect(
        yield* waitUntilIpGone(onA.backend.appName, onA.flycast.ip),
      ).toEqual("gone");

      const onDefault = yield* deploy(undefined);
      expect(onDefault.flycast.ip).not.toEqual(onB.flycast.ip);
      expect(onDefault.flycast.network).toBeUndefined();
      expect(
        yield* waitUntilIpGone(onB.backend.appName, onB.flycast.ip),
      ).toEqual("gone");

      yield* stack.destroy();
      for (const app of [onA.backend, onA.tenantA, onA.tenantB])
        expect(yield* waitUntilAppGone(app.appName)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);

test.provider(
  "an unknown network is rejected without allocating an address",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const app = yield* stack.deploy(Fly.App("IpUnknownNetworkApp"));
      const failed = yield* stack
        .deploy(
          Effect.gen(function* () {
            const app = yield* Fly.App("IpUnknownNetworkApp");
            return yield* Fly.IpAssignment("Flycast", {
              app,
              type: "private_v6",
              network: "alchemy-flycast-missing-network",
            });
          }),
        )
        .pipe(Effect.flip);
      expect(failed).toMatchObject({ _tag: "NetworkNotFound" });
      const listed = yield* machines.listAppIPAssignments({
        app_name: app.appName,
      });
      expect(listed.ips ?? []).toEqual([]);
      yield* stack.destroy();
      expect(yield* waitUntilAppGone(app.appName)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 120_000 },
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
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:ipassignment",
      "provider:fly:machine",
      "live",
    ],
    timeout: 120_000,
  },
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
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:ipassignment",
      "provider:fly:machine",
      "live",
    ],
    timeout: 120_000,
  },
);
