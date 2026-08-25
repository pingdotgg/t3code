/**
 * Opening a report is opening a conversation about it. The user's most recent
 * conversation for the report wins; when there is none, a fresh empty thread
 * is created and no turn is started.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type EnvironmentId,
  type PostHogReport,
  type PostHogReportArtefact,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useEffectEvent, useMemo, useState } from "react";

import { newThreadId } from "../../lib/utils";
import { useReportSeenStore } from "../../reportSeenStore";
import { useProjects, useThreadShells } from "../../state/entities";
import { postHogEnvironment } from "../../state/posthog";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerSettingsAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { Project, ThreadShell } from "../../types";
import { readReportArtefacts } from "./reportArtefacts";

/** The report's live conversations, most recently updated first. */
export function reportThreads(
  threads: ReadonlyArray<ThreadShell>,
  reportId: string,
): ReadonlyArray<ThreadShell> {
  return threads
    .filter((thread) => thread.reportId === reportId && thread.archivedAt === null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * The repository a report's conversation should run in: the one whose remote
 * matches the report's `repo_selection`, or the only one there is.
 */
export function resolveReportProject(
  projects: ReadonlyArray<Project>,
  repository: string | null | undefined,
): Project | null {
  if (projects.length === 1) return projects[0] ?? null;
  const wanted = repository?.toLowerCase() ?? null;
  if (wanted === null) return null;
  return (
    projects.find((project) => {
      const identity = project.repositoryIdentity;
      return (
        identity?.owner !== undefined &&
        identity.name !== undefined &&
        `${identity.owner}/${identity.name}`.toLowerCase() === wanted
      );
    }) ?? null
  );
}

export interface ReportOpener {
  /** Open the report's most recent conversation, or start a fresh one. */
  readonly openReport: (report: PostHogReport, options?: { readonly forceNew?: boolean }) => void;
  /** The report currently being resolved into a conversation, if any. */
  readonly openingReportId: string | null;
  readonly error: string | null;
}

export function useReportOpener(environmentId: EnvironmentId | null): ReportOpener {
  const navigate = useNavigate();
  const projects = useProjects();
  const threads = useThreadShells();
  const serverSettings = useAtomValue(primaryServerSettingsAtom);
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const markSeen = useReportSeenStore((state) => state.markSeen);
  const [pending, setPending] = useState<PostHogReport | null>(null);
  const [awaiting, setAwaiting] = useState<{
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadShell["id"];
    readonly reportId: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const environmentProjects = useMemo(
    () => projects.filter((project) => project.environmentId === environmentId),
    [environmentId, projects],
  );

  // A brand new conversation needs the report's repo selection, which only the
  // artefacts carry. Reopening an existing one does not, so the common path
  // never waits on this fetch.
  const artefactsQuery = useEnvironmentQuery(
    pending !== null && environmentId !== null
      ? postHogEnvironment.artefacts({ environmentId, input: { reportId: pending.id } })
      : null,
  );

  const goToThread = useCallback(
    (threadEnvironmentId: EnvironmentId, threadId: ThreadShell["id"]) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(threadEnvironmentId, threadId)),
      });
    },
    [navigate],
  );

  const openReport = useCallback(
    (report: PostHogReport, options?: { readonly forceNew?: boolean }) => {
      if (environmentId === null || pending !== null || awaiting !== null) return;
      setError(null);
      markSeen(report.id, report.updated_at);
      if (options?.forceNew !== true) {
        const existing = reportThreads(threads, report.id)[0];
        if (existing) {
          goToThread(existing.environmentId, existing.id);
          return;
        }
      }
      setPending(report);
    },
    [awaiting, environmentId, goToThread, markSeen, pending, threads],
  );

  const resolveIntoThread = useEffectEvent(
    (report: PostHogReport, artefacts: ReadonlyArray<PostHogReportArtefact>) => {
      if (environmentId === null) return;
      const { repoSelection } = readReportArtefacts(artefacts);
      const project = resolveReportProject(environmentProjects, repoSelection?.repository);
      if (project === null) {
        setPending(null);
        setError(
          environmentProjects.length === 0
            ? "Add a repository in Settings before opening a report."
            : "No repository matches this report. Pick one in Settings, then try again.",
        );
        return;
      }

      const instanceId =
        project.defaultModelSelection?.instanceId ??
        serverSettings.textGenerationModelSelection.instanceId;
      // Legacy instance ids equal their driver kind; explicit instances name it.
      const driverKind =
        serverSettings.providerInstances[instanceId]?.driver ??
        (instanceId as string as ProviderDriverKind);
      const modelSelection =
        project.defaultModelSelection ??
        createModelSelection(instanceId, DEFAULT_MODEL_BY_PROVIDER[driverKind] ?? DEFAULT_MODEL);
      const threadId = newThreadId();

      void (async () => {
        const result = await createThread({
          environmentId,
          input: {
            threadId,
            projectId: project.id,
            title: report.title,
            modelSelection,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            reportId: report.id,
            createdAt: new Date().toISOString(),
          },
        });
        setPending(null);
        if (result._tag === "Failure") {
          setError("Could not start a conversation for this report.");
          return;
        }
        setAwaiting({ environmentId, threadId, reportId: report.id });
      })();
    },
  );

  // The thread route treats a thread whose shell has not synced yet as
  // missing and bounces to the inbox, so navigation waits for the shell.
  useEffect(() => {
    if (awaiting === null) return;
    if (threads.some((thread) => thread.id === awaiting.threadId)) {
      setAwaiting(null);
      goToThread(awaiting.environmentId, awaiting.threadId);
      return;
    }
    const timer = setTimeout(() => {
      setAwaiting(null);
      setError(
        "The conversation was created but has not synced yet. Try opening the report again.",
      );
    }, 10_000);
    return () => clearTimeout(timer);
  }, [awaiting, goToThread, threads]);

  useEffect(() => {
    if (pending === null || artefactsQuery.isPending) return;
    resolveIntoThread(pending, artefactsQuery.data?.artefacts ?? []);
  }, [artefactsQuery.data, artefactsQuery.isPending, pending]);

  return { openReport, openingReportId: pending?.id ?? awaiting?.reportId ?? null, error };
}
