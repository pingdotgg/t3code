// Scenarios: e2e tests that run against the real dev stack. See docs/operations/scenarios.md.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { mobile, type DeviceProvider } from "@e2e-dev/mobile";
import { web } from "@e2e-dev/web";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { createAgentDeviceClient } from "agent-device";
import type { E2EConfig } from "e2e";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schedule from "effect/Schedule";

import { run, ScenarioError } from "./scenarios/shell.ts";

// e2e loads this module for its values, so the paths and the host are resolved once, here.
const resolved = await Effect.gen(function* () {
  const path = yield* Path.Path;
  const env = yield* HostProcess.Environment;
  const scripts = yield* path.fromFileUrl(new URL(".", import.meta.url));
  const home = path.resolve(scripts, "../.t3/scenarios");
  // A pooled device reaches this machine over the tailnet, not localhost.
  const host = yield* run("tailscale", ["ip", "-4"]).pipe(
    Effect.map((result) => result.stdout.trim().split("\n")[0] ?? ""),
    Effect.orElseSucceed(() => ""),
  );
  return {
    node: yield* HostProcess.ExecutablePath,
    scripts,
    /** The checkout whose app runs. `prove-scenario.ts` points it at a base or head worktree. */
    appDir: path.resolve(scripts, env.T3_SCENARIO_APP_DIR ?? ".."),
    home,
    startApp: path.join(scripts, "scenarios/start-app.ts"),
    // e2e gives the app only PATH, HOME and the temp directory. A scenario that needs more names
    // it here: exact names or prefixes ending in `*`, separated by commas.
    inheritEnv: (env.T3_SCENARIO_INHERIT_ENV ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== ""),
    mobile: {
      host: host || "127.0.0.1",
      // A mobile target has no `app.url`, so e2e cannot pick these ports.
      serverPort: Number(env.T3_SCENARIO_SERVER_PORT ?? 13_990),
      metroPort: Number(env.T3_SCENARIO_METRO_PORT ?? 8_190),
    },
  };
}).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

export const APP_DIR = resolved.appDir;
/** T3 homes only scenarios use, recreated on every run. `.t3` is gitignored. */
export const T3_HOME = resolved.home;
export const MOBILE_T3_HOME = `${T3_HOME}-mobile`;
export const MOBILE = resolved.mobile;
const startApp = resolved.startApp;
/**
 * The one address e2e opens the web app at and the app is told to bind. Never `localhost`: the
 * runner and the app can resolve that name to different addresses.
 */
const LOOPBACK = "127.0.0.1";

/**
 * Leases a device from the Simlock pool, whose gateway speaks agent-device's lease protocol.
 * `retainOnClose` keeps the device when the engine closes its session between attempts.
 */
const simlock = (device: string): DeviceProvider => {
  const connect = Effect.fn("simlock.connect")(function* (
    env: Readonly<Record<string, string | undefined>>,
  ) {
    const daemonBaseUrl = env.SIMLOCK_AGENT_DEVICE_URL;
    const daemonAuthToken = env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
    if (daemonBaseUrl === undefined || daemonAuthToken === undefined) {
      return yield* new ScenarioError({
        message: "SIMLOCK_AGENT_DEVICE_URL and AGENT_DEVICE_DAEMON_AUTH_TOKEN are not set.",
      });
    }
    return { daemonBaseUrl, daemonAuthToken };
  });
  const call = <A>(description: string, request: () => Promise<A>) =>
    Effect.tryPromise({
      try: request,
      catch: (cause) => new ScenarioError({ message: `${description}: ${String(cause)}` }),
    });
  const acquire = Effect.fn("simlock.acquire")(function* (
    request: Parameters<DeviceProvider["acquire"]>[0],
  ) {
    const daemon = yield* connect(request.env);
    const client = createAgentDeviceClient(daemon);
    const platform = request.platform === "android" ? "android" : "ios";
    const scope = { tenant: "t3-scenarios", runId: `${request.runId}-${request.slot}` };
    // Simlock takes the lease id from the caller: 32 hex characters.
    const leaseId = (yield* (yield* SecureRandom.SecureRandom).uuidV4()).replaceAll("-", "");
    const lease = yield* call(`The pool leased no ${device}`, () =>
      client.leases.allocate({ ...scope, platform, device, retainOnClose: true, leaseId }),
    ).pipe(
      // A busy gateway answers its health probe late, which the client reports as unavailable.
      Effect.tapError(() => Effect.sync(() => request.log("the pool is busy; asking again"))),
      Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 12 }),
    );
    const leaseScope = { ...scope, leaseId: lease.leaseId, leaseBackend: lease.backend };
    // The pool answers `boot` with the leased device; a worker hosts several, so name ours.
    const leased = yield* call("The pool did not name the leased device", () =>
      createAgentDeviceClient({ ...daemon, ...leaseScope }).devices.boot({ platform }),
    ).pipe(
      // e2e releases only the leases `acquire` returned.
      Effect.tapError(() =>
        call("release", () => client.leases.release({ leaseId: lease.leaseId })).pipe(
          Effect.ignore,
        ),
      ),
    );
    return {
      id: lease.leaseId,
      daemon: { baseUrl: daemon.daemonBaseUrl, authToken: daemon.daemonAuthToken },
      deviceId: leased.id,
      client: {
        ...leaseScope,
        ...(lease.leaseProvider === undefined ? {} : { leaseProvider: lease.leaseProvider }),
      },
    };
  });
  return {
    name: "simlock",
    acquire: (request) =>
      acquire(request).pipe(Effect.provide(NodeCrypto.layer), Effect.runPromise),
    release: (lease, context) =>
      connect(context.env).pipe(
        Effect.flatMap((daemon) =>
          call("release", () =>
            createAgentDeviceClient(daemon).leases.release({ leaseId: lease.id }),
          ),
        ),
        Effect.asVoid,
        Effect.runPromise,
      ),
  };
};

export default {
  tests: "scenarios/**/*.e2e.ts",
  targets: [
    {
      name: "web",
      engine: web({ viewport: { width: 1280, height: 800 } }),
      app: {
        url: `http://${LOOPBACK}:0`,
        // Vite answers before the server does; this path is proxied to the server.
        readyUrl: `http://${LOOPBACK}:{port}/.well-known/t3/environment`,
        command: {
          executable: resolved.node,
          args: [startApp, "web", T3_HOME, LOOPBACK, "{port}"],
          cwd: APP_DIR,
          inheritEnv: resolved.inheritEnv,
          startupTimeout: 300_000,
          log: ".e2e/app.log",
        },
      },
    },
    {
      name: "ios",
      engine: mobile({
        platform: "ios",
        device: simlock("iPhone 18 Pro"),
        session: "t3-scenarios",
      }),
      app: {
        bundleId: "com.t3tools.t3code.dev",
        // Metro starts after the server listens, so it answering means both are up.
        readyUrl: `http://127.0.0.1:${MOBILE.metroPort}/status`,
        command: {
          executable: resolved.node,
          args: [
            startApp,
            "mobile",
            MOBILE_T3_HOME,
            String(MOBILE.serverPort),
            String(MOBILE.metroPort),
            MOBILE.host,
          ],
          cwd: APP_DIR,
          inheritEnv: resolved.inheritEnv,
          startupTimeout: 300_000,
          log: ".e2e/mobile-app.log",
        },
      },
    },
  ],
  // One server holds every test's state, and a dev stack is heavy.
  workers: 1,
  timeout: 300_000,
  assertionTimeout: 15_000,
  video: "on",
  trace: "on",
  reporters: ["list", "markdown"],
} satisfies E2EConfig;
