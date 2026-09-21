// @effect-diagnostics preferSchemaOverJson:off - JSON string literals safely embed paths and arguments in generated JavaScript.
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as ProcessRunner from "../processRunner.ts";
import { AGENT_DEVICE_VERSION, DEVICE_HUB_VERSION } from "./DeviceToolchain.ts";

/** Shared with the SSH bootstrap. Leases live outside installs, which npm replaces atomically. */
export const deviceToolMaintenanceScript = String.raw`
const maintenanceFs = require('node:fs');
const maintenancePath = require('node:path');
const maintenanceAlive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
};
async function withToolMaintenance(root, operation) {
  maintenanceFs.mkdirSync(root, { recursive: true });
  const lock = maintenancePath.join(root, '.maintenance-lock');
  const token = process.pid + ':' + require('node:crypto').randomUUID();
  const readOwner = () => { try { return maintenanceFs.readFileSync(lock, 'utf8'); } catch { return null; } };
  const deadline = Date.now() + 30000;
  while (true) {
    const candidate = lock + '.' + token.replace(':', '.');
    try {
      maintenanceFs.writeFileSync(candidate, token);
      try { maintenanceFs.linkSync(candidate, lock); }
      finally { maintenanceFs.unlinkSync(candidate); }
      break;
    }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = readOwner();
      const pid = Number(previous?.split(':')[0]);
      if (Number.isSafeInteger(pid) && pid > 0 && !maintenanceAlive(pid) && readOwner() === previous) {
        try { maintenanceFs.unlinkSync(lock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        continue;
      }
      if (Date.now() >= deadline) throw Error('Device tool maintenance is locked. Retry when the other operation finishes.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try { return operation(); }
  finally { if (readOwner() === token) maintenanceFs.unlinkSync(lock); }
}
function claimTool(root, name, version, pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw Error("Missing device tool process identity.");
  return withToolMaintenance(root, () => {
    const users = maintenancePath.join(root, '.users', name + '@' + version);
    maintenanceFs.mkdirSync(users, { recursive: true });
    maintenanceFs.writeFileSync(maintenancePath.join(users, String(pid)), '');
  });
}
function pruneTools(root, specs, flat) {
  return withToolMaintenance(root, () => {
    // Also protect helpers launched by older T3 releases that predate usage records.
    const scan = process.platform === 'win32'
      ? require('node:child_process').spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine'], { encoding: 'utf8', timeout: 10000 })
      : require('node:child_process').spawnSync('ps', ['-ax', '-o', 'command='], { encoding: 'utf8', timeout: 10000 });
    if (scan.status !== 0 || !scan.stdout) return;
    for (const [name, required] of specs) {
      const parent = flat ? root : maintenancePath.join(root, name);
      let names;
      try { names = maintenanceFs.readdirSync(parent); } catch { continue; }
      const completed = [];
      for (const item of names) {
        const version = flat ? (item.startsWith(name + '@') ? item.slice(name.length + 1) : '') : item;
        if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) continue;
        const directory = maintenancePath.join(parent, item);
        try {
          if (!maintenanceFs.lstatSync(directory).isDirectory()) continue;
          if (maintenanceFs.readFileSync(maintenancePath.join(directory, '.install-complete'), 'utf8').trim() !== version) continue;
          completed.push({ version, directory, modified: maintenanceFs.statSync(maintenancePath.join(directory, '.install-complete')).mtimeMs });
        } catch {}
      }
      // Never prune until the required install has completed. Retain the last other successful install.
      if (!completed.some(value => value.version === required)) continue;
      const previous = completed.filter(value => value.version !== required).sort((a, b) => b.modified - a.modified || b.version.localeCompare(a.version, 'en', { numeric: true }))[0]?.version;
      for (const { version, directory } of completed) {
        const users = maintenancePath.join(root, '.users', name + '@' + version);
        // Older releases did not register users. Never guess whether one of those installs is still in use.
        if (!maintenanceFs.existsSync(users)) continue;
        const leases = maintenanceFs.readdirSync(users);
        for (const lease of leases) {
          if (/^[1-9][0-9]*$/.test(lease) && !maintenanceAlive(Number(lease))) maintenanceFs.rmSync(maintenancePath.join(users, lease), { force: true });
        }
        if (version === required || version === previous || scan.stdout.includes(directory + maintenancePath.sep)) continue;
        if (leases.some(value => !/^[1-9][0-9]*$/.test(value) || maintenanceAlive(Number(value)))) continue;
        maintenanceFs.rmSync(directory, { recursive: true, force: true });
        maintenanceFs.rmSync(users, { recursive: true, force: true });
      }
    }
  });
}
`;

class DeviceToolMaintenanceError extends Schema.TaggedError<DeviceToolMaintenanceError>()(
  "DeviceToolMaintenanceError",
  {},
) {
  override get message() {
    return "Device tool maintenance failed.";
  }
}

const runMaintenance = Effect.fn("DeviceToolchain.maintenance")(function* (
  nodePath: string,
  operation: string,
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const result = yield* runner.run({
    command: nodePath,
    args: [
      "-e",
      deviceToolMaintenanceScript +
        "\n" +
        operation +
        ".catch(error => { console.error(error.message); process.exitCode = 1; });",
    ],
  });
  if (result.code !== 0) return yield* Effect.fail(new DeviceToolMaintenanceError({}));
});

export const claimLocalDeviceTool = Effect.fn("DeviceToolchain.claim")(function* (
  baseDir: string,
  nodePath: string,
  tool: "hub" | "agent",
) {
  const path = yield* Path.Path;
  const [name, version] =
    tool === "hub"
      ? ["expo-device-hub", DEVICE_HUB_VERSION]
      : ["agent-device", AGENT_DEVICE_VERSION];
  yield* runMaintenance(
    nodePath,
    `claimTool(${JSON.stringify(path.join(baseDir, "tools"))}, ${JSON.stringify(name)}, ${JSON.stringify(version)}, ${process.pid})`,
  );
});

export const pruneLocalDeviceTools = Effect.fn("DeviceToolchain.prune")(function* (
  baseDir: string,
  nodePath: string,
  tool: "hub" | "agent",
) {
  const path = yield* Path.Path;
  yield* runMaintenance(
    nodePath,
    `pruneTools(${JSON.stringify(path.join(baseDir, "tools"))}, ${JSON.stringify(tool === "hub" ? [["expo-device-hub", DEVICE_HUB_VERSION]] : [["agent-device", AGENT_DEVICE_VERSION]])}, false)`,
  );
});
