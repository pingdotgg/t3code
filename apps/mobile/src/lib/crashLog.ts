import { Directory, File, Paths } from "expo-file-system";
import type { ErrorUtils as ErrorUtilsInterface } from "react-native";

const CRASH_LOG_DIRECTORY = "crash-logs";
const MAX_PERSISTED_CRASH_LOGS = 20;
const REPORTED_ON_LAUNCH_COUNT = 3;

let crashSequence = 0;

export function installCrashLogger(): void {
  const errorUtils = (globalThis as { ErrorUtils?: ErrorUtilsInterface }).ErrorUtils;
  if (errorUtils === undefined) {
    return;
  }
  const previousHandler = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
    if (isFatal === true) {
      try {
        persistCrashRecord(error);
      } catch {
        // Never let the logger mask the original error.
      }
    }
    previousHandler(error, isFatal);
  });
  // Deferred so install (which runs before the app module graph) does no
  // file IO on the startup path.
  setTimeout(() => {
    reportAndPrunePreviousCrashes();
  }, 0);
}

function persistCrashRecord(error: unknown): void {
  const directory = new Directory(Paths.document, CRASH_LOG_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  const cause = error instanceof Error ? error : null;
  const record = {
    capturedAt: new Date().toISOString(),
    isFatal: true,
    message: cause?.message ?? String(error),
    name: cause?.name ?? null,
    stack: cause?.stack ?? null,
  };
  crashSequence += 1;
  const file = new File(directory, `crash-${Date.now()}-${crashSequence}.json`);
  file.create({ intermediates: true, overwrite: true });
  file.write(JSON.stringify(record, null, 2));
}

function reportAndPrunePreviousCrashes(): void {
  try {
    const directory = new Directory(Paths.document, CRASH_LOG_DIRECTORY);
    if (!directory.exists) {
      return;
    }
    const files = directory
      .list()
      .filter(
        (entry): entry is File =>
          entry instanceof File && entry.name.startsWith("crash-") && entry.name.endsWith(".json"),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const file of files.slice(-REPORTED_ON_LAUNCH_COUNT)) {
      try {
        console.warn(`[crash-log] previous fatal JS error (${file.name}):`, file.textSync());
      } catch {
        // Skip unreadable records.
      }
    }
    for (const file of files.slice(0, Math.max(0, files.length - MAX_PERSISTED_CRASH_LOGS))) {
      try {
        file.delete();
      } catch {
        // Leave undeletable records for the next prune.
      }
    }
  } catch {
    // Reporting past crashes must never affect startup.
  }
}
