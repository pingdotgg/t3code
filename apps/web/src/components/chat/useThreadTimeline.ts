import { scopeProjectRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  MessageId,
  ScopedThreadRef,
  ServerProvider,
  ServerProviderSkill,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { useMemo } from "react";

import { useTheme } from "../../hooks/useTheme.ts";
import { useClientSettings } from "../../hooks/useSettings.ts";
import { useTurnDiffSummaries } from "../../hooks/useTurnDiffSummaries.ts";
import {
  deriveActiveWorkStartedAt,
  deriveTimelineEntries,
  deriveWorkLogEntries,
  isLatestTurnSettled,
} from "../../session-logic.ts";
import { useProject, useServerConfigs } from "../../state/entities.ts";
import type { ChatMessage, Thread, TurnDiffSummary } from "../../types.ts";
import type { TimelineLatestTurn } from "./MessagesTimeline.logic.ts";

const EMPTY_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];
const EMPTY_PROVIDERS: ServerProvider[] = [];

export type UseThreadTimelineInput = {
  readonly threadRef: ScopedThreadRef;
  readonly thread: Thread | null | undefined;
  readonly timelineMessages: ReadonlyArray<ChatMessage>;
  readonly resolvedTheme?: "light" | "dark";
  readonly timestampFormat?: TimestampFormat;
  readonly skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  readonly workspaceRoot?: string | undefined;
  readonly markdownCwd?: string | undefined;
  readonly isWorking?: boolean;
  readonly activeTurnInProgress?: boolean;
  readonly activeTurnStartedAt?: string | null;
  readonly sendStartedAt?: string | null;
};

export function useThreadTimeline(input: UseThreadTimelineInput) {
  const timestampFormatFromSettings = useClientSettings((settings) => settings.timestampFormat);
  const { resolvedTheme: themeFromHook } = useTheme();
  const resolvedTheme = input.resolvedTheme ?? themeFromHook;
  const timestampFormat = input.timestampFormat ?? timestampFormatFromSettings;

  const thread = input.thread;
  const threadRef = input.threadRef;
  const routeThreadKey = useMemo(() => scopedThreadKey(threadRef), [threadRef]);

  const project = useProject(
    thread ? scopeProjectRef(thread.environmentId, thread.projectId) : null,
  );
  const serverConfigs = useServerConfigs();
  const providerStatuses = useMemo(
    () => serverConfigs.get(threadRef.environmentId)?.providers ?? EMPTY_PROVIDERS,
    [serverConfigs, threadRef.environmentId],
  );

  const derivedMarkdownCwd = useMemo(() => {
    if (!thread || !project) {
      return undefined;
    }
    return projectScriptCwd({
      project: { cwd: project.workspaceRoot },
      worktreePath: thread.worktreePath ?? null,
    });
  }, [project, thread]);

  const derivedWorkspaceRoot = thread?.worktreePath ?? project?.workspaceRoot ?? undefined;

  const markdownCwd = input.markdownCwd ?? derivedMarkdownCwd ?? undefined;
  const workspaceRoot = input.workspaceRoot ?? derivedWorkspaceRoot;

  const derivedSkills = useMemo(() => {
    if (!thread) {
      return EMPTY_SKILLS;
    }
    const instanceId = thread.modelSelection.instanceId;
    return (
      providerStatuses.find((provider) => provider.instanceId === instanceId)?.skills ??
      EMPTY_SKILLS
    );
  }, [providerStatuses, thread]);

  const skills = input.skills ?? derivedSkills;

  const workLogEntries = useMemo(
    () => deriveWorkLogEntries(thread?.activities ?? []),
    [thread?.activities],
  );

  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntries(input.timelineMessages, thread?.proposedPlans ?? [], workLogEntries),
    [input.timelineMessages, thread?.proposedPlans, workLogEntries],
  );

  const latestTurn: TimelineLatestTurn | null = thread?.latestTurn ?? null;
  const session = thread?.session ?? null;
  const latestTurnSettled = isLatestTurnSettled(latestTurn, session);

  const sessionIsWorking = session?.status === "running" || session?.status === "starting";

  const isWorking = input.isWorking ?? sessionIsWorking;
  const activeTurnInProgress = input.activeTurnInProgress ?? (isWorking || !latestTurnSettled);
  const activeTurnStartedAt =
    input.activeTurnStartedAt ??
    deriveActiveWorkStartedAt(latestTurn, session, input.sendStartedAt ?? null);

  const runningTurnId = session?.status === "running" ? (session.activeTurnId ?? null) : null;

  const { turnDiffSummaries } = useTurnDiffSummaries(thread);

  const turnDiffSummaryByAssistantMessageId = useMemo(() => {
    const byMessageId = new Map<MessageId, TurnDiffSummary>();
    for (const summary of turnDiffSummaries) {
      if (!summary.assistantMessageId) continue;
      byMessageId.set(summary.assistantMessageId, summary);
    }
    return byMessageId;
  }, [turnDiffSummaries]);

  const activeThreadEnvironmentId = threadRef.environmentId;

  return {
    timelineEntries,
    latestTurn,
    runningTurnId,
    isWorking,
    activeTurnInProgress,
    activeTurnStartedAt,
    turnDiffSummaryByAssistantMessageId,
    markdownCwd,
    workspaceRoot,
    resolvedTheme,
    timestampFormat,
    skills,
    routeThreadKey,
    activeThreadEnvironmentId,
  };
}
