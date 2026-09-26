/**
 * The shape of an expo-updates log entry we care about. Mirrors
 * `UpdatesLogEntry` structurally so the model needs no native module at test
 * time.
 */
export interface UpdatesLogEntryLike {
  readonly timestamp: number;
  readonly message: string;
  readonly code: string;
  readonly level: string;
}

/** One fatal JavaScript error that took the app down at startup. */
export interface StartupCrashRecord {
  readonly timestamp: number;
  /** The `Description:` line, minus the "Unhandled JS Exception:" prefix. */
  readonly description: string;
  /** Component stack (`at Name (bundle:line:col)`), one frame per entry. */
  readonly frames: ReadonlyArray<string>;
  /** Everything after the message header, verbatim, for copying. */
  readonly detail: string;
}

const FATAL_PREFIX = "ErrorRecovery fatal exception: ";
const DESCRIPTION_PREFIX = "Description: ";
const UNHANDLED_PREFIX = "Unhandled JS Exception: ";

/**
 * Keep only the JS runtime fatals expo-updates' ErrorRecovery wrote while
 * aborting the process. Everything else in that log (update checks, asset
 * loads) is noise for a "why did the app crash" question.
 */
export function parseStartupCrashRecords(
  entries: ReadonlyArray<UpdatesLogEntryLike>,
): ReadonlyArray<StartupCrashRecord> {
  const records: StartupCrashRecord[] = [];
  for (const entry of entries) {
    if (entry.code !== "JSRuntimeError" || !entry.message.startsWith(FATAL_PREFIX)) continue;
    const body = entry.message.slice(FATAL_PREFIX.length);
    const lines = body.split("\n");
    const descriptionLine = lines.find((line) => line.startsWith(DESCRIPTION_PREFIX));
    if (descriptionLine === undefined) continue;
    let description = descriptionLine.slice(DESCRIPTION_PREFIX.length).trim();
    if (description.startsWith(UNHANDLED_PREFIX)) {
      description = description.slice(UNHANDLED_PREFIX.length);
    }
    const frames = lines
      .map((line) => line.trim())
      .filter((line) => line.startsWith("at "))
      .map(compactFrame);
    records.push({ timestamp: entry.timestamp, description, frames, detail: body.trim() });
  }
  // Newest first; the log appends in time order.
  return records.sort((left, right) => right.timestamp - left.timestamp);
}

/**
 * `at NewTaskFlowProvider (/Users/expo/…/main.jsbundle:590585:51)` reads as
 * `NewTaskFlowProvider (main.jsbundle:590585:51)`. The absolute build path is
 * the same on every frame and says nothing.
 */
function compactFrame(line: string): string {
  const match = /^at (.+?) \((.*)\)$/.exec(line);
  if (!match) return line.slice("at ".length);
  const [, name = "", location = ""] = match;
  const file = location.slice(location.lastIndexOf("/") + 1);
  return location === "<anonymous>" ? name : `${name} (${file})`;
}

/** The report a user pastes into an issue: every recorded crash, newest first. */
export function formatStartupCrashReport(
  records: ReadonlyArray<StartupCrashRecord>,
  app: { readonly version: string; readonly build: string },
): string {
  const header = `T3 Code ${app.version} (${app.build})`;
  if (records.length === 0) return `${header}\nNo startup crashes recorded.`;
  return [
    header,
    ...records.map(
      (record) => `\n--- ${new Date(record.timestamp).toISOString()} ---\n${record.detail}`,
    ),
  ].join("\n");
}
