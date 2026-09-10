import { randomHex } from "../lib/utils";
import { useEffect, useState } from "react";
import { type ScopedThreadRef, type VcsRef } from "@t3tools/contracts";
import {
  prepareQuickChatWorktree,
  type PendingQuickChatAttachment,
} from "@t3tools/client-runtime/operations/quickChats";
import { quickChatAttachmentStorage } from "../quickChatAttachmentStorage";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { useQuickChatAttachmentStore } from "../quickChatAttachmentStore";
import { useProjects, useThreadShell } from "../state/entities";
import { useAtomCommand } from "../state/use-atom-command";
import { threadEnvironment } from "../state/threads";
import { vcsEnvironment } from "../state/vcs";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogFooter } from "./ui/dialog";
import { Button } from "./ui/button";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "./ui/select";

function AttachmentForm({ threadRef }: { threadRef: ScopedThreadRef }) {
  const projects = useProjects().filter(
    (project) => project.environmentId === threadRef.environmentId,
  );
  const thread = useThreadShell(threadRef);
  const [saved] = useState(() => {
    try {
      return { pending: quickChatAttachmentStorage.load(threadRef), error: null };
    } catch {
      return {
        pending: null,
        error: "Could not load the pending attachment. Check browser storage before retrying.",
      };
    }
  });
  const [projectId, setProjectId] = useState(saved.pending?.projectId ?? projects[0]?.id ?? "");
  const [workspaceMode, setWorkspaceMode] = useState<"local" | "existing" | "new">(
    saved.pending ? "new" : "local",
  );
  const newWorktree = workspaceMode === "new";
  const [existingRef, setExistingRef] = useState<VcsRef | null>(null);
  const [baseBranch, setBaseBranch] = useState(saved.pending?.baseBranch ?? "");
  const [error, setError] = useState<string | null>(saved.error);
  const [prepared, setPrepared] = useState<PendingQuickChatAttachment | null>(saved.pending);
  const busy = useQuickChatAttachmentStore((state) => state.busy);
  const update = useAtomCommand(threadEnvironment.updateMetadata, "Attach quick chat");
  const createWorktree = useAtomCommand(vcsEnvironment.createWorktree, "Create worktree");
  const listRefs = useAtomQueryRunner(vcsEnvironment.readRefs, { refresh: true });
  const project = projectId
    ? projects.find((candidate) => candidate.id === projectId)
    : projects[0];
  const unavailable =
    saved.error !== null ||
    !thread ||
    thread.projectId !== null ||
    thread.archivedAt !== null ||
    thread.session?.status === "running" ||
    thread.session?.status === "starting" ||
    thread.latestTurn?.state === "running" ||
    thread.backgroundLiveness != null ||
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput;

  useEffect(() => {
    if (thread?.projectId != null) useQuickChatAttachmentStore.setState({ threadRef: null });
  }, [thread?.projectId]);

  async function attach() {
    if (useQuickChatAttachmentStore.getState().busy || unavailable || !project) return;
    useQuickChatAttachmentStore.setState({ busy: true });
    setError(null);
    try {
      let worktree = null;
      if (newWorktree) {
        const pending = prepared ?? {
          projectId: project.id,
          workspaceRoot: project.workspaceRoot,
          baseBranch: baseBranch.trim(),
          branch: `t3/quick-chat-${randomHex(16)}`,
        };
        await quickChatAttachmentStorage.save(threadRef, pending);
        setPrepared(pending);
        worktree = await prepareQuickChatWorktree({
          pending,
          listRefs: async () => {
            const result = await listRefs({
              environmentId: threadRef.environmentId,
              input: {
                cwd: pending.workspaceRoot,
                query: pending.branch,
                refKind: "local",
                refresh: true,
              },
            });
            if (result._tag === "Failure")
              throw new Error(
                "Could not check the prepared worktree. Check the connection and retry.",
              );
            return result.value;
          },
          createWorktree: async (input) => {
            const result = await createWorktree({ environmentId: threadRef.environmentId, input });
            if (result._tag === "Failure")
              throw new Error(
                "Could not confirm worktree creation. Retry to recover the same branch.",
              );
            return result.value;
          },
        });
      }
      if (workspaceMode === "existing") {
        if (!existingRef) return;
        const result = await listRefs({
          environmentId: threadRef.environmentId,
          input: {
            cwd: project.workspaceRoot,
            query: existingRef.name,
            refKind: "local",
            refresh: true,
          },
        });
        if (result._tag === "Failure")
          throw new Error("Could not check the selected worktree. Retry when connected.");
        const ref = result.value.refs.find(
          (candidate) => candidate.name === existingRef.name && !candidate.isRemote,
        );
        if (!ref?.worktreePath || ref.worktreePath === project.workspaceRoot)
          throw new Error("This worktree is no longer available. Select another worktree.");
        worktree = { refName: ref.name, path: ref.worktreePath };
      }
      const result = await update({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          projectId: project.id,
          branch: worktree?.refName ?? null,
          worktreePath: worktree?.path ?? null,
        },
      });
      if (result._tag === "Failure") {
        setError(
          worktree
            ? `Could not confirm attachment. Retry to use the prepared worktree at ${worktree.path}.`
            : "Could not confirm attachment. Check the connection and retry.",
        );
        return;
      }
      quickChatAttachmentStorage.clear(threadRef);
      useQuickChatAttachmentStore.setState({ threadRef: null });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not prepare the attachment. Check storage and retry.",
      );
    } finally {
      useQuickChatAttachmentStore.setState({ busy: false });
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Attach to project</DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-4 px-6 py-4">
        <label className="flex flex-col gap-2 text-sm">
          Project
          <Select
            items={projects.map((project) => ({ value: project.id, label: project.title }))}
            value={project?.id ?? null}
            disabled={busy || prepared !== null}
            onValueChange={(value) => {
              if (value !== null) {
                setProjectId(value);
                setBaseBranch("");
                setExistingRef(null);
              }
            }}
          >
            <SelectTrigger aria-label="Project">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </label>
        <label className="flex flex-col gap-2 text-sm">
          Workspace
          <Select
            value={workspaceMode}
            disabled={busy || prepared !== null}
            items={[
              { value: "local", label: "Local checkout" },
              { value: "existing", label: "Existing worktree" },
              { value: "new", label: "New worktree" },
            ]}
            onValueChange={(value) => {
              if (value === "local" || value === "existing" || value === "new")
                setWorkspaceMode(value);
            }}
          >
            <SelectTrigger aria-label="Workspace">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="local">Local checkout</SelectItem>
              <SelectItem value="existing">Existing worktree</SelectItem>
              <SelectItem value="new">New worktree</SelectItem>
            </SelectPopup>
          </Select>
        </label>
        {project && workspaceMode !== "local" && (
          <div className="flex flex-col gap-2 text-sm">
            <span>{newWorktree ? "Base branch" : "Worktree"}</span>
            <BranchToolbarBranchSelector
              environmentId={threadRef.environmentId}
              threadId={threadRef.threadId}
              envLocked
              startFromOrigin={false}
              onStartFromOriginChange={() => {}}
              selection={{
                projectId: project.id,
                mode: newWorktree ? "base" : "worktree",
                value: newWorktree ? baseBranch || null : (existingRef?.name ?? null),
                disabled: busy || prepared !== null,
                onSelect: (ref) => {
                  if (newWorktree) setBaseBranch(ref.name);
                  else setExistingRef(ref);
                },
              }}
            />
          </div>
        )}
        {projects.length === 0 && (
          <p className="text-sm">Add a project on this environment first.</p>
        )}
        {unavailable && (
          <p className="text-sm">Finish the current turn and background work before attaching.</p>
        )}
        {error && (
          <p role="alert" className="text-sm">
            {error}
          </p>
        )}
        {prepared && !busy && (
          <div className="flex flex-col items-start gap-2 text-sm">
            <Button
              variant="outline"
              onClick={() => {
                try {
                  quickChatAttachmentStorage.clear(threadRef);
                  setPrepared(null);
                  setProjectId("");
                  setWorkspaceMode("local");
                  setBaseBranch("");
                  setExistingRef(null);
                  setError(null);
                } catch {
                  setError("Could not reset the attachment. Check browser storage and retry.");
                }
              }}
            >
              Change attachment target
            </Button>
            <p>Any created worktree remains available under Existing worktree.</p>
          </div>
        )}
      </div>
      <DialogFooter>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => useQuickChatAttachmentStore.getState().close()}
        >
          Cancel
        </Button>
        <Button
          disabled={
            busy ||
            unavailable ||
            !project ||
            (newWorktree && !baseBranch.trim()) ||
            (workspaceMode === "existing" && !existingRef)
          }
          onClick={() => void attach()}
        >
          {busy ? "Attaching…" : "Attach"}
        </Button>
      </DialogFooter>
    </>
  );
}

export function AttachQuickChatDialog() {
  const threadRef = useQuickChatAttachmentStore((state) => state.threadRef);
  return (
    <Dialog
      open={threadRef !== null}
      onOpenChange={(open) => {
        if (!open) useQuickChatAttachmentStore.getState().close();
      }}
    >
      <DialogPopup>
        {threadRef && (
          <AttachmentForm
            key={`${threadRef.environmentId}:${threadRef.threadId}`}
            threadRef={threadRef}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}
