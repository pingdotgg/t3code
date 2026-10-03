import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { findSandboxForWorktree } from "@t3tools/client-runtime/state/vcs";
import type { EnvironmentId, SandboxPort, SandboxStatus, ThreadId } from "@t3tools/contracts";
import { BoxIcon, SquareIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";

import { resolveDiscoveredServerUrl } from "../../browser/browserTargetResolver";
import { useOpenLink } from "../../browser/useOpenLink";
import { readLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

const SANDBOX_STATUS_LABELS: Record<SandboxStatus, string> = {
  starting: "Starting",
  running: "Running",
  stopped: "Stopped",
  error: "Error",
};

const REMOVE_SANDBOX_CONFIRMATION = [
  "Remove the sandbox for this worktree?",
  "This deletes its container, services, and machine state. The worktree files stay.",
  "Later work in this worktree runs on the host.",
].join("\n");

/**
 * Thread details row for a thread whose worktree runs in a Docker sandbox.
 * Renders nothing for other threads. Mount it only for servers that can run
 * sandboxes: it subscribes to the environment's sandboxes while mounted and
 * the thread has a worktree.
 */
export function ThreadSandboxControl({
  environmentId,
  threadId,
  worktreePath,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  worktreePath: string | null;
}) {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const sandboxesQuery = useEnvironmentQuery(
    worktreePath !== null ? vcsEnvironment.sandboxes({ environmentId, input: {} }) : null,
  );
  const sandbox = findSandboxForWorktree(sandboxesQuery.data?.sandboxes, worktreePath);
  const stopSandbox = useAtomCommand(vcsEnvironment.stopSandbox, { reportFailure: false });
  const removeSandbox = useAtomCommand(vcsEnvironment.removeSandbox, { reportFailure: false });
  const openLink = useOpenLink(threadRef);
  const [pending, setPending] = useState(false);

  if (!sandbox) return null;

  const runAction = async (action: "stop" | "remove") => {
    if (action === "remove") {
      const confirmed = await readLocalApi()?.dialogs.confirm(REMOVE_SANDBOX_CONFIRMATION, {
        variant: "destructive",
      });
      if (!confirmed) return;
    }
    setPending(true);
    const command = action === "stop" ? stopSandbox : removeSandbox;
    const result = await command({
      environmentId,
      input: { worktreePath: sandbox.worktreePath },
    });
    setPending(false);
    if (result._tag === "Success") return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: action === "stop" ? "Could not stop sandbox" : "Could not remove sandbox",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  };

  const openPort = (port: SandboxPort) => {
    // The forwarded port listens on the server's loopback; remote clients need
    // the environment's own route to it.
    const url = resolveDiscoveredServerUrl(environmentId, `http://127.0.0.1:${port.hostPort}`);
    void openLink(url).catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not open port",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  };

  return (
    <Menu>
      <MenuTrigger render={<ThreadDetailsControl size="sm" variant="ghost" aria-label="Sandbox" />}>
        <BoxIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        <span className="min-w-0 flex-1 truncate">Sandbox</span>
        {sandbox.status !== "running" ? (
          <span
            className={
              sandbox.status === "error"
                ? "shrink-0 text-3xs font-normal text-destructive-foreground"
                : "shrink-0 text-3xs font-normal text-muted-foreground/70"
            }
          >
            {SANDBOX_STATUS_LABELS[sandbox.status]}
          </span>
        ) : null}
      </MenuTrigger>
      <MenuPopup align="end" className="w-(--anchor-width)">
        <MenuGroup>
          <MenuGroupLabel>{SANDBOX_STATUS_LABELS[sandbox.status]}</MenuGroupLabel>
          {sandbox.status === "error" && sandbox.error ? (
            <p className="px-2 pb-1 text-xs text-destructive-foreground">{sandbox.error}</p>
          ) : null}
        </MenuGroup>
        {sandbox.ports.length > 0 ? (
          <MenuGroup>
            <MenuGroupLabel>Ports</MenuGroupLabel>
            {sandbox.ports.map((port) => (
              <MenuItem key={port.containerPort} onClick={() => openPort(port)}>
                <span className="font-mono text-xs">
                  :{port.containerPort} → 127.0.0.1:{port.hostPort}
                </span>
              </MenuItem>
            ))}
          </MenuGroup>
        ) : null}
        <MenuSeparator />
        <MenuItem
          disabled={pending || sandbox.status === "stopped"}
          onClick={() => void runAction("stop")}
        >
          <SquareIcon />
          Stop sandbox
        </MenuItem>
        <MenuItem variant="destructive" disabled={pending} onClick={() => void runAction("remove")}>
          <Trash2Icon />
          Remove sandbox
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
