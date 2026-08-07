/**
 * Processes right-panel surface: cards for the dev servers running in this
 * thread — started in its terminals or by its coding agent — discovered by
 * the server's port scanner. Each card can open the server in the browser
 * preview or kill the process.
 *
 * Only thread-owned servers show up here — the server refuses to signal PIDs
 * outside the thread's terminal process trees and agent session tree.
 */
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  DiscoveredLocalServer,
  ScopedThreadRef,
  ThreadOwnedProcess,
} from "@t3tools/contracts";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import { Activity, Globe2, Square } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { resolveDiscoveredServerUrl } from "~/browser/browserTargetResolver";
import { useThreadDiscoveredPorts, useThreadOwnedProcesses } from "~/portDiscoveryState";
import { formatProcessCommand } from "~/processCommandLabel";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import { openDiscoveredPort } from "./preview/openDiscoveredPort";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { toastManager } from "./ui/toast";

interface ProcessesPanelProps {
  threadRef: ScopedThreadRef | null;
}

function serverKey(server: DiscoveredLocalServer): string {
  return `${server.host}:${server.port}:${server.pid ?? "unknown"}`;
}

function ProcessCard(props: { threadRef: ScopedThreadRef; server: DiscoveredLocalServer }) {
  const { threadRef, server } = props;
  const [stopping, setStopping] = useState(false);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const killServer = useAtomCommand(previewEnvironment.killDiscoveredServer, {
    reportFailure: false,
  });

  const handleOpen = useCallback(() => {
    if (!isPreviewSupportedInRuntime()) {
      window.open(resolveDiscoveredServerUrl(threadRef.environmentId, server.url), "_blank");
      return;
    }
    void (async () => {
      const result = await openDiscoveredPort({ threadRef, port: server, openPreview });
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Unable to open preview",
        description: error instanceof Error ? error.message : "The preview could not be opened.",
      });
    })();
  }, [openPreview, server, threadRef]);

  const handleKill = useCallback(() => {
    const pid = server.pid;
    if (pid === null) return;
    setStopping(true);
    void (async () => {
      const result = await killServer({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, pid, port: server.port },
      });
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
      setStopping(false);
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Unable to stop process",
        description: error instanceof Error ? error.message : "The process could not be stopped.",
      });
    })();
  }, [killServer, server.pid, server.port, threadRef]);

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/80 bg-card p-3 dark:border-transparent dark:shadow-none dark:inset-ring-1 dark:inset-ring-white/5">
      <span className="relative inline-flex size-2 shrink-0">
        <span className="absolute inset-0 animate-status-ping rounded-full bg-success opacity-60" />
        <span className="relative inline-flex size-2 rounded-full bg-success" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">
          {server.processName ?? "Dev server"}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {server.host}:{server.port}
          {server.terminal ? ` · ${getTerminalLabel(server.terminal.terminalId)}` : ""}
          {!server.terminal && server.agent ? " · Agent" : ""}
          {server.pid !== null ? ` · PID ${server.pid}` : ""}
        </span>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Open ${server.host}:${server.port}`}
        onClick={handleOpen}
      >
        <Globe2 className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Stop ${server.processName ?? "dev server"} on port ${server.port}`}
        disabled={server.pid === null || stopping}
        onClick={handleKill}
      >
        <Square className="size-3.5 text-destructive" />
      </Button>
    </div>
  );
}

function ownerLabel(entry: ThreadOwnedProcess): string {
  return entry.owner === "agent" ? "Agent" : "Terminal";
}

function ThreadProcessRow(props: { threadRef: ScopedThreadRef; entry: ThreadOwnedProcess }) {
  const { threadRef, entry } = props;
  const [stopping, setStopping] = useState(false);
  const killServer = useAtomCommand(previewEnvironment.killDiscoveredServer, {
    reportFailure: false,
  });

  const handleKill = useCallback(() => {
    setStopping(true);
    void (async () => {
      const result = await killServer({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, pid: entry.pid },
      });
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
      setStopping(false);
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Unable to stop process",
        description: error instanceof Error ? error.message : "The process could not be stopped.",
      });
    })();
  }, [entry.pid, killServer, threadRef]);

  const label = formatProcessCommand({
    commandLine: entry.commandLine ?? null,
    processName: entry.processName,
  });
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/80 bg-card px-3 py-2 dark:border-transparent dark:shadow-none dark:inset-ring-1 dark:inset-ring-white/5">
      <span className="size-1.5 shrink-0 rounded-full bg-info" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-foreground" title={entry.commandLine ?? label}>
          {label}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {ownerLabel(entry)}
          {entry.processName ? ` · ${entry.processName}` : ""} · PID {entry.pid}
        </span>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Stop ${entry.processName ?? "process"} (PID ${entry.pid})`}
        disabled={stopping}
        onClick={handleKill}
      >
        <Square className="size-3.5 text-destructive" />
      </Button>
    </div>
  );
}

export function ProcessesPanel({ threadRef }: ProcessesPanelProps) {
  const servers = useThreadDiscoveredPorts({
    environmentId: threadRef?.environmentId ?? null,
    threadId: threadRef?.threadId ?? null,
  });
  const ownedProcesses = useThreadOwnedProcesses({
    environmentId: threadRef?.environmentId ?? null,
    threadId: threadRef?.threadId ?? null,
  });
  // A dev server already has a richer card above — don't repeat its pid row.
  const backgroundProcesses = useMemo(() => {
    const serverPids = new Set(
      servers.map((server) => server.pid).filter((pid): pid is number => pid !== null),
    );
    return ownedProcesses.filter((entry) => !serverPids.has(entry.pid));
  }, [ownedProcesses, servers]);

  if (!threadRef || (servers.length === 0 && backgroundProcesses.length === 0)) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <Activity className="mx-auto mb-3 size-5 text-muted-foreground" />
          <h3 className="text-sm font-medium text-foreground">No running processes</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Processes started in this thread&apos;s terminals or by its agent appear here — dev
            servers with a preview link, everything else with a stop button. All of them are stopped
            when the thread is deleted.
          </p>
        </div>
      </div>
    );
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col gap-2 p-3">
        {servers.map((server) => (
          <ProcessCard key={serverKey(server)} threadRef={threadRef} server={server} />
        ))}
        {backgroundProcesses.length > 0 ? (
          <>
            {servers.length > 0 ? (
              <span className="mt-2 px-1 text-xs font-medium text-muted-foreground">
                Other processes
              </span>
            ) : null}
            {backgroundProcesses.map((entry) => (
              <ThreadProcessRow
                key={`${entry.owner}:${entry.pid}`}
                threadRef={threadRef}
                entry={entry}
              />
            ))}
          </>
        ) : null}
      </div>
    </ScrollArea>
  );
}

export default ProcessesPanel;
