import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { useAtomValue } from "@effect/atom-react";
import { useParams } from "@tanstack/react-router";
import type {
  DesktopDiscordPresence,
  EnvironmentId,
  OrchestrationV2ThreadShell,
  ServerProvider,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "../hooks/useStableCallback";
import { isElectron } from "../env";
import { useClientSettings, useClientSettingsHydrated } from "../hooks/useSettings";
import { deriveProviderInstanceEntries } from "../providerInstances";
import { useConnectedEnvironmentIds, useEnvironmentProviders } from "../state/environments";
import { environmentShell } from "../state/shell";
import { getTriggerDisplayModelName } from "./chat/providerIconUtils";
import { resolveSidebarThreadStatus } from "./Sidebar.logic";

interface EnvironmentPresenceCounts {
  readonly working: number;
  readonly attention: number;
}

interface ActiveThreadPresence {
  readonly projectName: string | null;
  readonly modelLabel: string | null;
}

const EMPTY_ACTIVE: ActiveThreadPresence = { projectName: null, modelLabel: null };

/** Same resolution the sidebar uses: provider entry → model slug → display label. */
function resolveModelLabel(
  providers: ReadonlyArray<ServerProvider> | null,
  thread: Pick<OrchestrationV2ThreadShell, "providerInstanceId" | "modelSelection">,
): string | null {
  if (providers === null) return null;
  const entry = deriveProviderInstanceEntries(providers).find(
    (candidate) => candidate.instanceId === thread.providerInstanceId,
  );
  const model = entry?.models.find((candidate) => candidate.slug === thread.modelSelection.model);
  if (model !== undefined) return getTriggerDisplayModelName(model, entry?.driverKind);
  return thread.modelSelection.model.length > 0 ? thread.modelSelection.model : null;
}

export function DiscordPresenceCoordinator() {
  const enabled = useClientSettings((settings) => settings.discordRichPresenceEnabled);
  const hydrated = useClientSettingsHydrated();
  const environmentIds = useConnectedEnvironmentIds();
  const providersByEnvironment = useEnvironmentProviders();
  const { environmentId: activeEnvironmentId, threadId: activeThreadId } = useParams({
    strict: false,
  });
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const pushAvailable = typeof bridge?.setDiscordPresence === "function";
  const active = isElectron && hydrated && enabled;
  const [counts, setCounts] = useState<ReadonlyMap<EnvironmentId, EnvironmentPresenceCounts>>(
    () => new Map(),
  );
  const [activeThread, setActiveThread] = useState<ActiveThreadPresence>(EMPTY_ACTIVE);
  const lastPublished = useRef<DesktopDiscordPresence | null>(null);
  const hasActiveEnvironment = environmentIds.some((id) => id === activeEnvironmentId);
  if (!hasActiveEnvironment && activeThread !== EMPTY_ACTIVE) {
    setActiveThread(EMPTY_ACTIVE);
  }

  const reportCounts = useStableCallback(
    (environmentId: EnvironmentId, next: EnvironmentPresenceCounts) => {
      setCounts((current) => {
        const previous = current.get(environmentId);
        if (previous?.working === next.working && previous.attention === next.attention) {
          return current;
        }
        const updated = new Map(current);
        updated.set(environmentId, next);
        return updated;
      });
    },
  );

  const reportActiveThread = useStableCallback((next: ActiveThreadPresence) => {
    setActiveThread((current) =>
      current.projectName === next.projectName && current.modelLabel === next.modelLabel
        ? current
        : next,
    );
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Publishes the summary to the desktop Discord IPC bridge.
  useEffect(() => {
    if (!pushAvailable) return;
    if (!active) {
      // Only clear what we published; a fresh mount has nothing to clear.
      if (lastPublished.current === null) return;
      lastPublished.current = null;
      void bridge?.setDiscordPresence?.(null).catch(() => undefined);
      return;
    }
    let workingThreads = 0;
    let attentionThreads = 0;
    for (const environmentId of environmentIds) {
      const value = counts.get(environmentId);
      if (value === undefined) continue;
      workingThreads += value.working;
      attentionThreads += value.attention;
    }
    const presence: DesktopDiscordPresence = {
      projectName: hasActiveEnvironment ? (activeThread.projectName?.slice(0, 64) ?? null) : null,
      modelLabel: hasActiveEnvironment ? (activeThread.modelLabel?.slice(0, 64) ?? null) : null,
      workingThreads: Math.min(999, workingThreads),
      attentionThreads: Math.min(999, attentionThreads),
    };
    const previous = lastPublished.current;
    if (
      previous !== null &&
      previous.projectName === presence.projectName &&
      previous.modelLabel === presence.modelLabel &&
      previous.workingThreads === presence.workingThreads &&
      previous.attentionThreads === presence.attentionThreads
    )
      return;
    lastPublished.current = presence;
    void bridge?.setDiscordPresence?.(presence).catch(() => undefined);
  }, [active, hasActiveEnvironment, activeThread, bridge, counts, environmentIds, pushAvailable]);

  if (!pushAvailable || !active) return null;

  return (
    <>
      {environmentIds.map((environmentId) => (
        <EnvironmentPresence
          key={environmentId}
          environmentId={environmentId}
          providers={providersByEnvironment.get(environmentId) ?? null}
          activeEnvironmentId={activeEnvironmentId ?? null}
          activeThreadId={activeThreadId ?? null}
          onCounts={reportCounts}
          onActiveThread={reportActiveThread}
        />
      ))}
    </>
  );
}

function EnvironmentPresence({
  environmentId,
  providers,
  activeEnvironmentId,
  activeThreadId,
  onCounts,
  onActiveThread,
}: {
  environmentId: EnvironmentId;
  providers: ReadonlyArray<ServerProvider> | null;
  activeEnvironmentId: string | null;
  activeThreadId: string | null;
  onCounts: (environmentId: EnvironmentId, counts: EnvironmentPresenceCounts) => void;
  onActiveThread: (presence: ActiveThreadPresence) => void;
}) {
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const snapshot =
    shell.status === "live" && Option.isSome(shell.snapshot) ? shell.snapshot.value : null;
  const threads = snapshot?.threads ?? null;
  const projects = snapshot?.projects ?? null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keeps the desktop presence summary in step with the environment shell subscription.
  useEffect(() => {
    if (threads === null) {
      onCounts(environmentId, { working: 0, attention: 0 });
      if (activeEnvironmentId === environmentId) onActiveThread(EMPTY_ACTIVE);
      return;
    }
    let working = 0;
    let attention = 0;
    for (const thread of threads) {
      if (thread.lineage.relationshipToParent === "subagent") continue;
      const status = resolveSidebarThreadStatus(presentThreadShell(environmentId, thread));
      if (status === "working") working += 1;
      else if (
        status === "input" ||
        status === "approval" ||
        status === "failed" ||
        status === "limited"
      )
        attention += 1;
    }
    onCounts(environmentId, { working, attention });
    if (activeEnvironmentId !== environmentId) return;
    const thread =
      activeThreadId === null ? undefined : threads.find((item) => item.id === activeThreadId);
    if (thread === undefined) {
      onActiveThread(EMPTY_ACTIVE);
      return;
    }
    const project = projects?.find((candidate) => candidate.id === thread.projectId);
    onActiveThread({
      projectName: project?.title ?? null,
      modelLabel: resolveModelLabel(providers, thread),
    });
  }, [
    activeEnvironmentId,
    activeThreadId,
    environmentId,
    onActiveThread,
    onCounts,
    projects,
    providers,
    threads,
  ]);

  return null;
}
