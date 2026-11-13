import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  PeerLinkSummary,
  ScopedThreadRef,
  WorkFilesMode,
  WorkFilesSummary,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { formatBytes } from "~/lib/formatBytes";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readEnvironmentServerConfigLoaded } from "~/state/entities";
import { peerLinkEnvironment } from "~/state/peerLinks";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { continueOnMachineThreadAtom } from "./continueOnMachineDialogState";

export function ContinueOnMachineDialogHost() {
  const threadRef = useAtomValue(continueOnMachineThreadAtom);
  if (threadRef === null) return null;
  return (
    <ContinueOnMachineDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(continueOnMachineThreadAtom, null)}
    />
  );
}

type Stage =
  | { readonly kind: "pick" }
  | { readonly kind: "checking"; readonly link: PeerLinkSummary }
  | { readonly kind: "ask"; readonly link: PeerLinkSummary; readonly summary: WorkFilesSummary }
  | { readonly kind: "running"; readonly link: PeerLinkSummary; readonly mode: WorkFilesMode };

const failureMessage = (error: unknown) =>
  error instanceof Error ? error.message : "An unexpected error occurred.";

/** What the files are, in one sentence, with what stays behind. */
function workFilesDescription(summary: WorkFilesSummary): string {
  const files = `${summary.fileCount.toLocaleString()} ${summary.fileCount === 1 ? "file" : "files"}`;
  const deletions =
    summary.deletionCount === 0
      ? ""
      : ` and ${summary.deletionCount.toLocaleString()} ${summary.deletionCount === 1 ? "deletion" : "deletions"}`;
  return `${files}${deletions} (${formatBytes(summary.totalBytes)}) from ${summary.directory}. Every uncommitted and untracked file goes, secrets included. Git-ignored files stay on this machine.`;
}

function ContinueOnMachineDialog({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const navigate = useNavigate();
  const links = useEnvironmentQuery(
    peerLinkEnvironment.list({ environmentId: threadRef.environmentId, input: {} }),
  );
  const summarize = useAtomCommand(peerLinkEnvironment.workFilesSummary, { reportFailure: false });
  const continueThread = useAtomCommand(peerLinkEnvironment.continueThread, {
    reportFailure: false,
  });
  const [stage, setStage] = useState<Stage>({ kind: "pick" });
  const reachable = (links.data?.links ?? []).filter((link) => link.status === "reachable");
  const busy = stage.kind === "checking" || stage.kind === "running";

  const fail = (link: PeerLinkSummary, error: unknown) =>
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `Could not continue on ${link.label}`,
        description: failureMessage(error),
      }),
    );

  const run = async (link: PeerLinkSummary, mode: WorkFilesMode) => {
    setStage({ kind: "running", link, mode });
    const result = await continueThread({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, environmentId: link.environmentId, workFiles: mode },
    });
    onClose();
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) fail(link, squashAtomCommandFailure(result));
      return;
    }
    const continued = result.value;
    const target = scopeThreadRef(continued.environmentId, continued.threadId);
    // This client can open it only while it is connected to that machine too.
    const canOpen = readEnvironmentServerConfigLoaded(continued.environmentId);
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: `Continued on ${continued.label}`,
        description:
          mode === "transfer"
            ? `A new thread there picked up this one, with ${continued.transferredFiles.toLocaleString()} work files.`
            : "A new thread there picked up this one.",
        ...(canOpen
          ? {
              actionProps: {
                children: "Open thread",
                onClick: () => {
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: buildThreadRouteParams(target),
                  });
                },
              },
            }
          : {}),
        data: { hideCopyButton: true },
      }),
    );
  };

  const choose = async (link: PeerLinkSummary) => {
    setStage({ kind: "checking", link });
    const result = await summarize({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    if (result._tag === "Failure") {
      onClose();
      if (!isAtomCommandInterrupted(result)) fail(link, squashAtomCommandFailure(result));
      return;
    }
    const summary = result.value;
    // Nothing to carry: there is no question to ask.
    if (summary.fileCount === 0 && summary.deletionCount === 0) {
      await run(link, "skip");
      return;
    }
    setStage({ kind: "ask", link, summary });
  };

  if (stage.kind === "ask" || (stage.kind === "running" && stage.mode === "transfer")) {
    const summary = stage.kind === "ask" ? stage.summary : null;
    return (
      <AlertDialog open onOpenChange={(open) => !open && !busy && onClose()}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Transfer the current work files too?</AlertDialogTitle>
            <AlertDialogDescription>
              {summary === null
                ? `Sending the work files to ${stage.link.label}…`
                : (summary.refusal ?? workFilesDescription(summary))}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={busy} />}>
              Cancel
            </AlertDialogClose>
            <Button variant="outline" disabled={busy} onClick={() => void run(stage.link, "skip")}>
              Continue without files
            </Button>
            <Button
              disabled={busy || summary?.refusal != null}
              onClick={() => void run(stage.link, "transfer")}
            >
              {busy ? "Transferring…" : "Transfer files"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    );
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Continue on another machine</AlertDialogTitle>
          <AlertDialogDescription>
            {busy
              ? `Starting a thread on ${stage.link.label}…`
              : links.isPending
                ? "Checking your linked machines…"
                : reachable.length === 0
                  ? "None of this machine's linked machines answers now. Link one in Settings → Connections."
                  : "A new thread there starts from this conversation, in the same repository. This thread stays as it is."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {!busy && reachable.length > 0 ? (
          <div className="flex flex-col gap-2 px-6 pb-2">
            {reachable.map((link) => (
              <Button key={link.environmentId} variant="outline" onClick={() => void choose(link)}>
                {link.label}
              </Button>
            ))}
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" disabled={busy} />}>
            Cancel
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
