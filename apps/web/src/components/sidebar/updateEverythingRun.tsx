import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { APP_VERSION } from "~/branding";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useDesktopUpdateState } from "~/state/desktopUpdate";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  getUpdateEverythingToastView,
  type UpdateEverythingResult,
  type UpdateEverythingRun,
} from "./updateEverything.logic";

/** The running "update everything" pass, or null. Outlives the sidebar button. */
const updateEverythingRunAtom = Atom.make<UpdateEverythingRun | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("update-everything-run"),
);

export function useUpdateEverythingRun(): UpdateEverythingRun | null {
  return useAtomValue(updateEverythingRunAtom);
}

/** Starts, changes, or ends (null) the running pass. */
export function setUpdateEverythingRun(
  update: (run: UpdateEverythingRun | null) => UpdateEverythingRun | null,
): void {
  appAtomRegistry.update(updateEverythingRunAtom, update);
}

/** Records the result of every update for one machine in the running pass. */
export function settleUpdateRunMachine(environmentId: EnvironmentId, failed: boolean): void {
  setUpdateEverythingRun(
    (run) =>
      run && {
        ...run,
        machines: run.machines.map((machine) =>
          machine.environmentId === environmentId
            ? { ...machine, result: failed ? "failed" : "done" }
            : machine,
        ),
      },
  );
}

const SAVED_RESULT_KEY = "t3code:update-everything-result:v1";
// A result older than this belongs to an install that never relaunched the app.
const SAVED_RESULT_MAX_AGE_MS = 10 * 60 * 1000;

const SavedResult = Schema.Struct({
  savedAt: Schema.Number,
  localVersion: Schema.NullOr(Schema.String),
  updatedServers: Schema.Number,
  updatedProviders: Schema.Number,
  failures: Schema.Array(Schema.String),
});
const decodeSavedResult = Schema.decodeUnknownOption(Schema.fromJsonString(SavedResult));

/** Keeps a result through this app's relaunch. Call it right before the install. */
export function saveUpdateEverythingResult(result: UpdateEverythingResult): void {
  try {
    window.localStorage.setItem(
      SAVED_RESULT_KEY,
      JSON.stringify({ ...result, savedAt: Date.now() } satisfies typeof SavedResult.Type),
    );
  } catch {
    // Without storage the summary is lost with the relaunch; the update still runs.
  }
}

export function clearSavedUpdateEverythingResult(): void {
  try {
    window.localStorage.removeItem(SAVED_RESULT_KEY);
  } catch {
    // Nothing to clear.
  }
}

function takeSavedUpdateEverythingResult(): UpdateEverythingResult | null {
  try {
    const raw = window.localStorage.getItem(SAVED_RESULT_KEY);
    if (raw === null) return null;
    window.localStorage.removeItem(SAVED_RESULT_KEY);
    return Option.getOrNull(
      Option.filter(
        decodeSavedResult(raw),
        (saved) => Date.now() - saved.savedAt < SAVED_RESULT_MAX_AGE_MS,
      ),
    );
  } catch {
    return null;
  }
}

/** Shows the one summary toast for a finished pass. */
export function showUpdateEverythingResult(result: UpdateEverythingResult): void {
  const view = getUpdateEverythingToastView(result, APP_VERSION);
  if (!view) return;
  toastManager.add(
    stackedThreadToast({
      type: view.type,
      title: view.title,
      ...(view.description
        ? { description: <span className="whitespace-pre-line">{view.description}</span> }
        : {}),
    }),
  );
}

let notifiedNotAppliedVersion: string | null = null;

/**
 * Desktop launch notices for updates: the summary of a pass that ended with
 * this app's relaunch, and a warning when the last install did not apply.
 * Mount once at the app root.
 */
export function DesktopUpdateLaunchNotice() {
  const notAppliedVersion = useDesktopUpdateState()?.notAppliedVersion ?? null;

  useEffect(() => {
    const result = takeSavedUpdateEverythingResult();
    if (result) showUpdateEverythingResult(result);
  }, []);

  useEffect(() => {
    if (notAppliedVersion === null || notifiedNotAppliedVersion === notAppliedVersion) return;
    notifiedNotAppliedVersion = notAppliedVersion;
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Update did not apply",
        description: `T3 Code is still on ${APP_VERSION}. Install ${notAppliedVersion} again from the update button.`,
      }),
    );
  }, [notAppliedVersion]);

  return null;
}
