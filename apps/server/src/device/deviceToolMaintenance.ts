// @effect-diagnostics preferSchemaOverJson:off - JSON string literals safely embed paths and arguments in generated JavaScript.
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as ProcessRunner from "../processRunner.ts";
import { AGENT_DEVICE_VERSION, DEVICE_HUB_VERSION } from "./DeviceToolchain.ts";

/** Shared with the SSH bootstrap. Cleanup runs only after successful startup. */
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
  const nonce = require('node:crypto').randomUUID();
  const ownerFile = process.pid + '.' + nonce + '.json';
  const candidate = lock + '.' + nonce;
  const holder = { pid: process.pid };
  const deadline = Date.now() + 30000;
  const removeEmptyLock = () => {
    try { maintenanceFs.rmdirSync(lock); }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EPERM'].includes(error.code)) throw error; }
  };
  maintenanceFs.mkdirSync(candidate);
  try {
    maintenanceFs.writeFileSync(maintenancePath.join(candidate, ownerFile), JSON.stringify(holder));
    while (true) {
      try {
        // Publish a populated directory atomically; rename cannot replace another populated lock.
        maintenanceFs.renameSync(candidate, lock);
        break;
      }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        let files = [];
        try { files = maintenanceFs.readdirSync(lock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (files.length === 1) {
          const previousFile = maintenancePath.join(lock, files[0]);
          let previous;
          try { previous = JSON.parse(maintenanceFs.readFileSync(previousFile, 'utf8')); } catch {}
          if (Number.isSafeInteger(previous?.pid) && previous.pid > 0 && !maintenanceAlive(previous.pid)) {
            // The unique filename belongs only to that owner. Never unlink a replacement owner's file.
            try { maintenanceFs.unlinkSync(previousFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
        }
        // A concurrent acquirer publishes its owner file with the directory, so this cannot remove it.
        removeEmptyLock();
        if (Date.now() >= deadline) throw Error('Device tool maintenance is locked. Retry when the other operation finishes.');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    try { return operation(); }
    finally {
      maintenanceFs.unlinkSync(maintenancePath.join(lock, ownerFile));
      removeEmptyLock();
    }
  } finally {
    maintenanceFs.rmSync(candidate, { recursive: true, force: true });
  }
}
function pruneTools(root, specs, flat) {
  return withToolMaintenance(root, () => {
    // Keep installs used by any running helper, including older T3 releases.
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
        if (version === required || version === previous || scan.stdout.includes(directory + maintenancePath.sep)) continue;
        maintenanceFs.rmSync(directory, { recursive: true, force: true });
      }
    }
  });
}
`;

class DeviceToolMaintenanceError extends Schema.TaggedError<DeviceToolMaintenanceError>()(
  "DeviceToolMaintenanceError",
  {
    operation: Schema.Literal("prune"),
    tool: Schema.Literals(["hub", "agent"]),
    exitCode: Schema.NullOr(Schema.Int),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Device tool ${this.operation} failed for ${this.tool} (exit code ${this.exitCode ?? "unknown"}).`;
  }
}

const runMaintenance = Effect.fn("DeviceToolchain.maintenance")(function* (
  nodePath: string,
  script: string,
  operation: "prune",
  tool: "hub" | "agent",
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const result = yield* runner.run({
    command: nodePath,
    args: [
      "-e",
      deviceToolMaintenanceScript +
        "\n" +
        script +
        ".catch(error => { console.error(error.message); process.exitCode = 1; });",
    ],
  });
  if (result.code !== 0)
    return yield* Effect.fail(
      new DeviceToolMaintenanceError({ operation, tool, exitCode: result.code, cause: result }),
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
    "prune",
    tool,
  );
});
