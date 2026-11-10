// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
// Scenarios: e2e tests that run against the real dev stack. See docs/operations/scenarios.md.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

import { mobile, type DeviceProvider } from "@e2e-dev/mobile";
import { web } from "@e2e-dev/web";
import { createAgentDeviceClient } from "agent-device";
import type { E2EConfig } from "e2e";

/** The checkout whose app runs. `prove-scenario.ts` points it at a base or head worktree. */
export const APP_DIR = NodePath.resolve(process.env.T3_SCENARIO_APP_DIR ?? "..");
/** T3 homes only scenarios use, recreated on every run. `.t3` is gitignored. */
export const T3_HOME = NodePath.resolve(import.meta.dirname, "../.t3/scenarios");
export const MOBILE_T3_HOME = `${T3_HOME}-mobile`;

/**
 * A pooled device reaches this machine over the tailnet, not localhost. A mobile target has no
 * `app.url`, so e2e cannot pick these ports; override them when another run holds them.
 */
export const MOBILE = {
  host:
    NodeChildProcess.spawnSync("tailscale", ["ip", "-4"], { encoding: "utf8" })
      .stdout?.trim()
      .split("\n")[0] || "127.0.0.1",
  serverPort: Number(process.env.T3_SCENARIO_SERVER_PORT ?? 13_990),
  metroPort: Number(process.env.T3_SCENARIO_METRO_PORT ?? 8_190),
};

const startApp = NodePath.join(import.meta.dirname, "scenarios/start-app.ts");

/**
 * Leases a device from the Simlock pool, whose gateway speaks agent-device's lease protocol.
 * `retainOnClose` keeps the device when the engine closes its session between attempts.
 */
const simlock = (device: string): DeviceProvider => {
  const connect = (env: Readonly<Record<string, string | undefined>>) => {
    const daemonBaseUrl = env.SIMLOCK_AGENT_DEVICE_URL;
    const daemonAuthToken = env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
    if (daemonBaseUrl === undefined || daemonAuthToken === undefined) {
      throw new Error("SIMLOCK_AGENT_DEVICE_URL and AGENT_DEVICE_DAEMON_AUTH_TOKEN are not set");
    }
    return {
      daemon: { baseUrl: daemonBaseUrl, authToken: daemonAuthToken },
      client: createAgentDeviceClient({ daemonBaseUrl, daemonAuthToken }),
    };
  };
  return {
    name: "simlock",
    acquire: async (request) => {
      const { daemon, client } = connect(request.env);
      const scope = { tenant: "t3-scenarios", runId: `${request.runId}-${request.slot}` };
      const allocate = () =>
        client.leases.allocate({
          ...scope,
          platform: request.platform === "android" ? "android" : "ios",
          device,
          retainOnClose: true,
          // Simlock takes the lease id from the caller.
          leaseId: NodeCrypto.randomBytes(16).toString("hex"),
        });
      // A busy gateway answers its health probe late, which the client reports as unavailable.
      let lease = await allocate().catch(() => undefined);
      for (let attempt = 0; lease === undefined && attempt < 12; attempt++) {
        request.log(`the pool is busy; asking again in 10s`);
        await NodeTimersPromises.setTimeout(10_000, undefined, { signal: request.signal });
        lease = await (attempt === 11 ? allocate() : allocate().catch(() => undefined));
      }
      if (lease === undefined) throw new Error(`The pool leased no ${device}`);
      const leaseScope = { ...scope, leaseId: lease.leaseId, leaseBackend: lease.backend };
      // The pool answers `boot` with the leased device; a worker hosts several, so name ours.
      const platform = request.platform === "android" ? "android" : "ios";
      const leased = await createAgentDeviceClient({
        daemonBaseUrl: daemon.baseUrl,
        daemonAuthToken: daemon.authToken,
        ...leaseScope,
      }).devices.boot({ platform });
      return {
        id: lease.leaseId,
        daemon,
        deviceId: leased.id,
        client: {
          ...leaseScope,
          ...(lease.leaseProvider === undefined ? {} : { leaseProvider: lease.leaseProvider }),
        },
      };
    },
    release: async (lease, context) => {
      await connect(context.env).client.leases.release({ leaseId: lease.id });
    },
  };
};

export default {
  tests: "scenarios/**/*.e2e.ts",
  targets: [
    {
      name: "web",
      engine: web({ viewport: { width: 1280, height: 800 } }),
      app: {
        url: "http://127.0.0.1:0",
        // Vite answers before the server does; this path is proxied to the server.
        readyUrl: "http://127.0.0.1:{port}/.well-known/t3/environment",
        command: {
          executable: process.execPath,
          args: [startApp, "web", T3_HOME, "{port}"],
          cwd: APP_DIR,
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
          executable: process.execPath,
          args: [
            startApp,
            "mobile",
            MOBILE_T3_HOME,
            String(MOBILE.serverPort),
            String(MOBILE.metroPort),
            MOBILE.host,
          ],
          cwd: APP_DIR,
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
