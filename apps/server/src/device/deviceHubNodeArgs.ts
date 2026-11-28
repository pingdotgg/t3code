// expo-device-hub detaches emulators without hiding their Windows console. Closing that
// console terminates the emulator; keep the workaround scoped to the hub process.
const WINDOWS_EMULATOR_PRELOAD = `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
const spawn = childProcess.spawn;
childProcess.spawn = function(command, ...args) {
  if (typeof command === "string" && basename(command).toLowerCase() === "emulator.exe") {
    const index = Array.isArray(args[0]) ? 1 : 0;
    args[index] = { ...args[index], detached: false, windowsHide: true };
  }
  return Reflect.apply(spawn, this, [command, ...args]);
};
syncBuiltinESMExports();
`;

export const deviceHubNodeArgs = (entryPath: string, platform: NodeJS.Platform): string[] =>
  platform === "win32"
    ? [
        "--import",
        `data:text/javascript,${encodeURIComponent(WINDOWS_EMULATOR_PRELOAD)}`,
        entryPath,
      ]
    : [entryPath];
