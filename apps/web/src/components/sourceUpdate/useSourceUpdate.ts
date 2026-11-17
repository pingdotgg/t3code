import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  selectEnvironmentQueryData,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, ServerSourceUpdateError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { useNowAfter } from "~/hooks/useDeadline";
import { useLocalStorage, writeLocalStorageValue } from "~/hooks/useLocalStorage";
import { ensureLocalApi } from "~/localApi";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useServerConfigs } from "~/state/entities";
import { useEnvironmentQuerySelector } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  isSourceUpdateSettled,
  resolveSourceUpdatePhase,
  SOURCE_UPDATE_GIVE_UP_MS,
  type SourceUpdatePhase,
  supportsSourceUpdate,
} from "./sourceUpdate.logic";

const isSourceUpdateError = Schema.is(ServerSourceUpdateError);
const isFailure = (result: { readonly _tag: string }) => result._tag === "Failure";
const IDLE_PHASE: SourceUpdatePhase = { kind: "idle" };
const NO_RUN_ATOM = Atom.make(null).pipe(Atom.withLabel("web-source-update-run:none"));
const NO_CONFLICT_ATOM = Atom.make(null).pipe(
  Atom.withLabel("web-source-update-conflict-thread:none"),
);

const DismissedRunId = Schema.NullOr(Schema.String);
const dismissedRunKey = (environmentId: EnvironmentId) =>
  `t3code:source-update-dismissed:${environmentId}`;

/** Whether `environmentId` runs from source and this client may update it. */
export function useCanSourceUpdate(environmentId: EnvironmentId | null): boolean {
  const configs = useServerConfigs();
  const permitted = useAtomValue(serverEnvironment.runSourceUpdate.permissionAtom(environmentId));
  return environmentId !== null && permitted && supportsSourceUpdate(configs.get(environmentId));
}

/** Pass null when the environment cannot source-update; nothing is fetched then. */
export function useSourceUpdateState(environmentId: EnvironmentId | null) {
  const query =
    environmentId === null
      ? null
      : serverEnvironment.sourceUpdateStatus({ environmentId, input: {} });
  const status = useEnvironmentQuerySelector(query, selectEnvironmentQueryData);
  const failed = useEnvironmentQuerySelector(query, isFailure);
  const run = useAtomValue(
    environmentId === null ? NO_RUN_ATOM : serverEnvironment.sourceUpdateRunAtom(environmentId),
  );
  const conflictThreadId = useAtomValue(
    environmentId === null
      ? NO_CONFLICT_ATOM
      : serverEnvironment.sourceUpdateConflictThreadAtom(environmentId),
  );
  const [dismissedRunId] = useLocalStorage(
    environmentId === null ? "t3code:source-update-dismissed" : dismissedRunKey(environmentId),
    null,
    DismissedRunId,
  );
  const nowMs = useNowAfter(
    environmentId === null || run === null ? null : run.startedAtMs + SOURCE_UPDATE_GIVE_UP_MS,
  );
  return {
    status,
    failed,
    phase:
      environmentId === null
        ? IDLE_PHASE
        : resolveSourceUpdatePhase({ status, run, conflictThreadId, dismissedRunId, nowMs }),
  };
}

const toastFailure = (title: string, error: unknown) =>
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );

export function dismissSourceUpdateOutcome(environmentId: EnvironmentId, phase: SourceUpdatePhase) {
  if (!isSourceUpdateSettled(phase)) return;
  writeLocalStorageValue(dismissedRunKey(environmentId), phase.runId, null, DismissedRunId);
  appAtomRegistry.set(serverEnvironment.sourceUpdateRunAtom(environmentId), null);
}

export function useSourceUpdateActions() {
  const runUpdate = useAtomCommand(serverEnvironment.runSourceUpdate, { reportFailure: false });
  const cancelUpdate = useAtomCommand(serverEnvironment.cancelSourceUpdate, {
    reportFailure: false,
  });

  const update = async (environmentId: EnvironmentId, force = false): Promise<void> => {
    const result = await runUpdate({ environmentId, input: force ? { force: true } : {} });
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    if (!force && isSourceUpdateError(error) && error.reason === "turns-running") {
      const confirmed = await ensureLocalApi().dialogs.confirm(
        `${error.message}\n\nUpdate and restart anyway?`,
        { variant: "destructive" },
      );
      if (confirmed) await update(environmentId, true);
      return;
    }
    toastFailure("Could not update from source", error);
  };

  const cancel = async (environmentId: EnvironmentId): Promise<void> => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      "Cancel the update? The checkout keeps what was pulled, and the server keeps running its current build.",
      { variant: "destructive" },
    );
    if (!confirmed) return;
    const result = await cancelUpdate({ environmentId, input: {} });
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    toastFailure("Could not cancel the update", squashAtomCommandFailure(result));
  };

  return { update, cancel };
}
