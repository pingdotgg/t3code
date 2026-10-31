import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { SimlockDeviceHostConfig } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as SimlockDeviceHost from "./SimlockDeviceHost.ts";

const GATEWAY = "https://simlock.test:4700";

const config = (overrides: Partial<SimlockDeviceHostConfig> = {}): SimlockDeviceHostConfig => ({
  kind: "simlock",
  id: "pool",
  label: "Device pool",
  gatewayUrl: `${GATEWAY}/`,
  agentToken: "agent-token",
  maxLeases: 2,
  maxLeaseMinutes: 60,
  ...overrides,
});

const CATALOG = {
  platforms: [
    {
      platform: "ios",
      modelRuntimes: { "iPhone 17 Pro": ["27.0"], "Apple TV 4K": ["27.0"], "iPhone 12": [] },
      modelClasses: { "iPhone 17 Pro": "phone", "Apple TV 4K": "tv", "iPhone 12": "phone" },
    },
    {
      platform: "android",
      modelRuntimes: { "Pixel 9": ["36"], "Pixel 8": ["36"] },
      modelWorkers: { "Pixel 9": ["worker-a"], "Pixel 8": [] },
    },
  ],
};

/** The gateway's HTTP API and T3's agent-device CLI, recording what was asked of them. */
const fakePool = (
  options: {
    /** What the agent-device CLI prints before exiting 1 from `open`. */
    readonly failOpen?: unknown;
    readonly holdOpen?: {
      readonly entered: Deferred.Deferred<void>;
      readonly proceed: Deferred.Deferred<void>;
    };
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const requests: Array<string> = [];
    const commands: Array<{ readonly args: ReadonlyArray<string>; readonly cwd?: string }> = [];
    let leases = 0;
    let renewStatus = 200;
    let catalog: unknown = CATALOG;
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        const url = new URL(request.url);
        requests.push(`${request.method} ${url.pathname}`);
        const json = (body: unknown, status = 200) =>
          HttpClientResponse.fromWeb(request, Response.json(body, { status }));
        if (request.headers.authorization !== "Bearer agent-token")
          return json({ error: { code: "UNAUTHENTICATED", message: "Unknown bearer token" } }, 401);
        if (url.pathname === "/v1/catalog") return json(catalog);
        if (url.pathname.endsWith("/renew")) return json({}, renewStatus);
        if (request.method === "DELETE") return json({}, 202);
        return json({}, 404);
      }),
    );
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.gen(function* () {
          const args = input.args.slice(1);
          commands.push({ args, ...(input.cwd ? { cwd: input.cwd } : {}) });
          const command = args[0];
          const session = args[args.indexOf("--session") + 1]!;
          const configFile = args[args.indexOf("--config") + 1]!;
          const stateDir = (
            JSON.parse(yield* fs.readFileString(configFile)) as { stateDir: string }
          ).stateDir;
          if (command === "open") {
            if (options.failOpen) {
              return {
                stdout: JSON.stringify(options.failOpen),
                stderr: "",
                code: ChildProcessSpawner.ExitCode(1),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              };
            }
            if (options.holdOpen) {
              yield* Deferred.succeed(options.holdOpen.entered, undefined);
              yield* Deferred.await(options.holdOpen.proceed);
            }
            const dir = path.join(stateDir, "remote-connections");
            yield* fs.makeDirectory(dir, { recursive: true });
            yield* fs.writeFileString(
              path.join(dir, `${session}.json`),
              JSON.stringify({ leaseId: `lease-${++leases}` }),
            );
          }
          if (command === "screenshot") yield* fs.writeFile(args[1]!, new Uint8Array([1, 2, 3]));
          return {
            stdout: "{}",
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }).pipe(Effect.orDie),
    });
    const ran = (command: string) => commands.filter(({ args }) => args[0] === command);
    return {
      http,
      runner,
      requests,
      ran,
      endLeases: () => {
        renewStatus = 404;
      },
      setCatalog: (next: unknown) => {
        catalog = next;
      },
    };
  });

const layer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-simlock-host-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

const makeHost = (
  pool: Effect.Success<ReturnType<typeof fakePool>>,
  hostConfig: SimlockDeviceHostConfig,
  scope: Scope.Scope,
) =>
  SimlockDeviceHost.make(
    hostConfig,
    Effect.succeed({ nodePath: "node", entryPath: "/tools/agent-device.mjs" }),
  ).pipe(
    Effect.provideService(HttpClient.HttpClient, pool.http),
    Effect.provideService(ProcessRunner.ProcessRunner, pool.runner),
    Effect.provideService(Scope.Scope, scope),
  );

describe("Simlock device host", () => {
  it.effect("leases a pool device for agents and serves its screen and input to the panel", () =>
    Effect.gen(function* () {
      const pool = yield* fakePool();
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* fs.makeTempDirectoryScoped();
      const scope = yield* Scope.make();
      const host = yield* makeHost(pool, config(), scope);
      const ready = yield* host.ensureReady(() => Effect.void);

      const catalog = (yield* ready.devices.list).devices;
      // Only models a worker can make right now, and only phones and tablets.
      expect(catalog.map((device) => [device.id, device.version])).toEqual([
        ["simlock:ios:iPhone 17 Pro", "iOS 27.0"],
        ["simlock:android:Pixel 9", "Android 36"],
      ]);

      const leaseId = yield* ready.devices.boot(catalog[1]!, { workspaceRoot: workspace });
      expect(leaseId).toBe("lease-1");
      const [open] = pool.ran("open");
      expect(open?.args.slice(0, 5)).toEqual([
        "open",
        "--platform",
        "android",
        "--device",
        "Pixel 9",
      ]);
      expect(open?.cwd).toBe(yield* fs.realPath(workspace));
      expect(pool.ran("connect")[0]?.args).toContain(`${GATEWAY}/v1/agent-device`);

      const binding = yield* ready.devices.agentEndpoint!(leaseId);
      expect(binding).toMatchObject({
        baseUrl: `${GATEWAY}/v1/agent-device`,
        token: "agent-token",
        agentDeviceId: null,
        session: open?.args[open.args.indexOf("--session") + 1],
        installDirectory: yield* fs.realPath(workspace),
      });
      expect((yield* ready.devices.list).devices.at(-1)).toMatchObject({
        id: "lease-1",
        name: "Pixel 9",
        booted: true,
      });

      expect(
        yield* ready.upstream!(
          "/vendor/serve-sim/helper/lease-1/stream.avcc",
          new URLSearchParams(),
        ),
      ).toEqual({
        url: `${GATEWAY}/v1/leases/lease-1/stream`,
        headers: { authorization: "Bearer agent-token" },
        protocols: [],
      });
      expect(
        yield* ready.upstream!(
          "/vendor/serve-sim/helper/ws",
          new URLSearchParams({ device: "lease-1" }),
        ),
      ).toEqual({
        url: `${GATEWAY}/v1/leases/lease-1/input`,
        headers: { authorization: "Bearer agent-token" },
        protocols: [],
      });
      expect(
        yield* ready.upstream!("/vendor/serve-sim/helper/lease-1/config", new URLSearchParams()),
      ).toBeNull();
      expect(
        yield* ready.upstream!(
          "/vendor/serve-sim/helper/ws",
          new URLSearchParams({ device: "lease-2" }),
        ),
      ).toBeNull();
      expect([...(yield* ready.devices.screenshot({ ...catalog[1]!, id: leaseId }))]).toEqual([
        1, 2, 3,
      ]);

      yield* ready.devices.shutdown({ id: leaseId, platform: "android" });
      expect(pool.ran("close")).toHaveLength(1);
      expect((yield* ready.devices.list).devices.some((device) => device.booted)).toBe(false);
      yield* Scope.close(scope, Exit.void);
      expect(pool.ran("close")).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("caps leases at the limit", () =>
    Effect.gen(function* () {
      const pool = yield* fakePool();
      const scope = yield* Scope.make();
      const host = yield* makeHost(pool, config({ maxLeases: 1 }), scope);
      const ready = yield* host.ensureReady(() => Effect.void);
      const [iphone] = (yield* ready.devices.list).devices;
      yield* ready.devices.boot(iphone!);

      const refused = yield* ready.devices.boot(iphone!).pipe(Effect.flip);
      expect(refused.message).toContain("limited to 1 device");
      expect(pool.ran("open")).toHaveLength(1);
      yield* Scope.close(scope, Exit.void);
      expect(pool.ran("close")).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("reports its platforms unavailable when the gateway refuses the agent token", () =>
    Effect.gen(function* () {
      const pool = yield* fakePool();
      const scope = yield* Scope.make();
      const host = yield* makeHost(pool, config({ agentToken: "revoked" }), scope);
      expect(yield* host.platformAvailability("ios")).toEqual({
        platform: "ios",
        available: false,
        reason: "The Simlock gateway refused the agent token for Device pool.",
      });
      expect((yield* host.summary).platforms.every((platform) => !platform.available)).toBe(true);
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("sends saved and machine tokens only to the gateway each belongs to", () =>
    Effect.gen(function* () {
      const pool = yield* fakePool();
      const availability = (baseUrl: string) =>
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          const host = yield* makeHost(pool, config({ agentToken: "" }), scope).pipe(
            Effect.provideService(HostProcess.Environment, {
              AGENT_DEVICE_DAEMON_BASE_URL: baseUrl,
              AGENT_DEVICE_DAEMON_AUTH_TOKEN: "agent-token",
            }),
          );
          const result = yield* host.platformAvailability("ios");
          yield* Scope.close(scope, Exit.void);
          return result;
        });

      expect(
        SimlockDeviceHost.resolveSimlockToken(
          "https://elsewhere.example:4700",
          config({ agentToken: "saved-token" }),
          {},
        ),
      ).toBeNull();

      expect(yield* availability(`${GATEWAY}/v1/agent-device`)).toEqual({
        platform: "ios",
        available: true,
      });
      const requests = pool.requests.length;
      expect(yield* availability("https://elsewhere.example:4700/v1/agent-device")).toEqual({
        platform: "ios",
        available: false,
        reason: "Add an agent token for Device pool in Settings.",
      });
      expect(pool.requests).toHaveLength(requests);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("lists a platform again as soon as its workers return", () =>
    Effect.gen(function* () {
      const pool = yield* fakePool();
      const scope = yield* Scope.make();
      const host = yield* makeHost(pool, config(), scope);
      const ready = yield* host.ensureReady(() => Effect.void);
      pool.setCatalog({ platforms: [] });
      expect((yield* ready.devices.list).devices).toEqual([]);
      // Mid-reconnect, the gateway knows the Android models but no worker that makes them.
      pool.setCatalog({
        platforms: [
          CATALOG.platforms[0]!,
          { ...CATALOG.platforms[1]!, modelWorkers: { "Pixel 9": [], "Pixel 8": [] } },
        ],
      });
      const during = (yield* ready.devices.list).devices;
      expect(during.some((device) => device.platform === "android")).toBe(false);
      pool.setCatalog(CATALOG);
      const after = (yield* ready.devices.list).devices;
      expect(after.some((device) => device.platform === "android")).toBe(true);
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("closes the session of a failed open so no lease is left behind", () =>
    Effect.gen(function* () {
      const pool = yield* fakePool({
        failOpen: { error: { message: "No device matches.", hint: "Retry." } },
      });
      const scope = yield* Scope.make();
      const host = yield* makeHost(pool, config(), scope);
      const ready = yield* host.ensureReady(() => Effect.void);
      const [iphone] = (yield* ready.devices.list).devices;
      const failure = yield* ready.devices.boot(iphone!).pipe(Effect.flip);
      expect(String(failure.cause)).toContain("No device matches. Retry.");
      expect(pool.ran("close")).toHaveLength(1);
      // The failed open freed its slot.
      expect(yield* ready.devices.boot(iphone!).pipe(Effect.flip)).toBeDefined();
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("tells the user what agent-device reported when a device fails to open", () =>
    Effect.gen(function* () {
      const pool = yield* fakePool({
        failOpen: {
          success: false,
          error: {
            code: "COMMAND_FAILED",
            message: "Invalid daemon response",
            cause: {
              message: "Unexpected non-whitespace character after JSON at position 4",
            },
            hint: "Retry with --debug and inspect diagnostics log for details.",
            details: { requestId: "22a6bf10a567b2a1", line: "404 Not Found" },
          },
        },
      });
      const scope = yield* Scope.make();
      const host = yield* makeHost(pool, config(), scope);
      const ready = yield* host.ensureReady(() => Effect.void);
      const pixel = (yield* ready.devices.list).devices.find(({ name }) => name === "Pixel 9");
      const failure = yield* ready.devices.boot(pixel!).pipe(Effect.flip);
      expect(failure.message).not.toContain("The device host sent no details.");
      expect(failure.message).toContain("Invalid daemon response");
      expect(failure.message).toContain("404 Not Found");
      yield* Scope.close(scope, Exit.void);

      // A details bag without a usable response line still keeps agent-device's message.
      const oddPool = yield* fakePool({
        failOpen: { error: { message: "Invalid daemon response", details: { line: 17 } } },
      });
      const oddScope = yield* Scope.make();
      const oddReady = yield* (yield* makeHost(oddPool, config(), oddScope)).ensureReady(
        () => Effect.void,
      );
      const [oddDevice] = (yield* oddReady.devices.list).devices;
      const oddFailure = yield* oddReady.devices.boot(oddDevice!).pipe(Effect.flip);
      expect(oddFailure.message).toContain("Invalid daemon response");
      yield* Scope.close(oddScope, Exit.void);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("keeps a watched lease renewed and stops listing it once Simlock ends it", () =>
    Effect.gen(function* () {
      const pool = yield* fakePool();
      const scope = yield* Scope.make();
      const host = yield* makeHost(pool, config(), scope);
      const ready = yield* host.ensureReady(() => Effect.void);
      const [iphone] = (yield* ready.devices.list).devices;
      const leaseId = yield* ready.devices.boot(iphone!);

      yield* TestClock.adjust("2 minutes");
      expect(pool.requests).toContain(`POST /v1/leases/${leaseId}/renew`);
      expect((yield* ready.devices.list).devices.some((device) => device.id === leaseId)).toBe(
        true,
      );

      pool.endLeases();
      yield* TestClock.adjust("2 minutes");
      expect((yield* ready.devices.list).devices.some((device) => device.id === leaseId)).toBe(
        false,
      );
      yield* Scope.close(scope, Exit.void);
      expect(pool.ran("close")).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("returns a lease whose open finishes after the host stopped", () =>
    Effect.gen(function* () {
      const holdOpen = {
        entered: yield* Deferred.make<void>(),
        proceed: yield* Deferred.make<void>(),
      };
      const pool = yield* fakePool({ holdOpen });
      const host = yield* makeHost(pool, config(), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [iphone] = (yield* ready.devices.list).devices;
      const opening = yield* Effect.forkChild(ready.devices.boot(iphone!));
      yield* Deferred.await(holdOpen.entered);
      yield* host.stop;
      yield* Deferred.succeed(holdOpen.proceed, undefined);
      expect(Exit.isFailure(yield* Fiber.await(opening))).toBe(true);
      expect(pool.ran("close")).toHaveLength(1);
      expect((yield* ready.devices.list).devices.every((device) => !device.booted)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("holds a lease for its full maximum age, then returns it", () =>
    Effect.gen(function* () {
      const pool = yield* fakePool();
      const host = yield* makeHost(pool, config({ maxLeaseMinutes: 5 }), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [iphone] = (yield* ready.devices.list).devices;
      yield* ready.devices.boot(iphone!);

      yield* TestClock.adjust("299 seconds");
      expect(pool.ran("close")).toHaveLength(0);
      yield* TestClock.adjust("1 second");
      expect(pool.ran("close")).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
