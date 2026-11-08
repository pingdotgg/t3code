import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Haptics from "expo-haptics";

import * as Dialog from "../../components/ui/Dialog";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom } from "../../state/preferences";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { projectEnvironment } from "../../state/projects";
import { environmentServerConfigsAtom } from "../../state/server";
import { resolveNewThreadButtonScratchEnvironment } from "./new-thread-button-target";
import { showThreadActionNotice } from "./thread-action-notice";

/** Where New thread starts a No project thread under the "No project" setting, else null. */
export function readNewThreadButtonScratchEnvironment(
  preferredEnvironmentIds: ReadonlyArray<string | null | undefined>,
): EnvironmentId | null {
  const preferences = appAtomRegistry.get(mobilePreferencesAtom);
  return resolveNewThreadButtonScratchEnvironment({
    target: AsyncResult.isSuccess(preferences)
      ? preferences.value.newThreadButtonTarget
      : undefined,
    connectedEnvironmentIds: [...appAtomRegistry.get(connectedEnvironmentIdsAtom)],
    serverConfigs: appAtomRegistry.get(environmentServerConfigsAtom),
    preferredEnvironmentIds,
  });
}

const STARTING_NOTICE = {
  phase: "running",
  label: "Starting a thread without a project",
  description: null,
} as const;

/** A quick start never shows the toast, so it does not blink over the navigation. */
const NOTICE_DELAY_MS = 400;
/** After this the start counts as failed, so a call that never settles cannot block New thread. */
const START_TIMEOUT_MS = 15_000;
const FAILURE_TITLE = "Could not start without a project";
const FAILURE_MESSAGE = "The folder for threads without a project could not be created.";

/** The start being waited on, or null. Each start gets a fresh object, so a late result can tell. */
let activeStart: { showNotice: () => void } | null = null;

/**
 * Opens the environment's No project folder, then hands its project to `open` for a new draft.
 * The server may first have to create the folder, so a busy toast shows if that takes longer
 * than a moment; taps while it runs show that toast instead of starting a second thread. If the
 * server has not answered within 15 seconds the start is given up and the error dialog shows.
 */
export async function startNoProjectThread(
  environmentId: EnvironmentId,
  open: (project: EnvironmentProject) => void,
): Promise<void> {
  void Haptics.selectionAsync();
  if (activeStart !== null) {
    activeStart.showNotice();
    return;
  }
  let dismissNotice: (() => void) | null = null;
  const start = {
    showNotice: () => {
      dismissNotice ??= showThreadActionNotice(STARTING_NOTICE);
    },
  };
  activeStart = start;
  const noticeTimer = setTimeout(start.showNotice, NOTICE_DELAY_MS);
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    clearTimeout(noticeTimer);
    clearTimeout(timeoutTimer);
    if (activeStart === start) activeStart = null;
    dismissNotice?.();
    dismissNotice = null;
  };
  const timedOut = new Promise<"timeout">((resolve) => {
    timeoutTimer = setTimeout(() => resolve("timeout"), START_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([
      runAtomCommand(
        appAtomRegistry,
        projectEnvironment.openScratch,
        { environmentId, input: {} },
        { reportFailure: false },
      ),
      timedOut,
    ]);
    if (result === "timeout") {
      finish();
      Dialog.alert(FAILURE_TITLE, "The server did not answer in time. Try again.");
      return;
    }
    if (result._tag === "Success") {
      open(result.value);
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(FAILURE_TITLE, error instanceof Error ? error.message : FAILURE_MESSAGE);
    }
  } finally {
    finish();
  }
}
