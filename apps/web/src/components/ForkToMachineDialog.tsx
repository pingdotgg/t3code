import { useNavigate } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  forkBranchState,
  forkFirstMessage,
  forkModelSelection,
} from "@t3tools/client-runtime/operations/forkToMachine";
import { canCreateProjectInEnvironment } from "@t3tools/client-runtime/operations/projects";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useState } from "react";
import { create } from "zustand";

import { useLogicalProjectEnvironments } from "../hooks/useLogicalProjectEnvironments";
import { newMessageId, newThreadId, randomUUID } from "../lib/utils";
import { useProject, useThreadShell } from "../state/entities";
import { useEnvironmentProviders, useEnvironments } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironmentsWithScope } from "../state/session";
import { useGitStackedAction } from "../state/sourceControlActions";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import { openAddProjectToMachine } from "./AddProjectToMachineDialog";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Label } from "./ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Textarea } from "./ui/textarea";

const useRequest = create<{ threadRef: ScopedThreadRef | null }>(() => ({ threadRef: null }));

/** Opens the dialog that forks a thread into a new thread on another connected machine. */
export function openForkToMachine(threadRef: ScopedThreadRef) {
  useRequest.setState({ threadRef });
}

const close = () => useRequest.setState({ threadRef: null });

export function ForkToMachineDialogHost() {
  const threadRef = useRequest((state) => state.threadRef);
  return threadRef ? <ForkToMachineDialog threadRef={threadRef} /> : null;
}

function failureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "An error occurred.";
}

function ForkToMachineDialog({ threadRef }: { threadRef: ScopedThreadRef }) {
  const navigate = useNavigate();
  const thread = useThreadShell(threadRef);
  const projectRef = thread ? scopeProjectRef(thread.environmentId, thread.projectId) : null;
  const project = useProject(projectRef);
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const canOperate = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const connected = new Set(
    environments
      .filter((environment) => canCreateProjectInEnvironment(environment.connection.phase))
      .map((environment) => environment.environmentId),
  );
  const targets = useLogicalProjectEnvironments(project, false).flatMap((environment) =>
    environment.environmentId !== threadRef.environmentId &&
    environment.projectId !== null &&
    connected.has(environment.environmentId) &&
    canOperate.has(environment.environmentId)
      ? [{ ...environment, projectId: environment.projectId }]
      : [],
  );
  const [targetId, setTargetId] = useState<EnvironmentId | null>(null);
  // The choice locks once the note is written, so a lost target disables the fork.
  const target =
    targets.find((t) => t.environmentId === (targetId ?? targets[0]?.environmentId)) ?? null;
  const sourceLabel =
    environments.find((environment) => environment.environmentId === threadRef.environmentId)
      ?.label ?? "another machine";

  const cwd = thread?.worktreePath ?? project?.workspaceRoot ?? null;
  const scope = { environmentId: thread ? threadRef.environmentId : null, cwd };
  const status = useEnvironmentQuery(
    cwd === null
      ? null
      : vcsEnvironment.status({ environmentId: threadRef.environmentId, input: { cwd } }),
  );
  const branchState = status.data ? forkBranchState(status.data) : null;
  const push = useGitStackedAction(scope);

  const writeForkNote = useAtomCommand(threadEnvironment.writeForkNote, { reportFailure: false });
  const launch = useAtomCommand(threadEnvironment.launch, { reportFailure: false });
  const [message, setMessage] = useState<string | null>(null);
  // The note describes this ref; the fork starts there even if the checkout moves on.
  const [noteBaseRef, setNoteBaseRef] = useState<string | null>(null);
  const [busy, setBusy] = useState<"note" | "fork" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The note forks the latest completed turn, which includes its checkpoint.
  const isRunning = thread !== null && threadRuntimeIsActive(thread.runtime);
  const ready = thread !== null && target !== null && branchState?.kind === "ready" && !isRunning;

  const writeNote = async () => {
    if (!ready || busy) return;
    setTargetId(target.environmentId);
    setBusy("note");
    setError(null);
    const result = await writeForkNote({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, targetLabel: target.label },
    });
    setBusy(null);
    if (result._tag === "Failure") {
      setError(failureMessage(result));
      return;
    }
    setNoteBaseRef(branchState.baseRef);
    setMessage(
      forkFirstMessage({ note: result.value.note, sourceLabel, baseRef: branchState.baseRef }),
    );
  };

  const fork = async () => {
    if (!ready || busy || message === null || noteBaseRef === null || !message.trim()) return;
    const modelSelection = forkModelSelection({
      selection: thread.modelSelection,
      sourceProviders: providersByEnvironment.get(threadRef.environmentId) ?? [],
      targetProviders: providersByEnvironment.get(target.environmentId) ?? [],
    });
    if (modelSelection === null) {
      setError(`${target.label} has no provider ready to run the thread.`);
      return;
    }
    setBusy("fork");
    setError(null);
    const threadId = newThreadId();
    const result = await launch({
      environmentId: target.environmentId,
      input: {
        commandId: CommandId.make(randomUUID()),
        creationSource: "web",
        threadId,
        projectId: target.projectId,
        title: thread.title,
        modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        workspaceStrategy: {
          type: "worktree",
          baseRef: noteBaseRef,
          startFromOrigin: true,
        },
        initialMessage: { messageId: newMessageId(), text: message, attachments: [] },
      },
    });
    setBusy(null);
    if (result._tag === "Failure") {
      setError(failureMessage(result));
      return;
    }
    close();
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: target.environmentId, threadId },
    });
  };

  const runPush = async () => {
    const result = await push.run({
      actionId: randomUUID(),
      action: "push",
      threadId: threadRef.threadId,
    });
    if (result._tag === "Failure") setError(failureMessage(result));
    else status.refresh();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Fork to another machine</DialogTitle>
          <DialogDescription>
            Start a new thread on another machine from this branch. An agent writes a handoff note
            from this thread first. This thread keeps going here.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {targets.length === 0 ? (
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm">No other connected machine has this project.</p>
              {projectRef ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    close();
                    openAddProjectToMachine({ projectRef, targetEnvironmentId: null });
                  }}
                >
                  Add project to another machine
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label>Machine</Label>
              <Select
                value={target?.environmentId ?? null}
                onValueChange={(value) => {
                  if (value) setTargetId(value);
                }}
                items={targets.map((t) => ({ value: t.environmentId, label: t.label }))}
                disabled={busy !== null || message !== null}
              >
                <SelectTrigger size="sm" aria-label="Machine to fork the thread to">
                  {target ? (
                    <EnvironmentMachineIcon kind={target.machine} className="size-3.5" />
                  ) : null}
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {targets.map((t) => (
                    <SelectItem key={t.environmentId} value={t.environmentId}>
                      <span className="inline-flex items-center gap-1.5">
                        <EnvironmentMachineIcon kind={t.machine} className="size-3" />
                        {t.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          )}

          <div className="flex flex-col gap-1 text-sm">
            {status.error ? (
              <p className="text-destructive-foreground">{status.error}</p>
            ) : branchState === null ? (
              <p className="text-muted-foreground">Checking the branch…</p>
            ) : branchState.kind === "blocked" ? (
              <div className="flex items-center gap-2">
                <p className="flex-1">{branchState.reason}</p>
                {branchState.canPush && push.isAllowed ? (
                  <Button size="sm" variant="outline" disabled={push.isPending} onClick={runPush}>
                    {push.isPending ? "Pushing…" : "Push"}
                  </Button>
                ) : null}
              </div>
            ) : (
              <p className="text-muted-foreground">
                Starts a new branch from {noteBaseRef ?? branchState.baseRef}.
              </p>
            )}
            {status.data?.hasWorkingTreeChanges ? (
              <p className="text-muted-foreground">Uncommitted changes stay on this machine.</p>
            ) : null}
            {isRunning ? (
              <p className="text-muted-foreground">Wait for the current turn to finish.</p>
            ) : null}
          </div>

          {busy === "note" ? (
            <p className="text-muted-foreground text-sm">
              Writing the handoff note. This takes about a minute.
            </p>
          ) : message !== null ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fork-to-machine-message">First message</Label>
              <Textarea
                id="fork-to-machine-message"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                rows={14}
              />
            </div>
          ) : null}

          {error ? <p className="text-destructive-foreground text-sm">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          {message === null ? (
            <Button disabled={!ready || busy !== null} onClick={writeNote}>
              {busy === "note" ? "Writing note…" : "Write handoff note"}
            </Button>
          ) : (
            <Button
              disabled={!ready || busy !== null || message.trim().length === 0}
              onClick={fork}
            >
              {busy === "fork" ? "Forking…" : `Fork to ${target?.label ?? "machine"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
