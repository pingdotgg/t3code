// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off - host-side lease bookkeeping.
/** Simlock leases for mobile:behavior and mobile:metrics: one agent-device config, leases kept alive. */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { Device, type Pool, poolError } from "../mobile-e2e/device.ts";
import type { Pose } from "../mobile-e2e/poses.ts";

export interface PoolAccess {
  readonly pool: Pool;
  /** The agent-device config file a run's `--device-config` names. */
  readonly config: string;
  readonly stateDir: string;
  readonly token: string;
  readonly close: () => Promise<void>;
}

/** Writes the pool's agent-device config; `close` removes it. `workspace` must already exist. */
export async function openPool(repoRoot: string, workspace: string): Promise<PoolAccess> {
  const agentDeviceUrl = NodeProcess.env.SIMLOCK_AGENT_DEVICE_URL;
  const token = NodeProcess.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
  if (!agentDeviceUrl || !token)
    throw new Error(
      "Set SIMLOCK_AGENT_DEVICE_URL (<gateway>/v1/agent-device) and AGENT_DEVICE_DAEMON_AUTH_TOKEN (a Simlock agent token) to run on the device pool.",
    );
  const rootDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mobile-pool-"));
  const config = NodePath.join(rootDir, "agent-device.json");
  const stateDir = NodePath.join(rootDir, "agent-device");
  await NodeFSP.writeFile(
    config,
    JSON.stringify({ daemonBaseUrl: agentDeviceUrl, daemonAuthToken: token, stateDir }),
    { mode: 0o600 },
  );
  const real = await NodeFSP.realpath(workspace);
  return {
    pool: {
      repoRoot,
      agentDevice: NodePath.join(
        repoRoot,
        "scripts/node_modules/agent-device/bin/agent-device.mjs",
      ),
      agentDeviceUrl,
      workspace: real,
      env: { ...NodeProcess.env, AGENT_DEVICE_CONFIG: config, PWD: real },
    },
    config,
    stateDir,
    token,
    close: () => NodeFSP.rm(rootDir, { recursive: true, force: true }),
  };
}

/** Leases a device for `pose` and installs the dev client, retrying once on a pool hiccup. */
export async function leaseAndInstall(
  pose: Pose,
  pool: Pool,
  runId: string,
  log: (message: string) => void,
): Promise<Device> {
  for (let attempt = 1; ; attempt++) {
    let device: Device | null = null;
    try {
      log(`leasing ${pose.device}`);
      device = await Device.lease(pose, pool, attempt === 1 ? runId : `${runId}-retry`);
      log("installing the dev client");
      await device.install();
      return device;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await device?.release();
      if (attempt >= 2 || !poolError(message)) throw error;
      log(`retrying after: ${message.split("\n")[0]}`);
    }
  }
}

/** Keeps a lease alive while cases run: they go minutes without an agent-device call. */
export function renewWhileRunning(access: PoolAccess, session: string) {
  const gateway = access.pool.agentDeviceUrl.replace(/\/v1\/agent-device\/?$/, "");
  const timer = setInterval(() => {
    const record = NodePath.join(access.stateDir, "remote-connections", `${session}.json`);
    void NodeFSP.readFile(record, "utf8")
      .then((text) => (JSON.parse(text) as { leaseId: string }).leaseId)
      .then((leaseId) =>
        fetch(`${gateway}/v1/leases/${encodeURIComponent(leaseId)}/renew`, {
          method: "POST",
          headers: { authorization: `Bearer ${access.token}` },
        }),
      )
      .catch(() => undefined);
  }, 90_000);
  return () => clearInterval(timer);
}

/**
 * Releases the lease if the process dies on an uncaught error, which skips every finalizer; a
 * leaked lease holds the device until the pool's TTL. Returns the function that unregisters it.
 */
export function releaseOnCrash(device: Device, access: PoolAccess) {
  const crash = (error: unknown) => {
    NodeProcess.stderr.write(`Crashed (${String(error)}); releasing ${device.session}.\n`);
    void device
      .release()
      .catch(() => undefined)
      .then(() => access.close())
      .finally(() => NodeProcess.exit(1));
  };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
  return () => {
    process.off("uncaughtException", crash);
    process.off("unhandledRejection", crash);
  };
}
