import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import { peerLinkHealth } from "@t3tools/client-runtime/state/peerLinks";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type PeerLinkSummary,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";
import { T, useGT, useMessages, Var } from "gt-react";
import { useId, useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { openLinkedThreadRead } from "../../lib/sideChatPane";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useProject, useQuietThreadShell } from "../../state/entities";
import { readEnvironment } from "../../state/environments";
import { peerLinkEnvironment } from "../../state/peerLinks";
import { useEnvironmentQuery } from "../../state/query";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";

type GT = ReturnType<typeof useGT>;

/**
 * Which thread has the dialog open. The thread menu, the sidebar and the command palette close
 * as their command runs, so the app root renders the dialog once.
 */
const continueOnMachineThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("continue-on-machine:dialog-thread"),
);

export function openContinueOnMachineDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(continueOnMachineThreadAtom, threadRef);
}

export function ContinueOnMachineDialogHost() {
  const threadRef = useAtomValue(continueOnMachineThreadAtom);
  if (threadRef === null) return null;
  return (
    <ContinueOnMachineDialog
      key={scopedThreadKey(threadRef)}
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(continueOnMachineThreadAtom, null)}
    />
  );
}

/** Why a linked machine cannot take the thread, or null when it can. */
function machineUnavailableReason(link: PeerLinkSummary, now: DateTime.Utc, gt: GT) {
  if (link.access !== "full-access") return gt("Needs a Full access link");
  switch (peerLinkHealth(link, now).kind) {
    case "expired":
      return gt("Link expired");
    case "unreachable":
      return gt("Not reachable");
    case "failing":
    case "reachable":
      return null;
  }
}

/** Opens the continued thread in place when this client is connected there, else over the link. */
function openContinuedThread(input: {
  readonly viaEnvironmentId: EnvironmentId;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly label: string;
  readonly title: string;
  readonly navigate: ReturnType<typeof useNavigate>;
}) {
  const { navigate, ...target } = input;
  if (readEnvironment(target.environmentId)?.connection.phase === "connected") {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(target.environmentId, target.threadId)),
    });
    return;
  }
  openLinkedThreadRead({ panelRef: null, target, intent: "primary", navigate });
}

function ContinueOnMachineDialog({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const navigate = useNavigate();
  const id = useId();
  const { environmentId } = threadRef;
  const thread = useQuietThreadShell(threadRef);
  const project = useProject(thread ? scopeProjectRef(environmentId, thread.projectId) : null);
  const links = useEnvironmentQuery(
    peerLinkEnvironment.list({ environmentId, input: {} }),
    resolve,
  );
  const cwd = thread?.worktreePath ?? project?.workspaceRoot ?? null;
  const { data: gitStatus } = useEnvironmentQuery(
    cwd === null ? null : vcsEnvironment.status({ environmentId, input: { cwd } }),
  );
  const canContinue = useAtomValue(
    threadEnvironment.continueOnEnvironment.permissionAtom(environmentId),
  );
  const continueOnEnvironment = useAtomCommand(threadEnvironment.continueOnEnvironment, {
    reportFailure: false,
  });
  const now = DateTime.makeUnsafe(useNowMinute());
  const [targetId, setTargetId] = useState<EnvironmentId | null>(null);
  const [commitAndPush, setCommitAndPush] = useState(false);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const machines = (links.data?.links ?? []).map((link) => ({
    link,
    unavailableReason: machineUnavailableReason(link, now, gt),
  }));
  const available = machines.filter((machine) => machine.unavailableReason === null);
  const target =
    available.find((machine) => machine.link.environmentId === targetId) ?? available[0] ?? null;

  const uncommittedFiles = gitStatus?.hasWorkingTreeChanges
    ? Math.max(gitStatus.workingTree.files.length, 1)
    : 0;
  const unpushedCommits = gitStatus?.hasUpstream ? gitStatus.aheadCount : 0;
  const branchUnpublished = gitStatus?.refName != null && !gitStatus.hasUpstream;
  const hasUnpushedWork = uncommittedFiles > 0 || unpushedCommits > 0 || branchUnpublished;
  const isRunning = thread !== null && !threadRuntimeCanArchive(thread.runtime);
  const blockedReason = isRunning
    ? gt("The agent is working. Wait for the turn to end, or stop it.")
    : hasUnpushedWork && !commitAndPush
      ? gt("Tick Commit and push my changes first, or push the changes yourself.")
      : null;
  const unavailable = !canContinue || target === null || blockedReason !== null;

  const submit = async () => {
    if (target === null || unavailable || submitting) return;
    setSubmitting(true);
    setError(null);
    const trimmedMessage = message.trim();
    const result = await continueOnEnvironment({
      environmentId,
      input: {
        threadId: threadRef.threadId,
        targetEnvironmentId: target.link.environmentId,
        commitAndPush,
        ...(trimmedMessage.length > 0 ? { message: trimmedMessage } : {}),
      },
    });
    if (result._tag === "Failure") {
      setSubmitting(false);
      if (!isAtomCommandInterrupted(result)) {
        setError(
          thrownErrorMessage(squashAtomCommandFailure(result), resolve) ??
            gt("Could not continue on the other machine."),
        );
      }
      return;
    }
    onClose();
    const continued = result.value;
    const label = target.link.label;
    toastManager.add({
      type: "success",
      title: gt("Continued on {machine}", { machine: label }),
      description: continued.title,
      actionProps: {
        children: gt("Open thread"),
        onClick: () =>
          openContinuedThread({
            viaEnvironmentId: environmentId,
            environmentId: continued.targetEnvironmentId,
            threadId: continued.targetThreadId,
            label,
            title: continued.title,
            navigate,
          }),
      },
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
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
              <T>Continue on another machine</T>
            </DialogTitle>
            <DialogDescription>
              <T>
                The agent on the other machine gets the conversation and the branch of{" "}
                <Var>{thread?.title ?? ""}</Var>.
              </T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-1.5">
              <span id={`${id}-machines`} className="font-medium text-sm">
                {gt("Machine", { $context: "label for a list of machines to choose from" })}
              </span>
              {links.error ? (
                <p className="text-destructive-foreground text-sm">{links.error}</p>
              ) : !links.data ? (
                <p role="status" className="text-muted-foreground text-sm">
                  <T>Loading linked environments…</T>
                </p>
              ) : machines.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  <T>No linked environments. Link another machine with Full access first.</T>
                </p>
              ) : (
                <RadioGroup
                  aria-labelledby={`${id}-machines`}
                  value={target?.link.environmentId ?? null}
                  disabled={submitting}
                  onValueChange={(value) => {
                    const picked = available.find(
                      (machine) => machine.link.environmentId === value,
                    );
                    if (picked) setTargetId(picked.link.environmentId);
                  }}
                >
                  {machines.map((machine) => (
                    <label
                      key={machine.link.environmentId}
                      className="flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm has-disabled:cursor-not-allowed"
                    >
                      <Radio
                        value={machine.link.environmentId}
                        disabled={machine.unavailableReason !== null}
                      />
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {machine.link.label}
                      </span>
                      {machine.unavailableReason ? (
                        <span className="shrink-0 text-muted-foreground text-xs">
                          {machine.unavailableReason}
                        </span>
                      ) : null}
                    </label>
                  ))}
                </RadioGroup>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              {hasUnpushedWork ? (
                <div className="text-sm">
                  <p>
                    <T>The other machine gets only pushed commits. This machine still has:</T>
                  </p>
                  <ul className="list-disc ps-5 text-muted-foreground">
                    {uncommittedFiles > 0 ? (
                      <li>
                        {gt(
                          "{count, plural, one {{count} uncommitted file} other {{count} uncommitted files}}",
                          { count: uncommittedFiles },
                        )}
                      </li>
                    ) : null}
                    {unpushedCommits > 0 ? (
                      <li>
                        {gt(
                          "{count, plural, one {{count} unpushed commit} other {{count} unpushed commits}}",
                          { count: unpushedCommits },
                        )}
                      </li>
                    ) : null}
                    {branchUnpublished ? <li>{gt("A branch that is not pushed")}</li> : null}
                  </ul>
                </div>
              ) : null}
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox
                  checked={commitAndPush}
                  disabled={submitting}
                  onCheckedChange={(checked) => setCommitAndPush(checked)}
                />
                <T>Commit and push my changes first</T>
              </label>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-message`}>
                <T>Message for the agent there</T>
              </Label>
              <Textarea
                id={`${id}-message`}
                aria-describedby={`${id}-message-hint`}
                value={message}
                maxLength={PROVIDER_SEND_TURN_MAX_INPUT_CHARS}
                disabled={submitting}
                onChange={(event) => setMessage(event.target.value)}
                size="sm"
              />
              <p id={`${id}-message-hint`} className="text-muted-foreground text-xs">
                <T>Optional. Without a message, the new thread waits for you.</T>
              </p>
            </div>

            {blockedReason ? (
              <p id={`${id}-blocked`} className="text-muted-foreground text-sm">
                {blockedReason}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-destructive-foreground text-sm">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              <T>Cancel</T>
            </Button>
            <Button
              type="submit"
              disabled={unavailable || submitting}
              aria-describedby={blockedReason ? `${id}-blocked` : undefined}
            >
              {submitting ? gt("Continuing…") : gt("Continue there")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
