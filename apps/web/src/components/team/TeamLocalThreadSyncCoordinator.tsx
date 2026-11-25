import { resolveProjectTeamAssignment } from "@t3tools/client-runtime/team";
import type {
  EnvironmentId,
  TeamSyncLocalThreadInput,
  TeamThreadNoteId,
  ThreadId,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { msg } from "gt-react";
import { StickyNoteIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { getClientSettings } from "~/hooks/useSettings";
import { m } from "~/i18n/messages";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useProjects, useThreadShells } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { teamEnvironment, useTeamStatesByEnvironment } from "~/state/team";
import { environmentThreadStateAtom } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
} from "~/threadNotifications";
import { toastManager } from "../ui/toast";

function buildLocalSyncPayload(input: {
  readonly localEnvironmentId: EnvironmentId;
  readonly localEnvironmentLabel: string;
  readonly teamProjectId: TeamSyncLocalThreadInput["projectId"];
  readonly defaultViewId: TeamSyncLocalThreadInput["viewId"];
  readonly shell: ReturnType<typeof useThreadShells>[number];
}): TeamSyncLocalThreadInput {
  const { localEnvironmentId, localEnvironmentLabel, teamProjectId, defaultViewId, shell } = input;
  const detailResult = appAtomRegistry.get(
    environmentThreadStateAtom(localEnvironmentId, shell.id),
  );
  const detailState = AsyncResult.value(detailResult);
  const detail =
    Option.isSome(detailState) && Option.isSome(detailState.value.data)
      ? detailState.value.data.value
      : null;

  const runs: TeamSyncLocalThreadInput["runs"] = detail
    ? detail.runs.map((run) => ({
        id: run.id as string,
        ordinal: run.ordinal,
        status: run.status === "preparing" ? "starting" : run.status,
        userMessageId: (run.userMessageId ?? `msg:${run.id}`) as string,
        createdAt: DateTime.formatIso(run.requestedAt),
        completedAt: run.completedAt ? DateTime.formatIso(run.completedAt) : null,
      }))
    : shell.latestRun
      ? [
          {
            id: shell.latestRun.runId as string,
            ordinal: 1,
            status: shell.latestRun.status === "preparing" ? "starting" : shell.latestRun.status,
            userMessageId: `msg:${shell.latestRun.runId}`,
            createdAt: shell.latestRun.startedAt ?? shell.createdAt,
            completedAt: shell.latestRun.completedAt ?? null,
          },
        ]
      : [];

  const messages: TeamSyncLocalThreadInput["messages"] = detail
    ? detail.messages
        .filter(
          (message): message is typeof message & { role: "user" | "assistant" | "system" } =>
            message.role === "user" || message.role === "assistant" || message.role === "system",
        )
        .map((message) => ({
          id: message.id,
          role: message.role,
          text: message.text,
          runId: message.runId,
          createdAt: DateTime.formatIso(message.createdAt),
          updatedAt: DateTime.formatIso(message.updatedAt),
        }))
    : [];

  return {
    threadId: shell.id,
    projectId: teamProjectId,
    ...(defaultViewId ? { viewId: defaultViewId } : {}),
    executionEnvironmentId: localEnvironmentId,
    executionEnvironmentLabel: localEnvironmentLabel,
    title: shell.title.trim() || m(msg("Untitled thread")),
    branch: shell.branch,
    modelSelection: shell.modelSelection,
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
    createdAt: shell.createdAt,
    updatedAt: shell.updatedAt,
    runs,
    messages,
  };
}

/**
 * Coordinates two Milestone 5 background flows at app root:
 * 1. Mirrors local-environment team-project threads (metadata, runs, transcript) to their correlated Team Server.
 * 2. Fires owner notifications when a colleague leaves a new pending thread note.
 */
export function TeamLocalThreadSyncCoordinator() {
  const router = useRouter();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  const threadShells = useThreadShells();
  const teamStates = useTeamStatesByEnvironment();
  const syncLocalThread = useAtomCommand(teamEnvironment.syncLocalThread, { reportFailure: false });

  const syncedFingerprintByKeyRef = useRef(new Map<string, string>());
  const syncInFlightRef = useRef(new Set<string>());
  const pendingRetryByKeyRef = useRef(
    new Map<
      string,
      {
        readonly shell: ReturnType<typeof useThreadShells>[number];
        readonly teamEnvironmentId: EnvironmentId;
        readonly teamProjectId: TeamSyncLocalThreadInput["projectId"];
        readonly defaultViewId: TeamSyncLocalThreadInput["viewId"];
      }
    >(),
  );

  const seenNoteIdsRef = useRef(new Set<TeamThreadNoteId>());
  const initializedTeamEnvsRef = useRef(new Set<EnvironmentId>());

  // 1. Local-to-Team thread mirroring for local threads whose project correlates to a Team Server.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes local team-project thread snapshots to the remote Team Server when local shells or projections change
  useEffect(() => {
    if (!primaryEnvironmentId) return;
    const localEnv = environments.find((env) => env.environmentId === primaryEnvironmentId);
    const localLabel = localEnv?.label ?? "Local";
    const localProjectsById = new Map(
      projects
        .filter((project) => project.environmentId === primaryEnvironmentId)
        .map((project) => [project.id, project] as const),
    );
    const localTeamThreads: Array<{
      readonly shell: ReturnType<typeof useThreadShells>[number];
      readonly teamEnvironmentId: EnvironmentId;
      readonly teamProjectId: TeamSyncLocalThreadInput["projectId"];
      readonly defaultViewId: TeamSyncLocalThreadInput["viewId"];
    }> = [];

    for (const shell of threadShells) {
      if (shell.environmentId !== primaryEnvironmentId) continue;
      if (shell.deletedAt !== null || shell.archivedAt !== null) continue;
      const localProject = localProjectsById.get(shell.projectId);
      if (!localProject) continue;
      const assignment = resolveProjectTeamAssignment({ project: localProject, teamStates });
      if (!assignment || assignment.teamEnvironmentId === primaryEnvironmentId) continue;
      localTeamThreads.push({
        shell,
        teamEnvironmentId: assignment.teamEnvironmentId,
        teamProjectId: assignment.assignment.projectId,
        defaultViewId: assignment.assignment.defaultViewId ?? undefined,
      });
    }

    const triggerSync = (entry: (typeof localTeamThreads)[number]) => {
      const payload = buildLocalSyncPayload({
        localEnvironmentId: primaryEnvironmentId,
        localEnvironmentLabel: localLabel,
        teamProjectId: entry.teamProjectId,
        defaultViewId: entry.defaultViewId,
        shell: entry.shell,
      });
      const syncKey = `${entry.teamEnvironmentId}\0${entry.shell.id}`;
      const fingerprint = JSON.stringify(payload);
      if (syncedFingerprintByKeyRef.current.get(syncKey) === fingerprint) return;
      if (syncInFlightRef.current.has(syncKey)) {
        pendingRetryByKeyRef.current.set(syncKey, entry);
        return;
      }
      syncInFlightRef.current.add(syncKey);
      pendingRetryByKeyRef.current.delete(syncKey);
      void syncLocalThread({
        environmentId: entry.teamEnvironmentId,
        input: payload,
      })
        .then((result) => {
          if (result._tag === "Success") {
            syncedFingerprintByKeyRef.current.set(syncKey, fingerprint);
          }
        })
        .finally(() => {
          syncInFlightRef.current.delete(syncKey);
          const pending = pendingRetryByKeyRef.current.get(syncKey);
          if (pending) {
            pendingRetryByKeyRef.current.delete(syncKey);
            triggerSync(pending);
          }
        });
    };

    const unsubscribes: Array<() => void> = [];
    for (const entry of localTeamThreads) {
      const atom = environmentThreadStateAtom(primaryEnvironmentId, entry.shell.id);
      unsubscribes.push(
        appAtomRegistry.subscribe(atom, () => {
          triggerSync(entry);
        }),
      );
      triggerSync(entry);
    }

    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [environments, primaryEnvironmentId, projects, syncLocalThread, teamStates, threadShells]);

  // 2. Owner notifications when a colleague leaves a new pending note on a thread owned by currentMember.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fires in-app/desktop notifications when newly arriving team thread notes target the current member's threads
  useEffect(() => {
    for (const [teamEnvId, state] of teamStates) {
      if (state.team === null || state.currentMember === null) continue;
      const isInitialLoad = !initializedTeamEnvsRef.current.has(teamEnvId);
      const currentMemberId = state.currentMember.id;

      for (const [threadId, notes] of state.threadNotesByThreadId) {
        const attribution = state.attributionByThreadId.get(threadId);
        for (const note of notes) {
          if (seenNoteIdsRef.current.has(note.id)) continue;
          seenNoteIdsRef.current.add(note.id);
          if (isInitialLoad) continue;
          if (note.status !== "pending") continue;
          if (note.authorMemberId === currentMemberId) continue;
          if (attribution && attribution.creatorMemberId !== currentMemberId) continue;

          const targetEnvId: EnvironmentId =
            attribution?.isLocalSynced && attribution.executionEnvironmentId
              ? attribution.executionEnvironmentId
              : teamEnvId;
          const title = m(msg("New note from {author}", { author: note.authorPseudo }));
          const bodyPreview =
            note.originalBody.length > 140
              ? `${note.originalBody.slice(0, 137)}…`
              : note.originalBody;
          const { notificationMode: mode, inAppNotificationsEnabled } = getClientSettings();
          if (hasNotificationSound(mode)) {
            void playNotificationSound("input", () =>
              hasNotificationSound(getClientSettings().notificationMode),
            );
          }
          if (inAppNotificationsEnabled) {
            const toastId = toastManager.add({
              type: "info",
              title,
              description: bodyPreview,
              data: {
                hideCopyButton: true,
                leadingIcon: <StickyNoteIcon aria-hidden className="size-4 text-info-foreground" />,
              },
              actionProps: {
                children: m(msg("Open thread")),
                onClick: () => {
                  toastManager.close(toastId);
                  void router.navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId: targetEnvId, threadId: threadId as ThreadId },
                  });
                },
              },
            });
          }
          if (
            hasDesktopNotifications(mode) &&
            !(document.visibilityState === "visible" && document.hasFocus()) &&
            typeof Notification !== "undefined" &&
            Notification.permission === "granted"
          ) {
            const desktopNotification = new Notification(title, {
              body: bodyPreview,
              tag: `team-note:${note.id}`,
            });
            desktopNotification.onclick = () => {
              window.focus();
              void router.navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId: targetEnvId, threadId: threadId as ThreadId },
              });
            };
          }
        }
      }
      initializedTeamEnvsRef.current.add(teamEnvId);
    }
  }, [router, teamStates]);

  return null;
}
