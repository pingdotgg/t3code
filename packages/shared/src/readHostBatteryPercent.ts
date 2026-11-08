// @effect-diagnostics nodeBuiltinImport:off - async OS probe used outside Effect sample loops.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  parseLinuxBatteryCapacity,
  parseLinuxMainsOnlineStates,
  parsePmsetBatt,
  parsePmsetOnBattery,
} from "./hostBattery.ts";

export type HostBatterySnapshot = {
  readonly percent: number | null;
  readonly onBattery: boolean | null;
};

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

const readPmsetBatt = async (): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync("/usr/bin/pmset", ["-g", "batt"], {
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
    });
    return stdout;
  } catch {
    return null;
  }
};

const readLinuxCapacity = async (): Promise<string | null> => {
  try {
    const root = "/sys/class/power_supply";
    for (const entry of await NodeFSP.readdir(root)) {
      if (!entry.toUpperCase().startsWith("BAT")) continue;
      return await NodeFSP.readFile(NodePath.join(root, entry, "capacity"), "utf8");
    }
  } catch {
    return null;
  }
  return null;
};

const readLinuxOnline = async (): Promise<boolean | null> => {
  try {
    const root = "/sys/class/power_supply";
    const onlineValues: string[] = [];
    for (const entry of await NodeFSP.readdir(root)) {
      const type = (await NodeFSP.readFile(NodePath.join(root, entry, "type"), "utf8")).trim();
      if (type !== "Mains") continue;
      onlineValues.push(
        (await NodeFSP.readFile(NodePath.join(root, entry, "online"), "utf8")).trim(),
      );
    }
    return parseLinuxMainsOnlineStates(onlineValues);
  } catch {
    return null;
  }
};

/** Best-effort host battery reading for the given OS. */
export const readHostBattery = async (platform: NodeJS.Platform): Promise<HostBatterySnapshot> => {
  if (platform === "darwin") {
    const output = await readPmsetBatt();
    if (output === null) return { percent: null, onBattery: null };
    return { percent: parsePmsetBatt(output), onBattery: parsePmsetOnBattery(output) };
  }
  if (platform === "linux") {
    const [output, onBattery] = await Promise.all([readLinuxCapacity(), readLinuxOnline()]);
    return {
      percent: output === null ? null : parseLinuxBatteryCapacity(output),
      onBattery,
    };
  }
  return { percent: null, onBattery: null };
};

/** Best-effort host battery percent for the given OS; null when unavailable. */
export const readHostBatteryPercent = async (platform: NodeJS.Platform): Promise<number | null> =>
  (await readHostBattery(platform)).percent;
