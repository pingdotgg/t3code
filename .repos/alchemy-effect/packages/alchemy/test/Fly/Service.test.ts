import * as machines from "@distilled.cloud/fly-io/machines";
import * as Fly from "@/Fly";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Result from "effect/Result";
import * as HttpClient from "effect/http/HttpClient";
import Api from "./fixtures/api.ts";
import ChecksApi, { ChecksSite } from "./fixtures/checks-api.ts";
import UnhealthyApi, { UnhealthySite } from "./fixtures/unhealthy-api.ts";
import { API_PORT, MARKER, Site, VOLUME_PATH } from "./fixtures/shared.ts";
import { ECHO_BODY, Echo } from "./fixtures/echo.ts";
import { fetchFrom, fetchOnce, nginx } from "./fixtures/flycast.ts";
import { Ping, Pong } from "./fixtures/rpc-cycle.ts";
import PingLive from "./fixtures/rpc-ping.ts";
import PongLive from "./fixtures/rpc-pong.ts";
import RegionalApi from "./fixtures/regional-api.ts";
import RpcGateway from "./fixtures/rpc-gateway.ts";
import RpcOrders, { ORDERS } from "./fixtures/rpc-orders.ts";
import RpcStranger from "./fixtures/rpc-stranger.ts";
import RpcUsers, { USERS } from "./fixtures/rpc-users.ts";
import SecureGateway from "./fixtures/secure-gateway.ts";
import SecureUsers, { SECURE_USERS_BODY } from "./fixtures/secure-users.ts";

const { test } = Test.make({ providers: Fly.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const waitUntilGone = (appName: string, machineId: string) =>
  machines
    .getMachine({
      app_name: appName,
      machine_id: machineId,
    })
    .pipe(
      Effect.map((machine) =>
        machine.state === "destroyed" ? ("gone" as const) : ("found" as const),
      ),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider(
  "deploy token probe is typed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const app = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Fly.App("TokenSite");
        }),
      );

      const minted = yield* machines.createAppDeployToken({
        app_name: app.appName,
      });
      expect(minted.token).toEqual(expect.any(String));
      expect(minted.token!.length).toBeGreaterThan(0);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
    timeout: 90_000,
  },
);

test.provider(
  "create, serve, mount, and delete a service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Site;
          const ip = yield* Fly.IpAssignment("Shared", {
            app,
            type: "shared_v4",
          });
          const api = yield* Api;
          return { app, ip, api };
        }),
      );

      expect(deployed.api.machineId).toEqual(expect.any(String));
      expect(deployed.api.machineId.length).toBeGreaterThan(0);
      expect(deployed.api.machineIds).toEqual([deployed.api.machineId]);
      expect(deployed.api.count).toEqual(1);
      expect(deployed.api.appName).toEqual(deployed.app.appName);
      expect(deployed.api.name).toEqual(expect.any(String));
      expect(deployed.api.region).toEqual("iad");
      expect(deployed.api.state).toEqual("started");
      expect(deployed.api.url).toEqual(
        `https://${deployed.app.appName}.fly.dev`,
      );
      expect(deployed.api.code.hash).toEqual(expect.any(String));
      expect(deployed.api.code.hash.length).toBeGreaterThan(0);
      expect(deployed.api.mounts[0]?.path).toEqual(VOLUME_PATH);
      expect(deployed.api.mounts[0]?.volumeId).toEqual(expect.any(String));

      const fetched = yield* machines.getMachine({
        app_name: deployed.api.appName,
        machine_id: deployed.api.machineId,
      });
      expect(fetched.id).toEqual(deployed.api.machineId);
      expect(fetched.name).toEqual(deployed.api.name);
      expect(fetched.region).toEqual("iad");
      expect(fetched.state).toEqual("started");
      expect(fetched.config?.metadata?.["alchemy.type"]).toEqual("Fly.Service");
      expect(fetched.config?.metadata?.["alchemy.stack"]).toEqual(
        expect.any(String),
      );
      expect(fetched.config?.image).toEqual(
        expect.stringContaining("registry.fly.io/"),
      );
      expect(fetched.config?.image).toEqual(
        expect.stringContaining(deployed.api.code.hash),
      );
      expect(fetched.config?.mounts?.[0]?.path).toEqual(VOLUME_PATH);
      expect(fetched.config?.mounts?.[0]?.volume).toEqual(
        deployed.api.mounts[0]?.volumeId,
      );
      expect(fetched.config?.metadata?.["alchemy.replica"]).toEqual("0");
      expect(fetched.config?.guest?.cpus).toEqual(1);
      expect(fetched.config?.guest?.memory_mb).toEqual(256);
      const defaultCheck = fetched.config?.services?.[0]?.checks?.[0];
      expect(defaultCheck?.type).toEqual("tcp");
      expect(defaultCheck?.port).toEqual(API_PORT);
      expect(defaultCheck?.interval).toEqual("10s");
      expect(defaultCheck?.timeout).toEqual("2s");
      expect(defaultCheck?.grace_period).toEqual("30s");

      const liveVolume = yield* machines.getVolumeById({
        app_name: deployed.api.appName,
        volume_id: deployed.api.mounts[0]!.volumeId,
      });
      expect(liveVolume.attached_machine_id).toEqual(deployed.api.machineId);

      const provider = yield* Provider.findProvider(Fly.Service);
      const all = yield* provider.list();
      const found = all.find(
        (service) => service.machineId === deployed.api.machineId,
      );
      expect(found).toBeDefined();
      expect(found?.appName).toEqual(deployed.api.appName);
      expect(found?.name).toEqual(deployed.api.name);
      expect(found?.region).toEqual("iad");

      const body = yield* HttpClient.get(deployed.api.url!).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? res.json
            : Effect.fail(new Error(`api returned ${res.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.spaced("4 seconds"),
          times: 10,
        }),
        Effect.map((value) => value as { text: string; path: string }),
      );
      expect(body.path).toEqual(VOLUME_PATH);
      expect(body.text).toEqual(MARKER);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        deployed.api.appName,
        deployed.api.machineId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:ipassignment",
      "provider:fly:machine",
      "provider:fly:service",
      "provider:fly:volume",
      "live",
    ],
    timeout: 180_000,
  },
);

test.provider(
  "destroy recovers a service and its volumes after initial checks fail",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const app = yield* stack.deploy(UnhealthySite);
      const result = yield* stack.deploy(UnhealthyApi).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          _tag: "Fly.ReplicaChecksNotPassing",
        });
      }
      const live = yield* machines.listMachines({ app_name: app.appName });
      expect(
        live.filter((machine) => machine.state !== "destroyed"),
      ).toHaveLength(1);
      const volumes = yield* machines.listVolumes({ app_name: app.appName });
      expect(volumes).toHaveLength(2);
      const attached = volumes.find(
        (volume) => volume.attached_machine_id === live[0]?.id,
      );
      expect(attached).toBeDefined();
      const blocked = yield* machines
        .deleteVolume({
          app_name: app.appName,
          volume_id: attached!.id!,
        })
        .pipe(Effect.flip);
      expect(blocked._tag).toBe("VolumeAttached");
      yield* stack.destroy();
      for (const machine of live) {
        expect(yield* waitUntilGone(app.appName, machine.id!)).toBe("gone");
      }
      for (const volume of volumes) {
        const missing = yield* machines
          .getVolumeById({
            app_name: app.appName,
            volume_id: volume.id!,
          })
          .pipe(Effect.flip);
        expect(missing._tag).toBe("NotFound");
      }
    }).pipe(logLevel),
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "provider:fly:volume",
      "live",
    ],
    timeout: 180_000,
  },
);

test.provider(
  "creates a custom service check and reports it passing",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* ChecksSite;
          const service = yield* ChecksApi;
          return { app, service };
        }),
      );

      const live = yield* machines.getMachine({
        app_name: deployed.app.appName,
        machine_id: deployed.service.machineId,
      });
      const check = live.config?.services?.[0]?.checks?.[0];
      expect(check?.type).toEqual("http");
      expect(check?.port).toEqual(API_PORT);
      expect(check?.method).toEqual("GET");
      expect(check?.path).toEqual("/health");
      expect(check?.protocol).toEqual("http");
      expect(check?.interval).toEqual("15s");
      expect(check?.timeout).toEqual("3s");
      expect(check?.grace_period).toEqual("20s");

      const serviceChecks =
        live.checks?.filter((check) =>
          check.name?.startsWith("servicecheck-"),
        ) ?? [];
      expect(serviceChecks).toHaveLength(1);
      expect(serviceChecks[0]?.name).toEqual(
        `servicecheck-00-http-${API_PORT}`,
      );
      expect(serviceChecks[0]?.status).toEqual("passing");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        deployed.service.appName,
        deployed.service.machineId,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: [
      "provider:fly",
      "provider:fly:app",
      "provider:fly:machine",
      "provider:fly:service",
      "live",
    ],
    timeout: 180_000,
  },
);

const ownedTags = [
  "provider:fly",
  "provider:fly:app",
  "provider:fly:machine",
  "provider:fly:service",
  "live",
];

/** Observed address kinds on an App. */
const addressKinds = (appName: string) =>
  machines
    .listAppIPAssignments({ app_name: appName })
    .pipe(
      Effect.map((res) =>
        (res.ips ?? [])
          .map((ip) =>
            ip.network !== undefined && ip.network !== null
              ? "flycast"
              : ip.shared === true
                ? "shared_v4"
                : (ip.ip ?? "").includes(":")
                  ? "v6"
                  : "v4",
          )
          .sort(),
      ),
    );

const appGone = (appName: string) =>
  machines.getApp({ app_name: appName }).pipe(
    Effect.as(false),
    Effect.catchTag("NotFound", () => Effect.succeed(true)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (gone) => gone,
      times: 10,
    }),
  );

const getText = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((res) =>
      res.status === 200
        ? res.text
        : res.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(new Error(`${url} returned ${res.status}: ${body}`)),
            ),
          ),
    ),
    Effect.retry({ schedule: Schedule.spaced("4 seconds"), times: 15 }),
  );

test.provider(
  "a Service owns its App and serves its public url",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const owned = yield* stack.deploy(Echo());
      expect(owned.ownsApp).toBe(true);
      expect(owned.url).toEqual(`https://${owned.appName}.fly.dev`);
      // Public Services get a plain-HTTP binding port for bound callers.
      expect(owned.privateUrl).toEqual(`http://${owned.appName}.flycast:7780`);
      // Port 80 only redirects to HTTPS, so it is not an endpoint.
      expect(owned.endpoints).toEqual([
        {
          host: `${owned.appName}.fly.dev`,
          port: 443,
          internalPort: 3000,
          protocol: "tcp",
          handlers: ["tls", "http"],
          url: `https://${owned.appName}.fly.dev`,
        },
      ]);
      expect(yield* addressKinds(owned.appName)).toEqual([
        "flycast",
        "shared_v4",
        "v6",
      ]);
      expect(yield* getText(owned.url!)).toEqual(ECHO_BODY);

      // Moving into a shared App replaces the Service and deletes its App.
      const moved = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* Fly.App("EchoSharedSite");
          return yield* Echo({ app: site });
        }),
      );
      expect(moved.ownsApp).toBe(false);
      expect(moved.appName).not.toEqual(owned.appName);
      expect(moved.url).toEqual(`https://${moved.appName}.fly.dev`);
      expect(moved.privateUrl).toEqual(`http://${moved.appName}.flycast:7780`);
      expect(yield* appGone(owned.appName)).toBe(true);

      yield* stack.destroy();
      expect(yield* appGone(moved.appName)).toBe(true);
    }).pipe(logLevel),
  { tags: ownedTags, timeout: 300_000 },
);

test.provider(
  "a private Service answers over Flycast and turning it public keeps its App",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (isPublic: boolean) =>
        stack.deploy(
          Effect.gen(function* () {
            const client = yield* Fly.App("EchoCallerSite");
            const caller = yield* Fly.Machine("Caller", {
              app: client,
              ...nginx,
            });
            const echo = yield* Echo({ public: isPublic });
            return { caller, echo };
          }),
        );

      const hidden = yield* deploy(false);
      expect(hidden.echo.ownsApp).toBe(true);
      expect(hidden.echo.url).toBeUndefined();
      expect(hidden.echo.privateUrl).toEqual(
        `http://${hidden.echo.appName}.flycast`,
      );
      expect(hidden.echo.endpoints).toEqual([
        {
          host: `${hidden.echo.appName}.flycast`,
          port: 80,
          internalPort: 3000,
          protocol: "tcp",
          handlers: ["http"],
          url: `http://${hidden.echo.appName}.flycast`,
        },
      ]);
      expect(yield* addressKinds(hidden.echo.appName)).toEqual(["flycast"]);
      expect(
        yield* fetchFrom(hidden.caller, hidden.echo.privateUrl!, ECHO_BODY),
      ).toContain(ECHO_BODY);

      const shown = yield* deploy(true);
      expect(shown.echo.appName).toEqual(hidden.echo.appName);
      expect(shown.echo.url).toEqual(`https://${shown.echo.appName}.fly.dev`);
      expect(yield* addressKinds(shown.echo.appName)).toEqual([
        "flycast",
        "shared_v4",
        "v6",
      ]);
      expect(yield* getText(shown.echo.url!)).toEqual(ECHO_BODY);

      const hiddenAgain = yield* deploy(false);
      expect(hiddenAgain.echo.appName).toEqual(hidden.echo.appName);
      expect(hiddenAgain.echo.url).toBeUndefined();
      expect(yield* addressKinds(hiddenAgain.echo.appName)).toEqual([
        "flycast",
      ]);

      yield* stack.destroy();
      expect(yield* appGone(hidden.echo.appName)).toBe(true);
      expect(yield* appGone(hidden.caller.appName)).toBe(true);
    }).pipe(logLevel),
  { tags: ownedTags, timeout: 400_000 },
);

test.provider(
  "public or network on a Service in a shared App is rejected before anything is created",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const app = yield* stack.deploy(Fly.App("EchoInvalidSite"));
      for (const invalid of [{ public: false }, { network: "any-network" }]) {
        const failed = yield* stack
          .deploy(
            Effect.gen(function* () {
              const site = yield* Fly.App("EchoInvalidSite");
              return yield* Echo({ app: site, ...invalid });
            }),
          )
          .pipe(Effect.flip);
        expect(failed).toMatchObject({ _tag: "Fly.InvalidServiceProps" });
      }
      expect(yield* machines.listMachines({ app_name: app.appName })).toEqual(
        [],
      );
      yield* stack.destroy();
      expect(yield* appGone(app.appName)).toBe(true);
    }).pipe(logLevel),
  { tags: ownedTags, timeout: 120_000 },
);

test.provider(
  "Services on the stack network reach each other and nothing else reaches them",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const users = yield* SecureUsers;
          const gateway = yield* SecureGateway;
          const outside = yield* Fly.App("OutsideSite");
          const outsider = yield* Fly.Machine("Outsider", {
            app: outside,
            ...nginx,
          });
          return {
            users,
            gateway,
            outsider,
            network: yield* Fly.stackNetwork,
          };
        }),
      );
      const { users, gateway, outsider, network } = deployed;
      expect(users.network).toEqual(network);
      expect(gateway.network).toEqual(network);
      expect(users.url).toBeUndefined();
      expect(users.privateUrl).toEqual(`http://${users.appName}.flycast`);
      for (const appName of [users.appName, gateway.appName]) {
        const app = yield* machines.getApp({ app_name: appName });
        expect(app.network).toEqual(network);
      }
      const flycast = (yield* machines.listAppIPAssignments({
        app_name: users.appName,
      })).ips;
      expect(flycast?.map((ip) => ip.network?.name)).toEqual([network]);

      // The public gateway reaches the private Service over the stack network.
      expect(yield* getText(gateway.url!)).toEqual(SECURE_USERS_BODY);

      // An App on the default network cannot resolve either private name.
      for (const url of [
        users.privateUrl!,
        `http://${users.appName}.internal:3000`,
      ]) {
        const response = yield* fetchOnce(outsider, url);
        expect(response).not.toContain(SECURE_USERS_BODY);
        expect(response).toContain("bad address");
      }

      yield* stack.destroy();
      for (const appName of [users.appName, gateway.appName, outsider.appName])
        expect(yield* appGone(appName)).toBe(true);
    }).pipe(logLevel),
  { tags: ownedTags, timeout: 400_000 },
);

test.provider(
  "Services in one App publish separate ports and each url reaches its own Service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* Fly.App("PortsSite");
          yield* Fly.IpAssignment("PortsV4", { app: site, type: "shared_v4" });
          const api = yield* Echo(
            {
              app: site,
              env: { ECHO_BODY: "api" },
              services: [
                {
                  protocol: "tcp",
                  internalPort: 3000,
                  autostop: "off",
                  ports: [
                    { port: 80, handlers: ["http"], forceHttps: true },
                    { port: 443, handlers: ["tls", "http"] },
                  ],
                },
              ],
            },
            "PortsApi",
          );
          const admin = yield* Echo(
            {
              app: site,
              env: { ECHO_BODY: "admin" },
              // The API already uses the default binding port.
              bindingPort: 7781,
              services: [
                {
                  protocol: "tcp",
                  internalPort: 3000,
                  autostop: "off",
                  ports: [{ port: 8443, handlers: ["tls", "http"] }],
                },
                {
                  protocol: "tcp",
                  internalPort: 3000,
                  autostop: "off",
                  ports: [{ port: 7000 }],
                },
              ],
            },
            "PortsAdmin",
          );
          return { api, admin };
        }),
      );
      const { api, admin } = deployed;
      const host = `${api.appName}.fly.dev`;
      expect(admin.appName).toEqual(api.appName);
      expect(api.url).toEqual(`https://${host}`);
      expect(admin.url).toEqual(`https://${host}:8443`);
      expect(api.privateUrl).toEqual(`http://${api.appName}.flycast:7780`);
      expect(admin.privateUrl).toEqual(`http://${api.appName}.flycast:7781`);
      expect(admin.endpoints).toEqual([
        {
          host,
          port: 8443,
          internalPort: 3000,
          protocol: "tcp",
          handlers: ["tls", "http"],
          url: `https://${host}:8443`,
        },
        {
          host,
          port: 7000,
          internalPort: 3000,
          protocol: "tcp",
          handlers: [],
          url: undefined,
        },
      ]);
      // TLS on a non-standard port is served over the shared IPv4.
      expect(yield* getText(api.url!)).toEqual("api");
      expect(yield* getText(admin.url!)).toEqual("admin");

      yield* stack.destroy();
      expect(yield* appGone(api.appName)).toBe(true);
    }).pipe(logLevel),
  { tags: ownedTags, timeout: 400_000 },
);

/** POST to an RPC path from inside a Machine, printing the status line. */
const postRpc = (caller: { appName: string; machineId: string }, url: string) =>
  machines
    .execMachine({
      app_name: caller.appName,
      machine_id: caller.machineId,
      command: [
        "sh",
        "-c",
        `wget -S -qO- -T 5 --post-data='[]' ${url}/__rpc__/listUsers 2>&1 || true`,
      ],
      timeout: 15,
    })
    .pipe(Effect.map((result) => result.stdout ?? ""));

test.provider(
  "bound Services call methods, stream, fetch, and a published endpoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const users = yield* RpcUsers;
          const orders = yield* RpcOrders;
          const gateway = yield* RpcGateway;
          const network = yield* Fly.stackNetwork;
          // On the stack network, but binds nothing.
          const snoopApp = yield* Fly.App("SnoopSite", { network });
          const snoop = yield* Fly.Machine("Snoop", {
            app: snoopApp,
            ...nginx,
          });
          return { users, orders, gateway, snoop };
        }),
      );
      const { users, orders, gateway, snoop } = deployed;
      const base = gateway.url!;
      expect(users.url).toBeUndefined();
      expect(users.privateUrl).toEqual(`http://${users.appName}.flycast`);
      expect(orders.privateUrl).toEqual(`http://${orders.appName}.flycast`);
      expect(gateway.privateUrl).toEqual(
        `http://${gateway.appName}.flycast:7780`,
      );

      // A method call returns a typed result.
      expect(JSON.parse(yield* getText(`${base}/users`))).toEqual(USERS);
      // A private Service calls another through its own binding.
      expect(JSON.parse(yield* getText(`${base}/orders`))).toEqual(
        ORDERS.map((order) => ({
          ...order,
          user: USERS.find((user) => user.id === order.userId),
        })),
      );
      // A streamed method delivers every element.
      expect(JSON.parse(yield* getText(`${base}/stream`))).toEqual(USERS);
      // `fetch` reaches the Service's HTTP routes on its private address.
      expect(yield* getText(`${base}/http`)).toEqual("users-http 80 /hello");
      // `bindEndpoint` reaches the admin port.
      expect(yield* getText(`${base}/admin`)).toEqual(
        `${users.appName}.flycast:9000 users-http 9000 /stats`,
      );

      // Same network, no binding, no token: the method is refused.
      const snooped = yield* postRpc(snoop, users.privateUrl!);
      expect(snooped).toContain("401");
      expect(snooped).not.toContain("Ada");

      // A public request never passes the Fly-Src check.
      const publicCall = yield* HttpClient.post(
        `${base}/__rpc__/listUsers`,
      ).pipe(Effect.map((response) => response.status));
      expect(publicCall).toEqual(401);

      yield* stack.destroy();
      for (const appName of [
        users.appName,
        orders.appName,
        gateway.appName,
        snoop.appName,
      ])
        expect(yield* appGone(appName)).toBe(true);
    }).pipe(logLevel),
  { tags: ownedTags, timeout: 600_000 },
);

test.provider(
  "binding a Service on another network fails before the caller is created",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const users = yield* stack.deploy(RpcUsers);
      const failed = yield* stack
        .deploy(
          Effect.gen(function* () {
            yield* RpcUsers;
            return yield* RpcStranger;
          }),
        )
        .pipe(Effect.flip);
      expect(failed).toMatchObject({
        _tag: "Fly.ServiceUnreachable",
        target: "RpcUsers",
        network: undefined,
        targetNetwork: users.network,
      });
      yield* stack.destroy();
      expect(yield* appGone(users.appName)).toBe(true);
    }).pipe(logLevel),
  { tags: ownedTags, timeout: 400_000 },
);

test.provider(
  "two Services that bind each other deploy and call each other",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const ping = yield* Ping;
          const pong = yield* Pong;
          return { ping, pong };
        }).pipe(Effect.provide(Layer.mergeAll(PingLive, PongLive))),
      );
      expect(yield* getText(deployed.ping.url!)).toEqual("ping hears pong");
      expect(yield* getText(deployed.pong.url!)).toEqual("pong hears ping");
      yield* stack.destroy();
      expect(yield* appGone(deployed.ping.appName)).toBe(true);
      expect(yield* appGone(deployed.pong.appName)).toBe(true);
    }).pipe(logLevel),
  { tags: ownedTags, timeout: 600_000 },
);

test.provider(
  "Services on the same port in one App are rejected before any Machine exists",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (second: Partial<Parameters<typeof Echo>[0]>) =>
        Effect.gen(function* () {
          const site = yield* Fly.App("ConflictSite");
          const first = yield* Echo({ app: site }, "ConflictFirst");
          const other = yield* Echo({ app: site, ...second }, "ConflictSecond");
          return { site, first, other };
        });
      const machinesIn = (appName: string) =>
        machines
          .listMachines({ app_name: appName })
          .pipe(
            Effect.map((listed) =>
              listed.filter((machine) => machine.state !== "destroyed"),
            ),
          );

      // Two new Services on the same default ports in one deploy.
      const both = yield* stack.deploy(program({})).pipe(Effect.flip);
      expect(both).toMatchObject({
        _tag: "Fly.ServicePortConflict",
        port: 80,
      });

      // One deployed Service, then a second one on its ports.
      const first = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* Fly.App("ConflictSite");
          return yield* Echo({ app: site }, "ConflictFirst");
        }),
      );
      expect(yield* machinesIn(first.appName)).toHaveLength(1);
      const added = yield* stack.deploy(program({})).pipe(Effect.flip);
      expect(added).toMatchObject({ _tag: "Fly.ServicePortConflict" });
      expect(yield* machinesIn(first.appName)).toHaveLength(1);

      // Distinct ports deploy.
      const fixed = yield* stack.deploy(
        program({
          services: [
            {
              protocol: "tcp",
              internalPort: 3000,
              autostop: "off",
              ports: [{ port: 8443, handlers: ["tls", "http"] }],
            },
          ],
          bindingPort: 7781,
        }),
      );
      expect(yield* machinesIn(fixed.site.appName)).toHaveLength(2);
      yield* stack.destroy();
      expect(yield* appGone(fixed.site.appName)).toBe(true);
    }).pipe(logLevel),
  { tags: ownedTags, timeout: 600_000 },
);

/** Region of every running Machine in an App, sorted. */
const machineRegions = (appName: string) =>
  machines.listMachines({ app_name: appName }).pipe(
    Effect.map((listed) =>
      listed
        .filter((machine) => machine.state !== "destroyed")
        .map((machine) => machine.region ?? "")
        .sort(),
    ),
  );

const machineIdsIn = (appName: string, region: string) =>
  machines.listMachines({ app_name: appName }).pipe(
    Effect.map((listed) =>
      listed
        .filter(
          (machine) =>
            machine.state !== "destroyed" && machine.region === region,
        )
        .map((machine) => machine.id ?? "")
        .sort(),
    ),
  );

test.provider(
  "a Service runs in several regions and adds, scales, and drops regions in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (options: Parameters<typeof Echo>[0]) =>
        stack.deploy(Echo(options, "Regional"));

      const two = yield* deploy({ region: ["iad", "lhr"] });
      expect(two.region).toEqual("iad");
      expect(two.regions).toEqual(["iad", "lhr"]);
      expect(two.count).toEqual(1);
      expect(yield* machineRegions(two.appName)).toEqual(["iad", "lhr"]);
      expect(yield* getText(two.url!)).toEqual(ECHO_BODY);
      const iad = yield* machineIdsIn(two.appName, "iad");
      const lhr = yield* machineIdsIn(two.appName, "lhr");

      // Adding a region keeps the App and the existing Machines.
      const three = yield* deploy({ region: ["iad", "lhr", "sin"] });
      expect(three.appName).toEqual(two.appName);
      expect(three.regions).toEqual(["iad", "lhr", "sin"]);
      expect(yield* machineRegions(three.appName)).toEqual([
        "iad",
        "lhr",
        "sin",
      ]);
      expect(yield* machineIdsIn(three.appName, "iad")).toEqual(iad);
      expect(yield* machineIdsIn(three.appName, "lhr")).toEqual(lhr);

      // `count` is per region.
      const scaled = yield* deploy({ region: ["iad", "lhr", "sin"], count: 2 });
      expect(scaled.count).toEqual(2);
      expect(scaled.machineIds).toHaveLength(6);
      expect(yield* machineRegions(scaled.appName)).toEqual([
        "iad",
        "iad",
        "lhr",
        "lhr",
        "sin",
        "sin",
      ]);

      // Dropping a region deletes its Machines and keeps the hostname.
      const dropped = yield* deploy({ region: ["iad", "sin"], count: 2 });
      expect(dropped.appName).toEqual(two.appName);
      expect(dropped.url).toEqual(two.url);
      expect(yield* machineRegions(dropped.appName)).toEqual([
        "iad",
        "iad",
        "sin",
        "sin",
      ]);
      expect(yield* getText(dropped.url!)).toEqual(ECHO_BODY);

      // A single region string still works.
      const single = yield* deploy({ region: "sin" });
      expect(single.regions).toEqual(["sin"]);
      expect(yield* machineRegions(single.appName)).toEqual(["sin"]);

      yield* stack.destroy();
      expect(yield* appGone(two.appName)).toBe(true);
    }).pipe(logLevel),
  { tags: ownedTags, timeout: 600_000 },
);

test.provider(
  "a multi-region Service mounts a Volume in each Machine's region",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const api = yield* stack.deploy(RegionalApi);
      expect(api.regions).toEqual(["iad", "lhr"]);
      expect(["iad", "lhr"]).toContain(yield* getText(api.url!));
      const volumes = yield* machines.listVolumes({ app_name: api.appName });
      const live = (yield* machines.listMachines({
        app_name: api.appName,
      })).filter((machine) => machine.state !== "destroyed");
      expect(volumes.map((volume) => volume.region).sort()).toEqual([
        "iad",
        "lhr",
      ]);
      for (const volume of volumes) {
        const attached = live.find(
          (machine) => machine.id === volume.attached_machine_id,
        );
        expect(attached?.region).toEqual(volume.region);
      }
      yield* stack.destroy();
      expect(yield* appGone(api.appName)).toBe(true);
    }).pipe(logLevel),
  { tags: ownedTags, timeout: 400_000 },
);

test.provider(
  "a blue/green Service replaces its generation in every region",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (body: string) =>
        stack.deploy(
          Echo(
            {
              region: ["iad", "lhr"],
              env: { ECHO_BODY: body },
              deploy: { strategy: "bluegreen", healthTimeout: "60 seconds" },
            },
            "RegionalBlueGreen",
          ),
        );
      const first = yield* deploy("one");
      expect(yield* machineRegions(first.appName)).toEqual(["iad", "lhr"]);
      const second = yield* deploy("two");
      expect(second.appName).toEqual(first.appName);
      expect(
        second.machineIds.some((id) => first.machineIds.includes(id)),
      ).toBe(false);
      expect(yield* machineRegions(second.appName)).toEqual(["iad", "lhr"]);
      expect(yield* getText(second.url!)).toEqual("two");
      yield* stack.destroy();
      expect(yield* appGone(first.appName)).toBe(true);
    }).pipe(logLevel),
  { tags: ownedTags, timeout: 500_000 },
);
