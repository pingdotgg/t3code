import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadHandoffNotice } from "@t3tools/client-runtime/state/peerLinks";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, MonitorUpIcon, TriangleAlertIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useEnvironmentIds } from "~/state/environments";
import { threadHandoffEnvironment } from "~/state/threadHandoff";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** Why the composer is closed while a thread moves away, or null when it is open. */
export function threadHandoffSendBlockReason(
  shell: Pick<EnvironmentThreadShell, "handoff"> | null | undefined,
): string | null {
  const handoff = shell?.handoff;
  if (handoff?.state === "departing") return `Moving to ${handoff.label}`;
  if (handoff?.state === "departed") return `Continues on ${handoff.label}`;
  return null;
}

/**
 * The banner for a thread's move to a linked environment: waiting (with
 * Cancel), under way, moved (with a link to it there when this client is
 * connected to that environment), or failed.
 */
export function useThreadHandoffBannerItem(
  shell: Pick<EnvironmentThreadShell, "environmentId" | "id" | "handoff"> | null | undefined,
): ComposerBannerStackItem | null {
  const navigate = useNavigate();
  const cancel = useAtomCommand(threadHandoffEnvironment.cancel, { label: "cancel thread move" });
  const [cancelling, setCancelling] = useState(false);
  const handoff = shell?.handoff ?? null;
  const environmentIds = useEnvironmentIds();
  const canOpenThere =
    handoff?.state === "departed" && environmentIds.includes(handoff.environmentId);
  return useMemo(() => {
    const notice = threadHandoffNotice(handoff);
    if (shell == null || handoff === null || notice === null) return null;
    const actions =
      handoff.state === "pending" ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={cancelling}
          onClick={() => {
            setCancelling(true);
            void cancel({ environmentId: shell.environmentId, input: { threadId: shell.id } }).then(
              (result) => {
                setCancelling(false);
                if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title: "Could not cancel the move",
                      description: String(squashAtomCommandFailure(result)),
                    }),
                  );
                }
              },
            );
          }}
        >
          {cancelling ? "Cancelling…" : "Keep it here"}
        </Button>
      ) : handoff.state === "departed" && canOpenThere ? (
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(
                scopeThreadRef(handoff.environmentId, handoff.threadId),
              ),
            })
          }
        >
          Open on {handoff.label}
          <ArrowUpRightIcon />
        </Button>
      ) : undefined;
    return {
      id: `thread-handoff:${shell.id}:${handoff.handoffId}:${handoff.state}`,
      variant: notice.tone,
      icon: notice.tone === "error" ? <TriangleAlertIcon /> : <MonitorUpIcon />,
      title: notice.title,
      ...(notice.detail === null ? {} : { description: notice.detail }),
      ...(actions === undefined ? {} : { actions }),
    };
  }, [canOpenThere, cancel, cancelling, handoff, navigate, shell]);
}
