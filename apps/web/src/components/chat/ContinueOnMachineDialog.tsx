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
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { formatBytes } from "~/lib/formatBytes";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { waitForThreadShell } from "~/state/entities";
import { readEnvironment } from "~/state/environments";
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
import { afterContinuedThreadWait, continuedThreadFollowThrough } from "./continueOnMachine.logic";
import { continueOnMachineThreadAtom } from "./continueOnMachineDialogState";

/** A new thread reaches this window over the target's own connection, which may be reconnecting. */
const CONTINUED_THREAD_WAIT_MS = 15_000;

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
  return `${files}${deletions} (${formatBytes(summary.totalBytes)}) from ${summary.directory}. Every changed and new file goes, secrets included. Ignored files, node_modules, and build output stay on this machine.`;
}

function ContinueOnMachineDialog({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const navigate = useNavigate();
  const router = useRouter();
  const links = useEnvironmentQuery(
    peerLinkEnvironment.list({ environmentId: threadRef.environmentId, input: {} }),
  );
  const summarize = useAtomCommand(peerLinkEnvironment.workFilesSummary, { reportFailure: false });
  const continueThread = useAtomCommand(peerLinkEnvironment.continueThread, {
    reportFailure: false,
  });
  const setEnvironmentEnabled = useAtomCommand(environmentCatalog.setEnabled, {
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
    const openThread = () =>
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(target) });
    // Opens the thread as a new local one opens, once this window's connection there has it.
    const openWhenItArrives = async () => {
      const location = router.latestLocation;
      const arrived = await waitForThreadShell(target, CONTINUED_THREAD_WAIT_MS);
      const next = afterContinuedThreadWait({
        arrived,
        movedOn: router.latestLocation !== location,
      });
      if (next === "open") {
        openThread();
        return;
      }
      toastManager.add(
        stackedThreadToast({
          type: arrived ? "info" : "warning",
          title: arrived
            ? `The thread on ${continued.label} is ready`
            : `The thread on ${continued.label} has not reached this window yet`,
          description: arrived
            ? "Open it when you're ready."
            : `Check ${continued.label} in Settings → Connections, then open it.`,
          actionProps: { children: "Open thread", onClick: openThread },
          data: { hideCopyButton: true },
        }),
      );
    };
    const turnOnAndOpen = async () => {
      const enabled = await setEnvironmentEnabled({
        environmentId: continued.environmentId,
        enabled: true,
      });
      if (enabled._tag === "Failure") {
        if (!isAtomCommandInterrupted(enabled)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `Could not turn on ${continued.label}`,
              description: failureMessage(squashAtomCommandFailure(enabled)),
            }),
          );
        }
        return;
      }
      await openWhenItArrives();
    };
    const saved = readEnvironment(continued.environmentId);
    const followThrough = continuedThreadFollowThrough({
      saved: saved === null ? null : { enabled: saved.entry.enabled },
      linkUrls: link.urls,
    });
    const picked =
      mode === "transfer"
        ? `A new thread there picked up this one, with ${continued.transferredFiles.toLocaleString()} work files.`
        : "A new thread there picked up this one.";
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: `Continued on ${continued.label}`,
        description:
          followThrough.kind === "open"
            ? picked
            : followThrough.kind === "turn-on"
              ? `${picked} Turn on ${continued.label} here to open it.`
              : `${picked} Connect this window to ${continued.label} to open it.`,
        ...(followThrough.kind === "turn-on"
          ? {
              actionProps: {
                children: `Turn on ${continued.label}`,
                onClick: () => void turnOnAndOpen(),
              },
            }
          : followThrough.kind === "connect"
            ? {
                actionProps: {
                  children: `Connect ${continued.label}`,
                  onClick: () =>
                    void navigate({
                      to: "/settings/connections",
                      search: followThrough.host === null ? {} : { connect: followThrough.host },
                    }),
                },
              }
            : {}),
        data: { hideCopyButton: true },
      }),
    );
    if (followThrough.kind === "open") await openWhenItArrives();
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
