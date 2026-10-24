import Constants from "expo-constants";
import { Observe } from "expo-observe";

/**
 * Importing expo-observe installs its handler for unhandled JavaScript errors,
 * and its native side records crashes. Reports leave the device only through
 * the relay; builds without one (forks, local builds) keep dispatching off.
 */
const relayUrl: unknown = Constants.expoConfig?.extra?.relay?.url;
const appVariant: unknown = Constants.expoConfig?.extra?.appVariant;

/** Whether this build has anywhere to send crash reports. */
export const crashReportingAvailable = typeof relayUrl === "string" && relayUrl.trim() !== "";

let latestConfiguration = 0;

/**
 * While sending is off, each dispatch pass drops the reports it finds. One
 * recorded after the last pass would still go out once sending resumes, so a
 * pass runs before sending is turned back on.
 */
export async function setCrashReportsEnabled(enabled: boolean) {
  const configuration = ++latestConfiguration;
  const dispatchingEnabled = crashReportingAvailable && enabled;
  if (dispatchingEnabled) {
    await Observe.dispatchEvents();
    // A later call, such as an opt-out during the pass, has already applied.
    if (configuration !== latestConfiguration) return;
  }
  Observe.configure({
    dispatchingEnabled,
    ...(typeof appVariant === "string" ? { environment: appVariant } : {}),
  });
}

if (!crashReportingAvailable) {
  void setCrashReportsEnabled(false);
} else {
  // Observe keeps its last configuration across launches, so until the setting
  // loads the previous session's choice applies. Turning sending off in the
  // meantime would drop reports, including the last session's native crash.
  // Loaded after startup: the persistence runtime's module graph must not run
  // ahead of the imports `index.ts` orders first. A change made in Settings
  // while it loads is newer than what it read.
  const changedSinceLoad = () => latestConfiguration !== 0;
  void import("../../persistence/imperative")
    .then(({ loadPreferences }) => loadPreferences())
    .then(
      (preferences) =>
        changedSinceLoad()
          ? undefined
          : setCrashReportsEnabled(preferences.crashReportsEnabled !== false),
      (error: unknown) => {
        console.warn("[observe] could not read the crash report setting", error);
        // The choice is unknown, so this session does not send.
        return changedSinceLoad() ? undefined : setCrashReportsEnabled(false);
      },
    )
    .catch((error: unknown) => {
      console.warn("[observe] could not apply the crash report setting", error);
    });
}
