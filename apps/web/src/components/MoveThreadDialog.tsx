import { useAtomValue } from "@effect/atom-react";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  findMoveTargetProject,
  summarizeThreadMoveCode,
} from "@t3tools/client-runtime/thread-move";
import {
  CommandId,
  type EnvironmentId,
  type ProjectId,
  type ScopedThreadRef,
  type ThreadMoveSnapshot,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { msg, T, useGT, Var } from "gt-react";
import { useState } from "react";
import { create } from "zustand";

import { useAddProjectTargets } from "../hooks/useAddProjectTargets";
import { useLogicalProjectEnvironments } from "../hooks/useLogicalProjectEnvironments";
import { m } from "../i18n/messages";
import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useProject, useProjects, useThreadShell } from "../state/entities";
import { useEnvironment } from "../state/environments";
import { threadMove, threadMoveTargetsAtom } from "../state/threadMove";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { openAddProjectToMachine } from "./AddProjectToMachineDialog";
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
import { Spinner } from "./ui/spinner";
import { toastManager } from "./ui/toast";

interface MoveThreadRequest {
  readonly threadRef: ScopedThreadRef;
  readonly targetEnvironmentId: EnvironmentId;
}

type ExportState =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly snapshot: ThreadMoveSnapshot };

const useRequest = create<{
  request: MoveThreadRequest | null;
  session: number;
  exported: ExportState;
}>(() => ({ request: null, session: 0, exported: { status: "loading" } }));

let stopExport: AbortController | null = null;

/** Opens the dialog that moves a thread to another connected machine, reading the thread first. */
export function openMoveThread(request: MoveThreadRequest) {
  stopExport?.abort();
  const abort = new AbortController();
  stopExport = abort;
  const session = useRequest.getState().session + 1;
  useRequest.setState({ request, session, exported: { status: "loading" } });
  void runAtomCommand(
    appAtomRegistry,
    threadMove.exportThread,
    {
      environmentId: request.threadRef.environmentId,
      input: { threadId: request.threadRef.threadId },
    },
    { reportFailure: false, signal: abort.signal },
  ).then((result) => {
    if (useRequest.getState().session !== session) return;
    useRequest.setState({
      exported:
        result._tag === "Success"
          ? { status: "ready", snapshot: result.value }
          : {
              status: "failed",
              message:
                errorDisplayMessage(squashAtomCommandFailure(result), m) ??
                m(msg("Could not read the thread.")),
            },
    });
  });
}

function close() {
  stopExport?.abort();
  stopExport = null;
  useRequest.setState({ request: null });
}

export function MoveThreadDialogHost() {
  const request = useRequest((state) => state.request);
  const session = useRequest((state) => state.session);
  const exported = useRequest((state) => state.exported);
  return request ? <MoveThreadDialog key={session} request={request} exported={exported} /> : null;
}

function MoveThreadDialog({
  request,
  exported,
}: {
  request: MoveThreadRequest;
  exported: ExportState;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const { threadRef } = request;
  const thread = useThreadShell(threadRef);
  const source = useEnvironment(threadRef.environmentId);
  const targetEnvironment = useEnvironment(request.targetEnvironmentId);
  const sourceProject = useProject(
    thread ? scopeProjectRef(threadRef.environmentId, thread.projectId) : null,
  );
  const target =
    useAtomValue(threadMoveTargetsAtom(threadRef.environmentId)).find(
      (candidate) => candidate.environmentId === request.targetEnvironmentId,
    ) ?? null;
  const canArchiveSource = useAtomValue(threadMove.completePermissionAtom(threadRef.environmentId));
  const targetProjects = useProjects().filter(
    (project) =>
      project.environmentId === request.targetEnvironmentId && project.archivedAt == null,
  );
  const [chosenProjectId, setChosenProjectId] = useState<ProjectId | null>(null);
  const matchedProject = findMoveTargetProject(sourceProject, targetProjects);
  const targetProject =
    targetProjects.find((project) => project.id === chosenProjectId) ?? matchedProject;
  const addProjectTargets = useAddProjectTargets(
    sourceProject,
    useLogicalProjectEnvironments(sourceProject, false),
  );
  const canAddProject =
    matchedProject === null &&
    addProjectTargets.some((candidate) => candidate.environmentId === request.targetEnvironmentId);
  // One id per dialog session, so retrying after a failure lands on the same new thread.
  const [commandId] = useState(() => CommandId.make(randomUUID()));
  const move = useAtomCommand(threadMove.move, { reportFailure: false });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const snapshot = exported.status === "ready" ? exported.snapshot : null;
  const sourceLabel = source?.label ?? gt("this machine");
  const targetLabel = targetEnvironment?.label ?? gt("the other machine");

  const submit = async () => {
    if (!snapshot || !target || !targetProject || !canArchiveSource || submitting) return;
    setSubmitting(true);
    setError(null);
    const result = await move({
      commandId,
      source: { environmentId: threadRef.environmentId, threadId: threadRef.threadId },
      target: {
        environmentId: target.environmentId,
        projectId: targetProject.id,
        label: target.label,
      },
      snapshot,
      creationSource: "web",
    });
    if (result._tag === "Failure") {
      setError(
        errorDisplayMessage(squashAtomCommandFailure(result), m) ??
          gt("Could not move the thread."),
      );
      setSubmitting(false);
      return;
    }
    close();
    toastManager.add({
      type: "success",
      title: gt("Moved to {machine}", { machine: target.label }),
      description: snapshot.title,
    });
    if (!result.value.sourceArchived) {
      toastManager.add({
        type: "warning",
        title: gt("The original thread could not be archived"),
        description: gt("Archive it on {machine} to avoid working in both.", {
          machine: sourceLabel,
        }),
      });
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(target.environmentId, result.value.threadId)),
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // The move keeps running once started, and its result navigates.
        if (!open && !submitting) close();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <T>
                Move thread to <Var>{targetLabel}</Var>
              </T>
            </DialogTitle>
            <DialogDescription>
              <T>
                The thread continues on <Var>{targetLabel}</Var> with its conversation. The original
                is archived on <Var>{sourceLabel}</Var>; unarchive it to bring it back.
              </T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {exported.status === "loading" ? (
              <p className="flex items-center gap-2 text-muted-foreground text-sm">
                <Spinner size="sm" />
                <T>Reading the thread…</T>
              </p>
            ) : exported.status === "failed" ? (
              <p className="text-destructive-foreground text-sm">{exported.message}</p>
            ) : (
              <>
                {target ? null : (
                  <p className="text-destructive-foreground text-sm">
                    <T>
                      That machine is no longer connected, or this connection cannot start threads
                      on it.
                    </T>
                  </p>
                )}

                <div className="flex flex-col gap-1.5">
                  <Label>
                    <T>Project</T>
                  </Label>
                  {targetProjects.length > 0 ? (
                    <Select
                      value={targetProject?.id ?? null}
                      onValueChange={(value) => {
                        if (value) setChosenProjectId(value);
                      }}
                    >
                      <SelectTrigger
                        size="sm"
                        aria-label={gt("Project on {machine}", { machine: targetLabel })}
                      >
                        <SelectValue placeholder={gt("Select a project")}>
                          {targetProject?.title}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        {targetProjects.map((project) => (
                          <SelectItem key={project.id} value={project.id} label={project.title}>
                            <span className="block truncate">{project.title}</span>
                            <span className="block max-w-72 truncate text-xs text-muted-foreground">
                              {project.workspaceRoot}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  ) : null}
                  {canAddProject && sourceProject ? (
                    <div className="flex items-center gap-2">
                      <p className="flex-1 text-muted-foreground text-xs">
                        <T>
                          <Var>{targetLabel}</Var> does not have this project yet.
                        </T>
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() =>
                          openAddProjectToMachine({
                            projectRef: scopeProjectRef(
                              sourceProject.environmentId,
                              sourceProject.id,
                            ),
                            targetEnvironmentId: request.targetEnvironmentId,
                          })
                        }
                      >
                        {gt("Add project to {machine}", { machine: targetLabel })}
                      </Button>
                    </div>
                  ) : targetProjects.length === 0 ? (
                    <p className="text-muted-foreground text-xs">
                      <T>
                        <Var>{targetLabel}</Var> has no projects to move the thread into.
                      </T>
                    </p>
                  ) : null}
                </div>

                <MoveCodeSummary snapshot={exported.snapshot} sourceLabel={sourceLabel} />

                {exported.snapshot.omittedMessageCount > 0 ? (
                  <p className="text-muted-foreground text-sm">
                    {gt(
                      "{count, plural, one {{count} older message stays behind to keep the moved history under 1 MB.} other {{count} older messages stay behind to keep the moved history under 1 MB.}}",
                      { count: exported.snapshot.omittedMessageCount },
                    )}
                  </p>
                ) : null}
              </>
            )}

            {error ? <p className="text-destructive-foreground text-sm">{error}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={submitting} onClick={close}>
              <T>Cancel</T>
            </Button>
            <Button
              type="submit"
              disabled={!snapshot || !target || !targetProject || !canArchiveSource || submitting}
            >
              {submitting ? gt("Moving…") : gt("Move", { $context: "verb, move the thread" })}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function MoveCodeSummary({
  snapshot,
  sourceLabel,
}: {
  snapshot: ThreadMoveSnapshot;
  sourceLabel: string;
}) {
  const gt = useGT();
  const code = summarizeThreadMoveCode(snapshot.git);
  if (code.type === "no-git") {
    return (
      <p className="text-muted-foreground text-sm">
        <T>This thread is not on a Git branch, so the new thread starts in the project folder.</T>
      </p>
    );
  }
  if (code.type === "not-pushed") {
    return (
      <p className="text-muted-foreground text-sm">
        {gt(
          "{branch} is not pushed, so its code stays on {machine}. The new thread starts in the project folder.",
          { branch: code.branch, machine: sourceLabel },
        )}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p className="text-muted-foreground">
        {gt("The new thread continues on {branch}, checked out from its remote.", {
          branch: code.branch,
        })}
      </p>
      {code.unpushedCommitCount > 0 ? (
        <p className="text-warning-foreground">
          {gt(
            "{count, plural, one {{count} commit is not pushed and stays on {machine}.} other {{count} commits are not pushed and stay on {machine}.}}",
            { count: code.unpushedCommitCount, machine: sourceLabel },
          )}
        </p>
      ) : null}
      {code.uncommittedFileCount > 0 ? (
        <p className="text-warning-foreground">
          {gt(
            "{count, plural, one {{count} uncommitted file stays on {machine}.} other {{count} uncommitted files stay on {machine}.}}",
            { count: code.uncommittedFileCount, machine: sourceLabel },
          )}
        </p>
      ) : null}
    </div>
  );
}
