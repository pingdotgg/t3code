import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { makeComponentLogger } from "./DesktopObservability.ts";

const { logWarning } = makeComponentLogger("desktop-realtime-limit");

/**
 * The hard RLIMIT_RTTIME from `/proc/self/limits`, in microseconds, or null
 * when unlimited. Undefined when the line is missing or unreadable.
 */
export function parseRealtimeTimeoutHardLimit(limits: string): number | null | undefined {
  const match = /^Max realtime timeout\s+(\S+)\s+(\S+)/m.exec(limits);
  if (match === null) return undefined;
  if (match[2] === "unlimited") return null;
  const hard = Number(match[2]);
  return Number.isSafeInteger(hard) ? hard : undefined;
}

// PipeWire without rtkit can set an inherited hard RTTIME limit of zero, causing SIGKILLs.
// DISABLE_RTKIT prevents that; a zero limit inherited from the launcher needs session repair.
export const protectRealtimeLimit = Effect.fn("desktop.realtimeLimit.protect")(function* () {
  // Written, not read: Electron and the backend inherit this process environment.
  // @effect-diagnostics-next-line processEnvInEffect:off
  process.env.DISABLE_RTKIT ??= "1";
  const fileSystem = yield* FileSystem.FileSystem;
  const limits = yield* fileSystem
    .readFileString("/proc/self/limits")
    .pipe(Effect.orElseSucceed(() => ""));
  if (parseRealtimeTimeoutHardLimit(limits) !== 0) return;
  yield* logWarning(
    "T3 Code started with a realtime CPU limit of 0, so the kernel kills its backend and agents when a thread CPU timer fires. Start T3 Code from its systemd unit or a terminal, or install and enable rtkit.",
  );
});
