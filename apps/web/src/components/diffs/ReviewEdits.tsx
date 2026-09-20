import { useBlocker } from "@tanstack/react-router";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ProjectId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { randomUUID } from "~/lib/utils";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsActionManager, vcsEnvironment } from "~/state/vcs";
import { gitEnvironment } from "~/state/git";
import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { getProjectFileQueryAtom } from "../files/projectFilesQueryState";
import { registerRightPanelLeaveGuard } from "~/rightPanelStore";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

export interface ReviewEditTarget {
  environmentId: EnvironmentId;
  cwd: string;
  filePath: string;
  expectedBranch: string | null;
  pullRequestUrl?: string;
  projectId?: ProjectId | undefined;
  onSaved?: () => void;
  readOnly?: boolean;
}

interface ReviewDraft extends ReviewEditTarget {
  contents: string;
  savedContents: string;
  workspace?: { cwd: string; branch: string };
  pendingPush?: boolean;
}

export function reviewEditKey(target: ReviewEditTarget): string {
  return JSON.stringify([
    target.environmentId,
    target.cwd,
    target.filePath,
    target.pullRequestUrl ?? target.expectedBranch,
  ]);
}

export async function readReviewDraft(
  target: ReviewEditTarget,
  pullRequestContents?: string,
): Promise<ReviewDraft> {
  if (target.pullRequestUrl) {
    if (pullRequestContents === undefined)
      throw new Error("The PR file contents are not available.");
    return { ...target, contents: pullRequestContents, savedContents: pullRequestContents };
  }
  const refreshed = await vcsEnvironment.refreshStatus.run(appAtomRegistry, {
    environmentId: target.environmentId,
    input: { cwd: target.cwd },
  });
  if (refreshed._tag === "Failure") throw new Error(formatEnvironmentQueryError(refreshed.cause));
  const status = refreshed.value;
  if (status.refName !== target.expectedBranch) {
    throw new Error("The checkout changed. Wait for the diff to update, then try again.");
  }
  const result = await executeAtomQuery(
    appAtomRegistry,
    getProjectFileQueryAtom(target.environmentId, target.cwd, target.filePath),
    { refresh: true, reportFailure: false },
  );
  if (result._tag === "Failure") throw new Error(formatEnvironmentQueryError(result.cause));
  if (result.value.truncated) throw new Error("This file is too large to edit here.");
  return {
    ...target,
    contents: result.value.contents,
    savedContents: result.value.contents,
  };
}

const savedReviewsKey = "t3code.saved-review-edits";
const SavedReview = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: Schema.optional(ProjectId),
  cwd: Schema.String,
  filePath: Schema.String,
  expectedBranch: Schema.NullOr(Schema.String),
  pullRequestUrl: Schema.String,
  savedContents: Schema.String,
  workspace: Schema.Struct({ cwd: Schema.String, branch: Schema.String }),
});
const SavedReviews = Schema.Array(SavedReview);

function readSavedReviews(): ReadonlyMap<string, ReviewDraft> {
  try {
    return new Map(
      (getLocalStorageItem(savedReviewsKey, SavedReviews) ?? []).map((draft) => [
        reviewEditKey(draft),
        { ...draft, contents: draft.savedContents, pendingPush: true },
      ]),
    );
  } catch {
    return new Map();
  }
}

function persistSavedReviews(drafts: ReadonlyMap<string, ReviewDraft>) {
  try {
    setLocalStorageItem(
      savedReviewsKey,
      [...drafts.values()].flatMap((draft) =>
        draft.pendingPush && draft.workspace && draft.pullRequestUrl
          ? [{ ...draft, workspace: draft.workspace, pullRequestUrl: draft.pullRequestUrl }]
          : [],
      ),
      SavedReviews,
    );
    return true;
  } catch {
    toastManager.add({
      type: "info",
      title: "Browser storage is unavailable",
      description: "Your files are saved on disk. Push any pending edits before closing this tab.",
    });
    return false;
  }
}

export function reviewPublishKey(environmentId: EnvironmentId, url: string) {
  return JSON.stringify([environmentId, url]);
}

const ReviewEditsContext = createContext<{
  drafts: ReadonlyMap<string, ReviewDraft>;
  begin: (draft: ReviewDraft) => ReviewDraft;
  change: (key: string, contents: string) => void;
  focus: (key: string | null) => void;
  requestLeave: (action: () => void) => void;
  blockLeave: (action?: () => void) => boolean;
  saving: boolean;
  savingKeys: ReadonlySet<string>;
  publishing: ReadonlyMap<string, string>;
  setPullRequestReadOnly: (
    environmentId: EnvironmentId,
    url: string,
    reason: string | null,
  ) => void;
  publish: (environmentId: EnvironmentId, cwd: string, url: string) => Promise<boolean>;
} | null>(null);

export const useReviewEdits = () => useContext(ReviewEditsContext);

export function useReviewPanelLeaveGuard(ref: ScopedThreadRef | null) {
  const blockLeave = useReviewEdits()?.blockLeave;
  useEffect(
    () => (ref && blockLeave ? registerRightPanelLeaveGuard(ref, blockLeave) : undefined),
    [ref, blockLeave],
  );
}

export function ReviewEditsProvider({ children }: { children: ReactNode }) {
  const [drafts, setDrafts] = useState<ReadonlyMap<string, ReviewDraft>>(readSavedReviews);
  const [savedReviewsPersisted, setSavedReviewsPersisted] = useState(true);
  const draftsRef = useRef(drafts);
  const focusedKey = useRef<string | null>(null);
  const [publishing, setPublishing] = useState<ReadonlyMap<string, string>>(new Map());
  const publishingRef = useRef(new Set<string>());
  const [readOnlyReasons, setReadOnlyReasons] = useState<ReadonlyMap<string, string>>(new Map());
  const readOnlyPullRequests = useRef(readOnlyReasons);
  const setPullRequestReadOnly = useCallback(
    (environmentId: EnvironmentId, url: string, reason: string | null) => {
      const key = reviewPublishKey(environmentId, url);
      if ((readOnlyPullRequests.current.get(key) ?? null) === reason) return;
      const next = new Map(readOnlyPullRequests.current);
      if (reason) next.set(key, reason);
      else next.delete(key);
      readOnlyPullRequests.current = next;
      setReadOnlyReasons(next);
    },
    [],
  );
  const checkWritable = useCallback((draft: ReviewEditTarget) => {
    const reason =
      draft.pullRequestUrl &&
      readOnlyPullRequests.current.get(reviewPublishKey(draft.environmentId, draft.pullRequestUrl));
    if (reason) throw new Error(reason + " Your edits are still here.");
  }, []);
  const [savingKeys, setSavingKeys] = useState<ReadonlySet<string>>(new Set());
  const saving = savingKeys.size > 0;
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const dirty = [...drafts.values()].some((draft) => draft.contents !== draft.savedContents);
  const blockedSaveReason = [...drafts.values()].flatMap((draft) => {
    const reason =
      draft.pullRequestUrl && draft.contents !== draft.savedContents
        ? readOnlyReasons.get(reviewPublishKey(draft.environmentId, draft.pullRequestUrl))
        : undefined;
    return reason ? [reason] : [];
  })[0];
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => {
      if (current.routeId === "/_chat/pull-requests" && next.routeId === current.routeId) {
        if (
          current.search.repository === next.search.repository &&
          current.search.number === next.search.number &&
          (current.search.selectedProjectId ?? current.search.projectId) ===
            (next.search.selectedProjectId ?? next.search.projectId) &&
          (current.search.selectedEnvironmentId ?? current.search.environmentId) ===
            (next.search.selectedEnvironmentId ?? next.search.environmentId) &&
          (current.search.selectedHost ?? current.search.host) ===
            (next.search.selectedHost ?? next.search.host)
        )
          return false;
      }
      const shouldBlock = dirty || saving || publishing.size > 0;
      if (shouldBlock) setError(null);
      return shouldBlock;
    },
    enableBeforeUnload:
      dirty ||
      saving ||
      publishing.size > 0 ||
      (!savedReviewsPersisted && [...drafts.values()].some((draft) => draft.pendingPush)),
    withResolver: true,
  });
  const update = useCallback((next: ReadonlyMap<string, ReviewDraft>) => {
    draftsRef.current = next;
    setDrafts(next);
  }, []);
  const focus = useCallback((key: string | null) => {
    focusedKey.current = key;
  }, []);
  const blockLeave = useCallback((action?: () => void) => {
    if (
      savingRef.current ||
      publishingRef.current.size > 0 ||
      [...draftsRef.current.values()].some((draft) => draft.contents !== draft.savedContents)
    ) {
      if (action) {
        setError(null);
        setPendingLeave((pending) => pending ?? action);
      }
      return true;
    }
    return false;
  }, []);
  const requestLeave = useCallback(
    (action: () => void) => {
      if (!blockLeave(action)) action();
    },
    [blockLeave],
  );
  const begin = useCallback(
    (draft: ReviewDraft) => {
      checkWritable(draft);
      const key = reviewEditKey(draft);
      const current = draftsRef.current.get(key);
      if (current && (current.pendingPush || current.contents !== current.savedContents))
        return current;
      update(new Map(draftsRef.current).set(key, draft));
      return draft;
    },
    [checkWritable, update],
  );
  const change = useCallback(
    (key: string, contents: string) => {
      const current = draftsRef.current.get(key);
      if (
        current &&
        !(
          current.pullRequestUrl &&
          readOnlyPullRequests.current.has(
            reviewPublishKey(current.environmentId, current.pullRequestUrl),
          )
        ) &&
        !(
          current.pullRequestUrl &&
          publishingRef.current.has(reviewPublishKey(current.environmentId, current.pullRequestUrl))
        )
      )
        update(new Map(draftsRef.current).set(key, { ...current, contents }));
    },
    [update],
  );
  const save = useCallback(
    async (keys: readonly string[]) => {
      if (savingRef.current) return;
      savingRef.current = true;
      const dirtyKeys = keys.filter((key) => {
        const draft = draftsRef.current.get(key);
        return draft && draft.contents !== draft.savedContents;
      });
      setSavingKeys(new Set(dirtyKeys));
      setError(null);
      try {
        for (const key of dirtyKeys) {
          const draft = draftsRef.current.get(key);
          if (!draft || draft.contents === draft.savedContents) continue;
          checkWritable(draft);
          if (
            draft.pullRequestUrl &&
            publishingRef.current.has(reviewPublishKey(draft.environmentId, draft.pullRequestUrl))
          )
            continue;
          let workspace = draft.workspace;
          if (draft.pullRequestUrl && !workspace) {
            workspace = [...draftsRef.current.values()].find(
              (other) =>
                other.environmentId === draft.environmentId &&
                other.cwd === draft.cwd &&
                other.pullRequestUrl === draft.pullRequestUrl &&
                other.workspace,
            )?.workspace;
            if (!workspace) {
              const prepared = await gitEnvironment.preparePullRequestThread.run(appAtomRegistry, {
                environmentId: draft.environmentId,
                input: { cwd: draft.cwd, reference: draft.pullRequestUrl, mode: "review" },
              });
              if (prepared._tag === "Failure") {
                const message = formatEnvironmentQueryError(prepared.cause);
                throw new Error(
                  message.includes('at ["mode"]') &&
                    message.includes('"worktree"') &&
                    !message.includes('"review"')
                    ? `Update and restart this environment's T3 Code server to save PR edits. Your edits are still here.\n\n${message}`
                    : message,
                );
              }
              if (!prepared.value.worktreePath || !prepared.value.isOnPullRequestHead)
                throw new Error(
                  "The PR changed. Refresh the review before saving. Your edits are still here.",
                );
              workspace = { cwd: prepared.value.worktreePath, branch: prepared.value.branch };
            }
          }
          checkWritable(draft);
          const result = await writeFile({
            environmentId: draft.environmentId,
            input: {
              cwd: workspace?.cwd ?? draft.cwd,
              relativePath: draft.filePath,
              contents: draft.contents,
              expectedBranch: workspace?.branch ?? draft.expectedBranch,
              expectedContents: draft.savedContents,
              ...(draft.pullRequestUrl ? { pullRequestUrl: draft.pullRequestUrl } : {}),
            },
          });
          if (result._tag === "Failure") throw new Error(formatEnvironmentQueryError(result.cause));
          const current = draftsRef.current.get(key);
          if (current) {
            const next = new Map(draftsRef.current).set(key, {
              ...current,
              savedContents: draft.contents,
              ...(workspace ? { workspace, pendingPush: true } : {}),
            });
            if (workspace) setSavedReviewsPersisted(persistSavedReviews(next));
            update(next);
          }
          appAtomRegistry.refresh(
            getProjectFileQueryAtom(draft.environmentId, draft.cwd, draft.filePath),
          );
          draft.onSaved?.();
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "The file could not be saved.";
        setError(message);
        toastManager.add({ type: "error", title: "Changes were not saved", description: message });
      } finally {
        savingRef.current = false;
        setSavingKeys(new Set());
      }
    },
    [checkWritable, update, writeFile],
  );
  const publish = useCallback(
    async (environmentId: EnvironmentId, cwd: string, url: string) => {
      const key = reviewPublishKey(environmentId, url);
      if (savingRef.current || publishingRef.current.has(key)) return false;
      const readOnlyReason = readOnlyPullRequests.current.get(key);
      if (readOnlyReason) {
        toastManager.add({
          type: "error",
          title: "Changes were not pushed",
          description: readOnlyReason + " Your saved edits are still here.",
        });
        return false;
      }
      const files = [...draftsRef.current.entries()].filter(
        ([, draft]) =>
          draft.environmentId === environmentId &&
          draft.cwd === cwd &&
          draft.pullRequestUrl === url,
      );
      if (files.some(([, draft]) => draft.contents !== draft.savedContents)) {
        toastManager.add({
          type: "info",
          title: "Save your edits first",
          description: "Press Cmd/Ctrl+S before publishing.",
        });
        return false;
      }
      const pending = files.filter(([, draft]) => draft.pendingPush);
      const workspace = pending[0]?.[1].workspace;
      if (!workspace || pending.length === 0) return false;
      publishingRef.current.add(key);
      setPublishing((previous) => new Map(previous).set(key, "Committing and pushing..."));
      try {
        if (
          pending.some(
            ([, draft]) =>
              draft.workspace?.cwd !== workspace.cwd || draft.workspace.branch !== workspace.branch,
          )
        )
          throw new Error(
            "These saved edits belong to different workspaces. Open each review to publish its changes.",
          );
        const result = await vcsActionManager
          .runStackedAction({ environmentId, cwd: workspace.cwd })
          .run(appAtomRegistry, {
            actionId: randomUUID(),
            action: "commit_push",
            expectedBranch: workspace.branch,
            pullRequestUrl: url,
            ...(pending[0]?.[1].projectId ? { projectId: pending[0][1].projectId } : {}),
            filePaths: pending.map(([, draft]) => draft.filePath),
            onProgress: (event) => {
              if (event.kind === "phase_started")
                setPublishing((previous) => new Map(previous).set(key, event.label));
            },
          });
        if (result._tag === "Failure") throw new Error(formatEnvironmentQueryError(result.cause));
        const next = new Map(draftsRef.current);
        for (const [fileKey] of pending) {
          const draft = next.get(fileKey);
          if (draft) next.set(fileKey, { ...draft, pendingPush: false });
        }
        setSavedReviewsPersisted(persistSavedReviews(next));
        update(next);
        toastManager.add({ type: "success", title: "Changes pushed to the PR" });
        return true;
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: "Changes were not pushed",
          description:
            cause instanceof Error ? cause.message : "Try again. Your saved edits are still here.",
        });
        return false;
      } finally {
        publishingRef.current.delete(key);
        setPublishing((previous) => {
          const next = new Map(previous);
          next.delete(key);
          return next;
        });
      }
    },
    [update],
  );
  const discardUnsaved = useCallback(() => {
    update(
      new Map(
        [...draftsRef.current].flatMap(([key, draft]) =>
          draft.pendingPush ? [[key, { ...draft, contents: draft.savedContents }] as const] : [],
        ),
      ),
    );
    focusedKey.current = null;
  }, [update]);
  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (!event.metaKey && !event.ctrlKey) ||
        event.altKey ||
        event.key.toLowerCase() !== "s" ||
        focusedKey.current === null
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void save([focusedKey.current]);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [save]);
  useEffect(() => {
    if ((!pendingLeave && blocker.status !== "blocked") || dirty || saving || publishing.size > 0)
      return;
    discardUnsaved();
    if (pendingLeave) {
      setPendingLeave(null);
      if (blocker.status === "blocked") blocker.reset();
      pendingLeave();
    } else if (blocker.status === "blocked") blocker.proceed();
  }, [blocker, dirty, saving, publishing.size, discardUnsaved, pendingLeave]);

  return (
    <ReviewEditsContext
      value={{
        drafts,
        begin,
        change,
        focus,
        requestLeave,
        blockLeave,
        saving,
        savingKeys,
        publishing,
        setPullRequestReadOnly,
        publish,
      }}
    >
      {children}
      <AlertDialog
        open={pendingLeave !== null || blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open) {
            setPendingLeave(null);
            if (blocker.status === "blocked") blocker.reset();
          }
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Save changes before leaving?</AlertDialogTitle>
            <AlertDialogDescription>
              {publishing.size > 0
                ? "Wait for commit and push to finish."
                : saving
                  ? "Wait for the save to finish."
                  : (blockedSaveReason ??
                    "Your review edits will be lost if you leave without saving.")}
              {error && (
                <span role="alert" className="mt-2 block text-destructive">
                  {error}
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setPendingLeave(null);
                if (blocker.status === "blocked") blocker.reset();
              }}
            >
              Keep editing
            </Button>
            <Button
              variant="ghost"
              disabled={saving || publishing.size > 0}
              onClick={discardUnsaved}
            >
              Discard
            </Button>
            <Button
              disabled={saving || publishing.size > 0 || blockedSaveReason !== undefined}
              onClick={() => void save([...draftsRef.current.keys()])}
            >
              {saving ? "Saving..." : "Save"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </ReviewEditsContext>
  );
}
