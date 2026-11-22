import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell, ThreadStructure } from "@t3tools/client-runtime/state/models";
import {
  canPersistThreadRuntimeModeImmediately,
  isRuntimeModeSelectionBusyError,
} from "@t3tools/client-runtime/state/thread-workflows";
import { AuthOrchestrationOperateScope, type RuntimeMode } from "@t3tools/contracts";
import { msg } from "gt-react-native";

import * as Dialog from "../components/ui/Dialog";
import { m } from "../i18n/messages";
import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import { readEnvironmentScope } from "./session";
import { threadEnvironment } from "./threads";
import {
  getComposerDraftSnapshot,
  releaseComposerDraftRuntimeMode,
  updateComposerDraftSettings,
} from "./use-composer-drafts";

const runtimeModeSelectionSeq = new Map<string, number>();
const inFlightRuntimeMode = new Map<string, RuntimeMode>();

export interface SelectThreadRuntimeModeInput {
  readonly thread: Pick<
    EnvironmentThreadShell,
    | "environmentId"
    | "id"
    | "runtimeMode"
    | "runtime"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingBackgroundTasks"
  >;
  readonly projection: ThreadStructure | null | undefined;
  /** True until a newly created thread has been acknowledged by the server. */
  readonly isPendingCreation?: boolean;
  readonly runtimeMode: RuntimeMode;
}

/** Sets an existing thread's permission mode on the thread when safe without ending an active run. */
export function selectThreadRuntimeMode(input: SelectThreadRuntimeModeInput): void {
  const { thread, projection, isPendingCreation, runtimeMode } = input;
  const threadKey = scopedThreadKey(thread.environmentId, thread.id);
  const durableRuntimeMode =
    appAtomRegistry
      .get(threadEnvironment.durableSnapshotAtom(thread.environmentId))
      ?.threads.find((candidate) => candidate.id === thread.id)?.runtimeMode ?? thread.runtimeMode;
  const currentDraftMode = getComposerDraftSnapshot(threadKey).runtimeMode;
  const activeWriteMode = inFlightRuntimeMode.get(threadKey);

  // Tapping the already-active durable mode with no different write in flight is a no-op;
  // avoid detaching a warm idle session with a redundant command.
  if (
    runtimeMode === durableRuntimeMode &&
    (activeWriteMode === undefined || activeWriteMode === runtimeMode)
  ) {
    if (currentDraftMode !== undefined) {
      updateComposerDraftSettings(threadKey, { runtimeMode: undefined });
    }
    return;
  }

  const seq = (runtimeModeSelectionSeq.get(threadKey) ?? 0) + 1;
  runtimeModeSelectionSeq.set(threadKey, seq);

  const canPersistImmediately =
    isPendingCreation !== true &&
    readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope) &&
    canPersistThreadRuntimeModeImmediately({ thread, projection });

  if (!canPersistImmediately) {
    // A saved-mode pick only gets here while another mode is saving; keep it so the next send restores it.
    updateComposerDraftSettings(threadKey, { runtimeMode });
    return;
  }

  updateComposerDraftSettings(threadKey, { runtimeMode });
  inFlightRuntimeMode.set(threadKey, runtimeMode);
  void runAtomCommand(
    appAtomRegistry,
    threadEnvironment.setRuntimeMode,
    {
      environmentId: thread.environmentId,
      input: {
        threadId: thread.id,
        runtimeMode,
        createdAt: new Date().toISOString(),
        preserveActiveSession: true,
      },
    },
    { label: "change permission mode", reportFailure: false, reportDefect: true },
  ).then((result) => {
    if (runtimeModeSelectionSeq.get(threadKey) !== seq) {
      return;
    }
    inFlightRuntimeMode.delete(threadKey);
    if (result._tag === "Success") {
      releaseComposerDraftRuntimeMode(threadKey, runtimeMode);
      return;
    }
    if (isAtomCommandInterrupted(result)) {
      return;
    }
    const error = squashAtomCommandFailure(result);
    // Another client may have started a turn first; keep the pick in draft for the next send.
    if (isRuntimeModeSelectionBusyError(error)) {
      return;
    }
    releaseComposerDraftRuntimeMode(threadKey, runtimeMode);
    Dialog.alert(
      m(msg("Could not apply permission mode")),
      m(
        msg("This permission mode was not saved. {detail}", {
          detail: errorDisplayMessage(error, m) ?? m(msg("Try again.")),
        }),
      ),
    );
  });
}
