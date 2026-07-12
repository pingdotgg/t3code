import { Directory, File, Paths } from "expo-file-system";
import { requireNativeModule } from "expo";

import { getBreadcrumbs, setBreadcrumbPersistHook } from "./breadcrumbs";

const CRASH_LOG_DIRECTORY = "crash-logs";
const LAST_BREADCRUMBS_FILE = "last-breadcrumbs.json";
/** Quiet period before a trailing flush. */
const FLUSH_DEBOUNCE_MS = 400;
/** While activity continues, still flush at least this often. */
const FLUSH_MAX_WAIT_MS = 400;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
let installed = false;

export function installBreadcrumbPersistence(): void {
  if (installed) {
    return;
  }
  installed = true;
  setBreadcrumbPersistHook(() => {
    scheduleBreadcrumbFlush();
  });
}

/** Immediate flush for fatal paths; ignore errors. */
export function flushBreadcrumbsSync(): void {
  clearFlushTimers();
  writeBreadcrumbsToDisk();
}

function clearFlushTimers(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (maxWaitTimer !== null) {
    clearTimeout(maxWaitTimer);
    maxWaitTimer = null;
  }
}

function scheduleBreadcrumbFlush(): void {
  // Trailing debounce: reset on each breadcrumb.
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    // Quiet period elapsed; drop max-wait so the next burst starts a new cap.
    if (maxWaitTimer !== null) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }
    writeBreadcrumbsToDisk();
  }, FLUSH_DEBOUNCE_MS);

  // Max-wait: do not reset while activity continues, so continuous bursts still
  // flush about every FLUSH_MAX_WAIT_MS (needed when a native kill skips sync flush).
  if (maxWaitTimer === null) {
    maxWaitTimer = setTimeout(() => {
      maxWaitTimer = null;
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      writeBreadcrumbsToDisk();
    }, FLUSH_MAX_WAIT_MS);
  }
}

function writeBreadcrumbsToDisk(): void {
  const payload = JSON.stringify({
    breadcrumbs: getBreadcrumbs(),
    updatedAt: new Date().toISOString(),
  });
  const relativePath = `${CRASH_LOG_DIRECTORY}/${LAST_BREADCRUMBS_FILE}`;

  try {
    const native = requireNativeModule("T3NativeControls") as {
      writeSyncText?: (relativePath: string, contents: string) => boolean;
    };
    if (typeof native.writeSyncText === "function") {
      native.writeSyncText(relativePath, payload);
    }
  } catch {
    // fall through to Expo FS
  }

  try {
    const directory = new Directory(Paths.document, CRASH_LOG_DIRECTORY);
    directory.create({ idempotent: true, intermediates: true });
    const file = new File(directory, LAST_BREADCRUMBS_FILE);
    if (!file.exists) {
      file.create({ intermediates: true, overwrite: true });
    }
    file.write(payload);
  } catch {
    // Best-effort only.
  }
}
