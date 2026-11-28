import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadHandoffClosesComposer } from "@t3tools/client-runtime/state/peerLinks";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useNavigate } from "@tanstack/react-router";
import { msg, useGT } from "gt-react";
import { ArrowUpRightIcon, MonitorUpIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { m, type MessageResolver } from "~/i18n/messages";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useConnectedEnvironmentIds } from "~/state/environments";
import {
  canMoveThreadsAtom,
  dismissedThreadHandoffsAtom,
  openThreadHandoffDialog,
  threadHandoffEnvironment,
} from "~/state/threadHandoff";
import { useAtomCommand } from "~/state/use-atom-command";
import { linkedThreadRouteParams } from "../../linkedThreadSurface";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

type HandoffShell = Pick<EnvironmentThreadShell, "environmentId" | "id" | "handoff">;

/** Why the composer is closed while a thread moves away, or null when it is open. */
export function threadHandoffSendBlockReason(
  shell: Pick<EnvironmentThreadShell, "handoff"> | null | undefined,
  resolve: MessageResolver = m,
): string | null {
  const handoff = shell?.handoff;
  if (!threadHandoffClosesComposer(handoff)) return null;
  return handoff.state === "departing"
    ? resolve(msg("Moving to {machine}", { machine: handoff.label }))
    : resolve(msg("Continues on {machine}", { machine: handoff.label }));
}

/**
 * The notice for a thread's move to a linked machine: waiting (with a way to keep it here),
 * under way, moved (with a way to open it there), or failed (with a way to try again).
 */
export function useThreadHandoffBannerItem(
  shell: HandoffShell | null | undefined,
): ComposerBannerStackItem | null {
  const gt = useGT();
  const navigate = useNavigate();
  const cancel = useAtomCommand(threadHandoffEnvironment.cancel, { reportFailure: false });
  const [cancelling, setCancelling] = useState(false);
  const connected = useConnectedEnvironmentIds();
  const dismissed = useAtomValue(dismissedThreadHandoffsAtom);
  const canMove = useAtomValue(
    canMoveThreadsAtom(shell?.environmentId ?? ("" as HandoffShell["environmentId"])),
  );
  const handoff = shell?.handoff ?? null;
  if (shell == null || handoff === null) return null;
  const machine = handoff.label;
  const id = `thread-handoff:${shell.id}:${handoff.handoffId}:${handoff.state}`;
  const icon = <MonitorUpIcon />;
  switch (handoff.state) {
    case "pending":
      return {
        id,
        variant: "info",
        icon,
        title: gt("Moving to {machine} when this turn ends", { machine }),
        description: gt("Sending a message keeps it here instead."),
        actions: (
          <Button
            size="xs"
            variant="ghost"
            disabled={cancelling || !canMove}
            onClick={() => {
              setCancelling(true);
              void cancel({
                environmentId: shell.environmentId,
                input: { threadId: shell.id },
              }).then((result) => {
                setCancelling(false);
                if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
                const error = squashAtomCommandFailure(result);
                toastManager.add(
                  stackedThreadToast({
                    type: "error",
                    title: gt("Could not cancel the move"),
                    ...(error instanceof Error ? { description: error.message } : {}),
                  }),
                );
              });
            }}
          >
            {gt("Keep it here")}
          </Button>
        ),
      };
    case "departing":
      return { id, variant: "info", icon, title: gt("Moving to {machine}…", { machine }) };
    case "departed": {
      const there = scopeThreadRef(handoff.environmentId, handoff.threadId);
      return {
        id,
        variant: "info",
        icon,
        title: gt("This thread continues on {machine}", { machine }),
        description: gt("This copy is read-only."),
        actions: (
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              // Without a connection to that machine, this one reads the thread over its link.
              void (connected.includes(handoff.environmentId)
                ? navigate({
                    to: "/$environmentId/$threadId",
                    params: buildThreadRouteParams(there),
                  })
                : navigate({
                    to: "/linked/$viaEnvironmentId/$linkedEnvironmentId/$linkedThreadId",
                    params: linkedThreadRouteParams({
                      viaEnvironmentId: shell.environmentId,
                      ...there,
                    }),
                  }))
            }
          >
            {gt("Open on {machine}", { machine })}
            <ArrowUpRightIcon />
          </Button>
        ),
      };
    }
    case "failed":
      if (dismissed.has(handoff.handoffId)) return null;
      return {
        id,
        variant: "error",
        icon: <TriangleAlertIcon />,
        title: gt("Could not move to {machine}", { machine }),
        description: handoff.lastError,
        ...(canMove
          ? {
              actions: (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    openThreadHandoffDialog(scopeThreadRef(shell.environmentId, shell.id))
                  }
                >
                  {gt("Try again")}
                </Button>
              ),
            }
          : {}),
        dismissLabel: gt("Dismiss"),
        onDismiss: () =>
          appAtomRegistry.set(
            dismissedThreadHandoffsAtom,
            new Set([...dismissed, handoff.handoffId]),
          ),
      };
  }
}
