// @effect-diagnostics nodeBuiltinImport:off - sync OS probe used outside Effect sample loops.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

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

const readPmsetBatt = (): string | null => {
  try {
    return NodeChildProcess.execFileSync("/usr/bin/pmset", ["-g", "batt"], {
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
    });
  } catch {
    return null;
  }
};

const readLinuxCapacity = (): string | null => {
  try {
    const root = "/sys/class/power_supply";
    for (const entry of NodeFS.readdirSync(root)) {
      if (!entry.toUpperCase().startsWith("BAT")) continue;
      return NodeFS.readFileSync(NodePath.join(root, entry, "capacity"), "utf8");
    }
  } catch {
    return null;
  }
  return null;
};

const readLinuxOnline = (): boolean | null => {
  try {
    const root = "/sys/class/power_supply";
    const onlineValues: string[] = [];
    for (const entry of NodeFS.readdirSync(root)) {
      const type = NodeFS.readFileSync(NodePath.join(root, entry, "type"), "utf8").trim();
      if (type !== "Mains") continue;
      onlineValues.push(NodeFS.readFileSync(NodePath.join(root, entry, "online"), "utf8").trim());
    }
    return parseLinuxMainsOnlineStates(onlineValues);
  } catch {
    return null;
  }
};

/** Best-effort host battery reading for the given OS. */
export const readHostBattery = (platform: NodeJS.Platform): HostBatterySnapshot => {
  if (platform === "darwin") {
    const output = readPmsetBatt();
    if (output === null) return { percent: null, onBattery: null };
    return { percent: parsePmsetBatt(output), onBattery: parsePmsetOnBattery(output) };
  }
  if (platform === "linux") {
    const output = readLinuxCapacity();
    return {
      percent: output === null ? null : parseLinuxBatteryCapacity(output),
      onBattery: readLinuxOnline(),
    };
  }
  return { percent: null, onBattery: null };
};

/** Best-effort host battery percent for the given OS; null when unavailable. */
export const readHostBatteryPercent = (platform: NodeJS.Platform): number | null =>
  readHostBattery(platform).percent;
