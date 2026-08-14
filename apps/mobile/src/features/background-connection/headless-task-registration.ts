import { AppRegistry } from "react-native";

export const BACKGROUND_CONNECTION_HEADLESS_TASK = "T3BackgroundConnection";

let registered = false;

interface BackgroundConnectionTaskModule {
  readonly runBackgroundConnectionHeadlessTask: () => Promise<void>;
}

type BackgroundConnectionTaskLoader = () => Promise<BackgroundConnectionTaskModule>;

const loadBackgroundConnectionTask: BackgroundConnectionTaskLoader = () =>
  import("./background-task");

/**
 * React Native does not finish an unlimited Headless JS task when its provider
 * rejects with a generic error. Convert import/bootstrap defects into normal
 * completion so native can release its wake lock and apply bounded recovery.
 */
export async function runRegisteredBackgroundConnectionTask(
  loadTask: BackgroundConnectionTaskLoader = loadBackgroundConnectionTask,
): Promise<void> {
  try {
    const { runBackgroundConnectionHeadlessTask } = await loadTask();
    await runBackgroundConnectionHeadlessTask();
  } catch (error) {
    console.error("[background-connection] registered headless task failed", error);
  }
}

/** Must run before Expo registers the Activity's root component. */
export function registerBackgroundConnectionHeadlessTask(): void {
  if (registered) {
    return;
  }
  registered = true;
  AppRegistry.registerHeadlessTask(
    BACKGROUND_CONNECTION_HEADLESS_TASK,
    () => () => runRegisteredBackgroundConnectionTask(),
  );
}
