/**
 * The panel's data + action layer.
 *
 * Liveness contract (there is no `subscribeWorkingCopy` — see
 * `build-log-f4-server.md` deviation 1):
 *
 *   1. every mutation refreshes the status atom via the command's `onSettled`,
 *   2. the existing per-thread `subscribeVcsStatus` push is watched, and any
 *      change to it triggers one re-read (this is what makes an agent's commit
 *      in a t3 terminal show up),
 *   3. a slow interval is the floor, and it runs ONLY while the panel is
 *      visible and idle. No timer survives the panel being hidden.
 *
 * fork: f4 source-control panel
 */
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  WORKING_COPY_POLL_INTERVAL_MS,
  nextStatusFailureStreak,
  shouldPollWorkingCopy,
  shouldShowStatusErrorBanner,
} from "@t3tools/client-runtime/state/working-copy-logic";
import {
  type EnvironmentId,
  type WorkingCopyOperation,
  type WorkingCopyStatusResult,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  EMPTY_DISCARD_RECOVERABILITY,
  commitToastText,
  confirmAbortOperation,
  confirmDiscardIrrecoverable,
  confirmStashDrop,
  discardRequiresConfirm,
  discardToastText,
  noteDiscardRecoverability,
  undoCommitToastText,
  type DiscardRecoverabilityState,
} from "~/lib/sourceControl/safetyLadder";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { workingCopyEnvironment } from "~/state/workingCopy";

import {
  actionBusyKey,
  BUSY_KEY_SEPARATOR,
  describeWorkingCopyError,
  isCwdDeniedError,
  STAGE_ALL_PATHS,
  withBusyKey,
} from "./sourceControlPanel.logic";
import type { ConfirmOutcome } from "./useSourceControlConfirm";

export interface SourceControlScope {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}

type ConfirmFn = (
  options: import("~/lib/sourceControl/safetyLadder").SourceControlConfirmOptions,
) => Promise<ConfirmOutcome>;

function failureMessage(result: { readonly cause: import("effect/Cause").Cause<unknown> }): string {
  return describeWorkingCopyError(squashAtomCommandFailure(result));
}

function errorToast(title: string, detail: string): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      // Full, untruncated stderr — the server keeps it on `detail` precisely so
      // this toast can show it.
      description: detail,
      timeout: 0,
    }),
  );
}

function undoToast(title: string, undoLabel: string, onUndo: () => void): void {
  toastManager.add(
    stackedThreadToast({
      type: "success",
      title,
      timeout: 10_000,
      actionProps: { children: undoLabel, onClick: onUndo },
    }),
  );
}

// ─── Status + liveness ──────────────────────────────────────────────────────

export interface WorkingCopyStatusView {
  readonly status: WorkingCopyStatusResult | null;
  readonly isPending: boolean;
  readonly showErrorBanner: boolean;
  readonly errorMessage: string | null;
  readonly dismissErrorBanner: () => void;
  readonly refresh: () => void;
}

export function useWorkingCopyStatus(
  scope: SourceControlScope | null,
  options: { readonly visible: boolean; readonly busy: boolean },
): WorkingCopyStatusView {
  const query = useEnvironmentQuery(
    scope === null
      ? null
      : workingCopyEnvironment.status({
          environmentId: scope.environmentId,
          input: { cwd: scope.cwd },
        }),
  );
  // The existing per-thread VCS status subscription is the push channel. Its
  // value changes whenever the server broadcasts a local update, which every
  // upstream vcs mutation and every `workingCopy.*` mutation already triggers.
  const vcsStatus = useAtomValue(
    scope === null
      ? EMPTY_VCS_STATUS_ATOM
      : vcsEnvironment.status({ environmentId: scope.environmentId, input: { cwd: scope.cwd } }),
  );

  const [failureStreak, setFailureStreak] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const { refresh } = query;

  useEffect(() => {
    if (query.isPending) return;
    setFailureStreak((current) => nextStatusFailureStreak(current, query.error !== null));
    if (query.error === null) setDismissed(false);
  }, [query.error, query.isPending]);

  // Re-read on every push. `vcsStatus` is a fresh object per event, so the
  // dependency fires exactly once per broadcast rather than continuously.
  const pushSeenRef = useRef<unknown>(null);
  useEffect(() => {
    if (scope === null) return;
    if (pushSeenRef.current === null) {
      pushSeenRef.current = vcsStatus;
      return;
    }
    if (pushSeenRef.current === vcsStatus) return;
    pushSeenRef.current = vcsStatus;
    refresh();
  }, [refresh, scope, vcsStatus]);

  useEffect(() => {
    if (
      !shouldPollWorkingCopy({
        visible: options.visible,
        hasCwd: scope !== null,
        busy: options.busy,
        // A non-repository cwd answers `isRepo: false`; polling it forever
        // would re-ask a question whose answer cannot change.
        isRepo: query.data?.isRepo ?? null,
      })
    ) {
      return;
    }
    const timer = window.setInterval(refresh, WORKING_COPY_POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [options.busy, options.visible, query.data?.isRepo, refresh, scope]);

  const dismissErrorBanner = useCallback(() => {
    setDismissed(true);
  }, []);

  return {
    status: query.data,
    isPending: query.isPending,
    showErrorBanner: shouldShowStatusErrorBanner({
      consecutiveFailures: failureStreak,
      dismissed,
    }),
    errorMessage: query.error,
    dismissErrorBanner,
    refresh,
  };
}

/**
 * A stable placeholder so the hook can be called unconditionally with no scope.
 * Deliberately a plain atom rather than a `vcsEnvironment.status` entry for a
 * sentinel cwd: that would open a real subscription against an environment that
 * does not exist.
 */
const EMPTY_VCS_STATUS_ATOM = Atom.make<unknown>(null).pipe(
  Atom.withLabel("web:source-control:no-vcs-status"),
);

// ─── Actions ────────────────────────────────────────────────────────────────

export interface WorkingCopyActions {
  readonly busy: ReadonlySet<string>;
  readonly isBusy: (key: string) => boolean;
  readonly stage: (paths: ReadonlyArray<string>) => Promise<void>;
  readonly unstage: (paths: ReadonlyArray<string>) => Promise<void>;
  readonly discard: (paths: ReadonlyArray<string> | null) => Promise<void>;
  readonly commit: (
    message: string,
    options?: { readonly stageAllFirst: boolean },
  ) => Promise<boolean>;
  readonly amend: (message: string) => Promise<boolean>;
  readonly undoLastCommit: () => Promise<void>;
  readonly resolveConflict: (path: string, side?: "ours" | "theirs") => Promise<void>;
  readonly abortOperation: (operation: WorkingCopyOperation) => Promise<void>;
  readonly stashPush: (message: string, includeUntracked: boolean) => Promise<void>;
  readonly stashApply: (ref: string) => Promise<void>;
  readonly stashPop: (ref: string) => Promise<void>;
  readonly stashDrop: (ref: string, label: string) => Promise<void>;
  readonly restoreBackup: (ref: string) => Promise<void>;
  readonly cherryPick: (hash: string) => Promise<void>;
  readonly revertCommit: (hash: string, mainline?: number) => Promise<void>;
  readonly checkoutCommit: (hash: string) => Promise<void>;
  readonly resetToCommit: (hash: string, mode: "soft" | "mixed" | "hard") => Promise<void>;
  readonly tagCommit: (hash: string, name: string) => Promise<void>;
  readonly applyPatch: (
    patch: string,
    flags: { cached?: boolean; reverse?: boolean },
  ) => Promise<boolean>;
}

export function useWorkingCopyActions(
  scope: SourceControlScope | null,
  confirmWith: ConfirmFn,
): WorkingCopyActions {
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [recoverability, setRecoverability] = useState<DiscardRecoverabilityState>(
    EMPTY_DISCARD_RECOVERABILITY,
  );

  const stagePaths = useAtomCommand(workingCopyEnvironment.stagePaths);
  const unstagePaths = useAtomCommand(workingCopyEnvironment.unstagePaths);
  const discardPaths = useAtomCommand(workingCopyEnvironment.discardPaths);
  const restoreDiscardBackup = useAtomCommand(workingCopyEnvironment.restoreDiscardBackup);
  const commitStaged = useAtomCommand(workingCopyEnvironment.commitStaged);
  const amendCommit = useAtomCommand(workingCopyEnvironment.amendCommit);
  const undoCommit = useAtomCommand(workingCopyEnvironment.undoLastCommit);
  const resolveConflictCommand = useAtomCommand(workingCopyEnvironment.resolveConflict);
  const abortOperationCommand = useAtomCommand(workingCopyEnvironment.abortOperation);
  const stashPushCommand = useAtomCommand(workingCopyEnvironment.stashPush);
  const stashApplyCommand = useAtomCommand(workingCopyEnvironment.stashApply);
  const stashPopCommand = useAtomCommand(workingCopyEnvironment.stashPop);
  const stashDropCommand = useAtomCommand(workingCopyEnvironment.stashDrop);
  const cherryPickCommand = useAtomCommand(workingCopyEnvironment.cherryPick);
  const revertCommand = useAtomCommand(workingCopyEnvironment.revertCommit);
  const checkoutCommand = useAtomCommand(workingCopyEnvironment.checkoutCommit);
  const resetCommand = useAtomCommand(workingCopyEnvironment.resetToCommit);
  const tagCommand = useAtomCommand(workingCopyEnvironment.tagCommit);
  const applyPatchCommand = useAtomCommand(workingCopyEnvironment.applyPatch);

  const busyRef = useRef(busy);
  busyRef.current = busy;

  /**
   * Re-entrant press on a key already in flight is a no-op. Doubling `discard`
   * would leave two backup stashes and two undo toasts pointing at different
   * states.
   */
  const run = useCallback(
    async <A>(
      key: string,
      title: string,
      execute: () => Promise<AtomCommandResult<A, unknown>>,
    ): Promise<A | null> => {
      if (busyRef.current.has(key)) return null;
      setBusy((current) => withBusyKey(current, key, true));
      try {
        const result = await execute();
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            errorToast(
              isCwdDeniedError(error) ? "This folder is outside your open projects" : title,
              failureMessage(result),
            );
          }
          return null;
        }
        return result.value;
      } finally {
        setBusy((current) => withBusyKey(current, key, false));
      }
    },
    [],
  );

  return useMemo<WorkingCopyActions>(() => {
    const noScope = async () => undefined;
    if (scope === null) {
      const never = async () => {
        await noScope();
      };
      const neverBool = async () => false;
      return {
        busy,
        isBusy: () => false,
        stage: never,
        unstage: never,
        discard: never,
        commit: neverBool,
        amend: neverBool,
        undoLastCommit: never,
        resolveConflict: never,
        abortOperation: never,
        stashPush: never,
        stashApply: never,
        stashPop: never,
        stashDrop: never,
        restoreBackup: never,
        cherryPick: never,
        revertCommit: never,
        checkoutCommit: never,
        resetToCommit: never,
        tagCommit: never,
        applyPatch: neverBool,
      };
    }

    const { environmentId, cwd } = scope;
    const target = <I>(input: I) => ({ environmentId, input: { cwd, ...input } });

    const doUndoLastCommit = async (): Promise<boolean> => {
      const result = await run(actionBusyKey("undo-commit"), "Could not undo the commit", () =>
        undoCommit(target({})),
      );
      return result !== null;
    };

    return {
      busy,
      isBusy: (key) => busy.has(key),

      stage: async (paths) => {
        if (paths.length === 0) return;
        await run(actionBusyKey("stage", paths.join(BUSY_KEY_SEPARATOR)), "Could not stage", () =>
          stagePaths(target({ paths })),
        );
      },

      unstage: async (paths) => {
        if (paths.length === 0) return;
        await run(
          actionBusyKey("unstage", paths.join(BUSY_KEY_SEPARATOR)),
          "Could not unstage",
          () => unstagePaths(target({ paths })),
        );
      },

      /**
       * `null` means "everything" (the discard-all rung); the wire spells that
       * as an empty `paths` array.
       *
       * Discard normally does NOT ask - it takes a pathspec-stash backup and
       * offers an undo toast. It asks first when this repo has already answered
       * `recoverable: false` (permanent for the session), OR when the server's
       * preflight says it cannot back this discard up: that answer arrives as
       * `requiresConfirmation` with NOTHING destroyed, so the confirm-first
       * rung fires on the very first discard rather than after one is lost.
       */
      discard: async (paths) => {
        const key = actionBusyKey("discard", paths === null ? "*" : paths.join(BUSY_KEY_SEPARATOR));
        const attempt = (confirmedDestructive: boolean) =>
          run(key, "Could not discard changes", () =>
            discardPaths(
              target(
                confirmedDestructive
                  ? { paths: paths ?? [], confirmedDestructive: true }
                  : { paths: paths ?? [] },
              ),
            ),
          );

        const preConfirmed = discardRequiresConfirm(recoverability, cwd);
        if (preConfirmed) {
          const outcome = await confirmWith(confirmDiscardIrrecoverable(paths));
          if (outcome !== "confirmed") return;
        }

        let result = await attempt(preConfirmed);
        if (result === null) return;

        if (result.requiresConfirmation === true) {
          setRecoverability((current) => noteDiscardRecoverability(current, cwd, false));
          const outcome = await confirmWith(confirmDiscardIrrecoverable(paths));
          if (outcome !== "confirmed") return;
          const retried = await attempt(true);
          if (retried === null) return;
          result = retried;
        }

        setRecoverability((current) => noteDiscardRecoverability(current, cwd, result.recoverable));
        if (!result.recoverable) {
          toastManager.add(stackedThreadToast({ type: "success", title: discardToastText(paths) }));
          return;
        }
        const backupRef = result.backupRef;
        if (backupRef === undefined) {
          // `stash push` exited 0 with nothing to save: the rows were already
          // clean. Saying "Discarded" here would be a lying state.
          toastManager.add(stackedThreadToast({ type: "success", title: "Nothing to discard" }));
          return;
        }
        undoToast(discardToastText(paths), "Undo", () => {
          void run(actionBusyKey("restore-backup", backupRef), "Could not restore the backup", () =>
            restoreDiscardBackup(target({ ref: backupRef })),
          );
        });
      },

      /**
       * Commit path, mirroring 2code's: when nothing is staged the client
       * stages everything FIRST and aborts the commit if that staging fails.
       * The server never runs `add` of its own — that is the §5.0.2 blocker.
       */
      commit: async (message, options) => {
        if (options?.stageAllFirst) {
          const staged = await run(actionBusyKey("stage", "*"), "Could not stage changes", () =>
            // `STAGE_ALL_PATHS` is the wire spelling of "everything";
            // the server runs one pathless `add -A` for it.
            stagePaths(target({ paths: STAGE_ALL_PATHS })),
          );
          if (staged === null) return false;
        }
        const result = await run(actionBusyKey("commit"), "Could not commit", () =>
          commitStaged(target({ message })),
        );
        if (result === null) return false;
        undoToast(commitToastText(result.shortHash, result.filesChanged), "Undo", () => {
          void doUndoLastCommit();
        });
        return true;
      },

      amend: async (message) => {
        const result = await run(actionBusyKey("commit"), "Could not amend", () =>
          amendCommit(target(message.trim().length > 0 ? { message } : {})),
        );
        return result !== null;
      },

      undoLastCommit: async () => {
        // `run` already toasts the failure; adding an unconditional success
        // toast on top of it showed both at once for the same action.
        const undone = await doUndoLastCommit();
        if (!undone) return;
        toastManager.add(stackedThreadToast({ type: "success", title: undoCommitToastText() }));
      },

      resolveConflict: async (path, side) => {
        await run(actionBusyKey("resolve", path), "Could not resolve the conflict", () =>
          resolveConflictCommand(target(side === undefined ? { path } : { path, side })),
        );
      },

      abortOperation: async (operation) => {
        const outcome = await confirmWith(confirmAbortOperation(operation));
        if (outcome !== "confirmed") return;
        await run(actionBusyKey("abort"), `Could not abort the ${operation}`, () =>
          abortOperationCommand(target({ operation })),
        );
      },

      stashPush: async (message, includeUntracked) => {
        await run(actionBusyKey("stash-push"), "Could not stash", () =>
          stashPushCommand(
            target(
              message.trim().length > 0 ? { message, includeUntracked } : { includeUntracked },
            ),
          ),
        );
      },

      stashApply: async (ref) => {
        await run(actionBusyKey("stash-apply", ref), "Could not apply the stash", () =>
          stashApplyCommand(target({ ref })),
        );
      },

      stashPop: async (ref) => {
        await run(actionBusyKey("stash-pop", ref), "Could not pop the stash", () =>
          stashPopCommand(target({ ref })),
        );
      },

      /** The one stash action with no undo — hence the only stash confirm. */
      stashDrop: async (ref, label) => {
        const outcome = await confirmWith(confirmStashDrop({ ref, message: label }));
        if (outcome !== "confirmed") return;
        await run(actionBusyKey("stash-drop", ref), "Could not drop the stash", () =>
          stashDropCommand(target({ ref })),
        );
      },

      restoreBackup: async (ref) => {
        await run(actionBusyKey("restore-backup", ref), "Could not restore the backup", () =>
          restoreDiscardBackup(target({ ref })),
        );
      },

      cherryPick: async (hash) => {
        const result = await run(actionBusyKey("cherry-pick", hash), "Could not cherry-pick", () =>
          cherryPickCommand(target({ hash })),
        );
        if (result === null) return;
        undoToast(commitToastText(result.shortHash, result.filesChanged), "Undo", () => {
          void doUndoLastCommit();
        });
      },

      revertCommit: async (hash, mainline) => {
        const result = await run(actionBusyKey("revert", hash), "Could not revert", () =>
          revertCommand(target(mainline === undefined ? { hash } : { hash, mainline })),
        );
        if (result === null) return;
        undoToast(commitToastText(result.shortHash, result.filesChanged), "Undo", () => {
          void doUndoLastCommit();
        });
      },

      checkoutCommit: async (hash) => {
        await run(actionBusyKey("checkout", hash), "Could not check out that commit", () =>
          checkoutCommand(target({ hash })),
        );
      },

      resetToCommit: async (hash, mode) => {
        await run(actionBusyKey("reset", hash), "Could not reset", () =>
          resetCommand(target({ hash, mode })),
        );
      },

      tagCommit: async (hash, name) => {
        await run(actionBusyKey("tag", hash), "Could not create the tag", () =>
          tagCommand(target({ hash, name })),
        );
      },

      applyPatch: async (patch, flags) => {
        const result = await run(actionBusyKey("apply-patch"), "Could not apply the patch", () =>
          applyPatchCommand(target({ patch, ...flags })),
        );
        return result !== null;
      },
    };
  }, [
    abortOperationCommand,
    amendCommit,
    applyPatchCommand,
    busy,
    checkoutCommand,
    cherryPickCommand,
    commitStaged,
    confirmWith,
    discardPaths,
    recoverability,
    resetCommand,
    resolveConflictCommand,
    restoreDiscardBackup,
    revertCommand,
    run,
    scope,
    stagePaths,
    stashApplyCommand,
    stashDropCommand,
    stashPopCommand,
    stashPushCommand,
    tagCommand,
    undoCommit,
    unstagePaths,
  ]);
}
