import { appAtomRegistry } from "../state/atom-registry";
import { environmentProjects } from "../state/projects";
import { environmentServerConfigsAtom } from "../state/server";
import { threadOutboxManager } from "../state/thread-outbox";
import { environmentThreadShells } from "../state/threads";
import type { AgentActivityWidgetProps } from "./AgentActivityWidget";
import { buildWidgetUnsettledRows } from "./agentActivityWidgetThreads";

export function readWidgetUnsettledRows(excluded: AgentActivityWidgetProps["activities"]) {
  return buildWidgetUnsettledRows({
    threads: appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
    projects: appAtomRegistry.get(environmentProjects.projectsAtom),
    settlementEnvironmentIds: new Set(appAtomRegistry.get(environmentServerConfigsAtom).keys()),
    queuedThreadKeys: new Set(
      Object.entries(appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom))
        .filter(([, messages]) => messages.length > 0)
        .map(([key]) => key),
    ),
    now: new Date().toISOString(),
    excluded,
  });
}
