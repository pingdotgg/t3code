import { Directory, File, Paths } from "expo-file-system";
import { requireNativeModule } from "expo";
import type { ErrorUtils as ErrorUtilsInterface } from "react-native";

import { getBreadcrumbs } from "./breadcrumbs";
import { flushBreadcrumbsSync, installBreadcrumbPersistence } from "./breadcrumbPersist";
import {
  buildCrashRecord,
  buildMinimalCrashRecord,
  shouldPersistNonFatal,
  type CrashLogRecord,
} from "./crashLogRecord";

const CRASH_LOG_DIRECTORY = "crash-logs";
const LAST_CRASH_FILE = "last-crash.json";
const LAST_BREADCRUMBS_FILE = "last-breadcrumbs.json";
const MAX_PERSISTED_FATAL_LOGS = 20;
const MAX_PERSISTED_NONFATAL_LOGS = 10;
const REPORTED_ON_LAUNCH_COUNT = 5;

let crashSequence = 0;
let handlerInvocationCount = 0;
let installed = false;
let cachedNative: NativeCrashLogModule | null | undefined;

type NativeCrashLogModule = {
  installFatalHandler?: () => boolean;
  writeSyncText?: (relativePath: string, contents: string) => boolean;
};

export type { CrashLogRecord } from "./crashLogRecord";
export { buildCrashRecord, buildMinimalCrashRecord, shouldPersistNonFatal } from "./crashLogRecord";

export function installCrashLogger(): void {
  if (installed) {
    return;
  }
  installed = true;

  installBreadcrumbPersistence();
  // Re-assert native RCTFatal hooks after JS boot (covers expo-updates temp replace).
  tryNativeInstallFatalHandler();

  const errorUtils = (globalThis as { ErrorUtils?: ErrorUtilsInterface }).ErrorUtils;
  if (errorUtils !== undefined) {
    const previousHandler = errorUtils.getGlobalHandler();
    errorUtils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
      handlerInvocationCount += 1;
      const fatal = isFatal === true;
      const shouldPersist = fatal || shouldPersistNonFatal(error);
      if (shouldPersist) {
        // Write first, before any work that can throw (console, breadcrumbs, rich JSON).
        persistCrashRecordBestEffort(error, fatal, handlerInvocationCount);
      }
      try {
        emitConsoleMarker(error, fatal, handlerInvocationCount, shouldPersist);
      } catch {
        // Never let the logger mask the original error.
      }
      previousHandler(error, isFatal);
    });
  }

  installUnhandledRejectionHandler();

  // Deferred so install (which runs before the app module graph) does no
  // file IO on the startup path.
  setTimeout(() => {
    reportAndPrunePreviousCrashes();
  }, 0);
}

function emitConsoleMarker(
  error: unknown,
  isFatal: boolean,
  handlerInvocation: number,
  willPersist: boolean,
): void {
  const cause = error instanceof Error ? error : null;
  const marker = {
    breadcrumbs: getBreadcrumbs().slice(-12),
    handlerInvocation,
    isFatal,
    message: cause?.message ?? String(error),
    name: cause?.name ?? null,
    persist: willPersist,
    stack: cause?.stack?.split("\n").slice(0, 12) ?? null,
  };
  console.error("[crash-log] handler", JSON.stringify(marker));
}

/**
 * Minimal record first (message/stack only), then enrich with breadcrumbs.
 * Native RCTFatal hook is the backstop if this never runs.
 */
function persistCrashRecordBestEffort(
  error: unknown,
  isFatal: boolean,
  handlerInvocation: number,
): void {
  crashSequence += 1;
  const sequence = crashSequence;
  const prefix = isFatal ? "crash" : "error";
  const stampedName = `${prefix}-${Date.now()}-${sequence}.json`;

  // 1) Tiny payload that should succeed even under memory pressure.
  try {
    const minimal = buildMinimalCrashRecord(error, isFatal, handlerInvocation);
    const encoded = stableStringify(minimal);
    if (encoded !== null) {
      tryNativeSyncWrite(`${CRASH_LOG_DIRECTORY}/${LAST_CRASH_FILE}`, encoded);
      tryNativeSyncWrite(`${CRASH_LOG_DIRECTORY}/${stampedName}`, encoded);
    }
  } catch {
    // continue to richer attempt
  }

  // 2) Breadcrumbs + full record (best effort).
  try {
    flushBreadcrumbsSync();
    const full = buildCrashRecord(error, isFatal, handlerInvocation);
    const encoded = stableStringify(full);
    if (encoded === null) {
      return;
    }
    tryNativeSyncWrite(`${CRASH_LOG_DIRECTORY}/${LAST_CRASH_FILE}`, encoded);
    tryNativeSyncWrite(`${CRASH_LOG_DIRECTORY}/${stampedName}`, encoded);
    writeExpoFsRecord(stampedName, encoded);
  } catch {
    // Native write may still have succeeded.
  }
}

function writeExpoFsRecord(stampedName: string, encoded: string): void {
  try {
    const directory = new Directory(Paths.document, CRASH_LOG_DIRECTORY);
    directory.create({ idempotent: true, intermediates: true });
    const stamped = new File(directory, stampedName);
    stamped.create({ intermediates: true, overwrite: true });
    stamped.write(encoded);
    const last = new File(directory, LAST_CRASH_FILE);
    if (!last.exists) {
      last.create({ intermediates: true, overwrite: true });
    }
    last.write(encoded);
  } catch {
    // Native write may still have succeeded.
  }
}

function stableStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    try {
      const fallback: CrashLogRecord = {
        breadcrumbs: [],
        capturedAt: new Date().toISOString(),
        handlerInvocation: 0,
        isFatal: true,
        message: "crash-log-stringify-failed",
        name: "Error",
        source: "error-utils",
        stack: null,
      };
      return JSON.stringify(fallback);
    } catch {
      return null;
    }
  }
}

function getNativeModule(): NativeCrashLogModule | null {
  if (cachedNative !== undefined) {
    return cachedNative;
  }
  try {
    cachedNative = requireNativeModule("T3NativeControls") as NativeCrashLogModule;
    return cachedNative;
  } catch {
    cachedNative = null;
    return null;
  }
}

function tryNativeInstallFatalHandler(): void {
  try {
    const native = getNativeModule();
    if (typeof native?.installFatalHandler === "function") {
      native.installFatalHandler();
    }
  } catch {
    // Optional; AppDelegate installs the primary hook.
  }
}

function tryNativeSyncWrite(relativePath: string, contents: string): boolean {
  try {
    const native = getNativeModule();
    if (typeof native?.writeSyncText !== "function") {
      return false;
    }
    return native.writeSyncText(relativePath, contents) === true;
  } catch {
    return false;
  }
}

function installUnhandledRejectionHandler(): void {
  const target = globalThis as typeof globalThis & {
    onunhandledrejection?: ((event: { reason?: unknown }) => void) | null;
    addEventListener?: (type: string, listener: (event: { reason?: unknown }) => void) => void;
  };

  const onRejection = (reason: unknown): void => {
    handlerInvocationCount += 1;
    try {
      const error =
        reason instanceof Error
          ? reason
          : new Error(typeof reason === "string" ? reason : String(reason));
      persistCrashRecordBestEffort(error, false, handlerInvocationCount);
      emitConsoleMarker(error, false, handlerInvocationCount, true);
    } catch {
      // Ignore logger failures.
    }
  };

  if (typeof target.addEventListener === "function") {
    target.addEventListener("unhandledrejection", (event) => {
      onRejection(event.reason);
    });
    return;
  }

  const previous = target.onunhandledrejection;
  target.onunhandledrejection = (event) => {
    onRejection(event?.reason);
    if (typeof previous === "function") {
      previous.call(target, event);
    }
  };
}

function reportAndPrunePreviousCrashes(): void {
  try {
    try {
      const last = new File(new Directory(Paths.document, CRASH_LOG_DIRECTORY), LAST_CRASH_FILE);
      if (last.exists) {
        console.warn("[crash-log] last-crash.json:", last.textSync());
      }
    } catch {
      // continue
    }

    try {
      const crumbs = new File(
        new Directory(Paths.document, CRASH_LOG_DIRECTORY),
        LAST_BREADCRUMBS_FILE,
      );
      if (crumbs.exists) {
        console.warn("[crash-log] last-breadcrumbs.json:", crumbs.textSync());
      }
    } catch {
      // optional
    }

    const directory = new Directory(Paths.document, CRASH_LOG_DIRECTORY);
    if (!directory.exists) {
      return;
    }
    const files = directory
      .list()
      .filter(
        (entry): entry is File =>
          entry instanceof File &&
          (entry.name.startsWith("crash-") || entry.name.startsWith("error-")) &&
          entry.name.endsWith(".json"),
      )
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const file of files.slice(-REPORTED_ON_LAUNCH_COUNT)) {
      try {
        console.warn(`[crash-log] previous record (${file.name}):`, file.textSync());
      } catch {
        // Skip unreadable records.
      }
    }

    const fatals = files.filter((file) => file.name.startsWith("crash-"));
    const nonFatals = files.filter((file) => file.name.startsWith("error-"));
    pruneOldest(fatals, MAX_PERSISTED_FATAL_LOGS);
    pruneOldest(nonFatals, MAX_PERSISTED_NONFATAL_LOGS);
  } catch {
    // Reporting past crashes must never affect startup.
  }
}

function pruneOldest(files: ReadonlyArray<File>, keep: number): void {
  for (const file of files.slice(0, Math.max(0, files.length - keep))) {
    try {
      file.delete();
    } catch {
      // Leave undeletable records for the next prune.
    }
  }
}
