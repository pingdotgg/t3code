#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off
import * as ChildProcess from "node:child_process";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(ChildProcess.execFile);
const deviceName = process.argv.includes("--device")
  ? process.argv[process.argv.indexOf("--device") + 1]
  : (process.env.T3_SIMULATOR_DEVICE ?? "iPhone 17 Pro");

if (process.platform !== "darwin") {
  console.error("iOS Simulator verification requires macOS.");
  process.exit(2);
}

const run = async (file: string, args: string[], maxBuffer = 4_000_000) =>
  (await execFile(file, args, { maxBuffer })).stdout;
const listed = JSON.parse(await run("xcrun", ["simctl", "list", "devices", "available", "-j"])) as {
  devices: Record<
    string,
    Array<{ udid: string; name: string; state: string; isAvailable: boolean }>
  >;
};
const device = Object.entries(listed.devices)
  .filter(([runtime]) => runtime.includes("iOS"))
  .flatMap(([, devices]) => devices)
  .find((candidate) => candidate.name === deviceName && candidate.isAvailable);
if (!device) throw new Error(`No available iOS simulator named '${deviceName}'.`);
if (device.state !== "Booted") {
  await run("xcrun", ["simctl", "boot", device.udid]);
  await run("xcrun", ["simctl", "bootstatus", device.udid, "-b"]);
}

const directory = await FSP.mkdtemp(Path.join(OS.tmpdir(), "t3-simulator-verify-"));
const screenshot = Path.join(directory, "screen.png");
const logs = Path.join(directory, "logs.txt");
await run("xcrun", ["simctl", "io", device.udid, "screenshot", screenshot]);
await FSP.writeFile(
  logs,
  (
    await run(
      "xcrun",
      ["simctl", "spawn", device.udid, "log", "show", "--last", "1s", "--style", "compact"],
      20_000_000,
    )
  ).slice(-200_000),
);
const metrics = await run("xcrun", [
  "simctl",
  "spawn",
  device.udid,
  "top",
  "-l",
  "1",
  "-stats",
  "pid,cpu,mem",
]).catch(() => "unavailable");
const [screenStat, logStat] = await Promise.all([FSP.stat(screenshot), FSP.stat(logs)]);
if (screenStat.size === 0 || logStat.size === 0) throw new Error("Simulator artifacts were empty.");
console.log(
  JSON.stringify(
    {
      device: { name: device.name, udid: device.udid },
      artifacts: { screenshot, logs },
      metrics: metrics.slice(0, 2_000),
    },
    null,
    2,
  ),
);
