import {
  EnvironmentHttpApi,
  TEAM_WS_METHODS,
  type EnvironmentId,
  type ProjectId,
  type ScheduledTaskId,
  type TeamAutomationGitHubIdentity,
  type TeamEnvironment,
  type TeamGitHubAppConfig,
  type TeamGitHubIdentity,
  type TeamInvite,
  type TeamMember,
  type TeamMemberId,
  type TeamPreprompt,
  type TeamProjectAssignment,
  type TeamProvider,
  type TeamQueuedMessageNotification,
  type TeamScheduledTaskMeta,
  type TeamSkill,
  type TeamStateSnapshot,
  type TeamStateStreamEvent,
  type TeamThreadAttribution,
  type TeamThreadSnoozeState,
  type TeamThreadNote,
  type TeamTurnAttribution,
  type TeamView,
  type TeamViewId,
  type TeamWorkspace,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/reactivity";

import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  DpopConnectionCredential,
} from "../connection/catalog.ts";
import { mapRemoteEnvironmentError } from "../connection/errors.ts";
import { BearerConnectionTarget, ConnectionBlockedError } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import {
  deriveWsBaseUrl,
  environmentEndpointUrl,
  normalizeHttpBaseUrl,
} from "../environment/endpoint.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { subscribe } from "../rpc/client.ts";
import { createEnvironmentRpcCommand, followStreamInEnvironment } from "../state/runtime.ts";

export interface TeamEnvironmentState {
  readonly team: TeamWorkspace | null;
  readonly currentMember: TeamMember | null;
  readonly members: ReadonlyArray<TeamMember>;
  readonly views: ReadonlyArray<TeamView>;
  readonly invites: ReadonlyArray<TeamInvite>;
  readonly threadAttributions: ReadonlyArray<TeamThreadAttribution>;
  readonly snoozedByThreadId: ReadonlyMap<ThreadId, TeamThreadSnoozeState>;
  readonly followedThreadIds: ReadonlySet<ThreadId>;
  readonly latestTurnByThreadId: ReadonlyMap<ThreadId, TeamTurnAttribution>;
  readonly turnAuthorByTurnId: ReadonlyMap<string, TeamTurnAttribution>;
  readonly memberById: ReadonlyMap<TeamMemberId, TeamMember>;
  readonly viewById: ReadonlyMap<TeamViewId, TeamView>;
  readonly attributionByThreadId: ReadonlyMap<ThreadId, TeamThreadAttribution>;
  readonly teamProjects: ReadonlyArray<TeamProjectAssignment>;
  readonly projectAssignmentByProjectId: ReadonlyMap<ProjectId, TeamProjectAssignment>;
  readonly projectAssignmentByRepoKey: ReadonlyMap<string, TeamProjectAssignment>;
  readonly environments: ReadonlyArray<TeamEnvironment>;
  readonly environmentById: ReadonlyMap<EnvironmentId, TeamEnvironment>;
  readonly threadNotesByThreadId: ReadonlyMap<ThreadId, ReadonlyArray<TeamThreadNote>>;
  readonly providers: ReadonlyArray<TeamProvider>;
  readonly skills: ReadonlyArray<TeamSkill>;
  readonly preprompts: ReadonlyArray<TeamPreprompt>;
  readonly assetsRevision: number;
  readonly myGitHubIdentity: TeamGitHubIdentity | null;
  readonly automationGitHubIdentity: TeamAutomationGitHubIdentity | null;
  readonly githubAppConfig: TeamGitHubAppConfig | null;
  readonly scheduledTaskMetas: ReadonlyArray<TeamScheduledTaskMeta>;
  readonly scheduledTaskMetaByTaskId: ReadonlyMap<ScheduledTaskId, TeamScheduledTaskMeta>;
  readonly queuedMessageNotifications: ReadonlyArray<TeamQueuedMessageNotification>;
}

export const EMPTY_TEAM_ENVIRONMENT_STATE: TeamEnvironmentState = {
  team: null,
  currentMember: null,
  members: [],
  views: [],
  invites: [],
  threadAttributions: [],
  followedThreadIds: new Set(),
  snoozedByThreadId: new Map(),
  latestTurnByThreadId: new Map(),
  turnAuthorByTurnId: new Map(),
  memberById: new Map(),
  viewById: new Map(),
  attributionByThreadId: new Map(),
  teamProjects: [],
  projectAssignmentByProjectId: new Map(),
  projectAssignmentByRepoKey: new Map(),
  environments: [],
  environmentById: new Map(),
  threadNotesByThreadId: new Map(),
  providers: [],
  skills: [],
  preprompts: [],
  assetsRevision: 0,
  myGitHubIdentity: null,
  automationGitHubIdentity: null,
  githubAppConfig: null,
  scheduledTaskMetas: [],
  scheduledTaskMetaByTaskId: new Map(),
  queuedMessageNotifications: [],
};

function sortTeamEnvironments(
  environments: Iterable<TeamEnvironment>,
): ReadonlyArray<TeamEnvironment> {
  return [...environments].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    if (byName !== 0) return byName;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

function sortTeamThreadNotes(notes: Iterable<TeamThreadNote>): ReadonlyArray<TeamThreadNote> {
  return [...notes].sort((a, b) => {
    if (a.anchorSeq !== b.anchorSeq) return a.anchorSeq - b.anchorSeq;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

function buildProjectMaps(projects: ReadonlyArray<TeamProjectAssignment>) {
  const projectAssignmentByProjectId = new Map<ProjectId, TeamProjectAssignment>();
  const projectAssignmentByRepoKey = new Map<string, TeamProjectAssignment>();
  for (const assignment of projects) {
    projectAssignmentByProjectId.set(assignment.projectId, assignment);
    if (assignment.repoIdentityKey !== null) {
      projectAssignmentByRepoKey.set(assignment.repoIdentityKey, assignment);
    }
  }
  return { projectAssignmentByProjectId, projectAssignmentByRepoKey };
}

function sortTeamViews(views: Iterable<TeamView>): ReadonlyArray<TeamView> {
  return [...views].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    if (byName !== 0) return byName;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

function buildStateFromSnapshot(snapshot: TeamStateSnapshot): TeamEnvironmentState {
  const memberById = new Map<TeamMemberId, TeamMember>(
    snapshot.members.map((member) => [member.id, member] as const),
  );
  const views = sortTeamViews(snapshot.views);
  const viewById = new Map<TeamViewId, TeamView>(views.map((view) => [view.id, view] as const));
  const attributionByThreadId = new Map<ThreadId, TeamThreadAttribution>(
    snapshot.threadAttributions.map((attribution) => [attribution.threadId, attribution] as const),
  );
  const followedThreadIds = new Set<ThreadId>(snapshot.followedThreadIds);
  const latestTurnByThreadId = new Map<ThreadId, TeamTurnAttribution>();
  const turnAuthorByTurnId = new Map<string, TeamTurnAttribution>();
  for (const turn of snapshot.latestTurnAttributions) {
    turnAuthorByTurnId.set(turn.turnId, turn);
    latestTurnByThreadId.set(turn.threadId, turn);
  }
  const teamProjects = snapshot.teamProjects ?? [];
  const { projectAssignmentByProjectId, projectAssignmentByRepoKey } =
    buildProjectMaps(teamProjects);
  const environments = sortTeamEnvironments(snapshot.environments ?? []);
  const environmentById = new Map<EnvironmentId, TeamEnvironment>(
    environments.map((env) => [env.environmentId, env] as const),
  );
  const notesGrouped = new Map<ThreadId, Array<TeamThreadNote>>();
  for (const note of snapshot.threadNotes ?? []) {
    const existing = notesGrouped.get(note.threadId);
    if (existing) existing.push(note);
    else notesGrouped.set(note.threadId, [note]);
  }
  const threadNotesByThreadId = new Map<ThreadId, ReadonlyArray<TeamThreadNote>>();
  for (const [threadId, notes] of notesGrouped) {
    threadNotesByThreadId.set(threadId, sortTeamThreadNotes(notes));
  }
  const scheduledTaskMetas = snapshot.scheduledTaskMetas ?? [];
  const scheduledTaskMetaByTaskId = new Map<ScheduledTaskId, TeamScheduledTaskMeta>(
    scheduledTaskMetas.map((meta) => [meta.taskId, meta] as const),
  );
  return {
    team: snapshot.team,
    currentMember: snapshot.currentMember,
    members: snapshot.members,
    views,
    invites: snapshot.invites,
    threadAttributions: snapshot.threadAttributions,
    followedThreadIds,
    snoozedByThreadId: new Map(snapshot.threadSnoozes?.map((snooze) => [snooze.threadId, snooze])),
    latestTurnByThreadId,
    turnAuthorByTurnId,
    memberById,
    viewById,
    attributionByThreadId,
    teamProjects,
    projectAssignmentByProjectId,
    projectAssignmentByRepoKey,
    environments,
    environmentById,
    threadNotesByThreadId,
    providers: snapshot.providers ?? [],
    skills: snapshot.skills ?? [],
    preprompts: snapshot.preprompts ?? [],
    assetsRevision: snapshot.assetsRevision ?? 0,
    myGitHubIdentity: snapshot.myGitHubIdentity ?? null,
    automationGitHubIdentity: snapshot.automationGitHubIdentity ?? null,
    githubAppConfig: snapshot.githubAppConfig ?? null,
    scheduledTaskMetas,
    scheduledTaskMetaByTaskId,
    queuedMessageNotifications: [],
  };
}

export function applyTeamStreamEvent(
  current: TeamEnvironmentState,
  event: TeamStateStreamEvent,
): TeamEnvironmentState {
  switch (event.type) {
    case "snapshot":
      return buildStateFromSnapshot(event.payload);

    case "teamDeleted":
      return EMPTY_TEAM_ENVIRONMENT_STATE;

    case "teamUpdated":
      return { ...current, team: event.payload };

    case "memberUpserted": {
      const member = event.payload;
      const memberById = new Map(current.memberById);
      memberById.set(member.id, member);
      const members = [...memberById.values()];
      const currentMember =
        current.currentMember?.id === member.id ? member : current.currentMember;
      // Keep cached creatorPseudo in thread attributions synchronized when a member changes pseudo.
      const attributionByThreadId = new Map(current.attributionByThreadId);
      let attributionsChanged = false;
      for (const [threadId, attribution] of attributionByThreadId) {
        if (
          attribution.creatorMemberId === member.id &&
          attribution.creatorPseudo !== member.pseudo
        ) {
          attributionByThreadId.set(threadId, { ...attribution, creatorPseudo: member.pseudo });
          attributionsChanged = true;
        }
      }
      const latestTurnByThreadId = new Map(current.latestTurnByThreadId);
      const turnAuthorByTurnId = new Map(current.turnAuthorByTurnId);
      let turnsChanged = false;
      for (const [threadId, turn] of latestTurnByThreadId) {
        if (turn.authorMemberId === member.id && turn.authorPseudo !== member.pseudo) {
          latestTurnByThreadId.set(threadId, { ...turn, authorPseudo: member.pseudo });
          turnsChanged = true;
        }
      }
      for (const [turnId, turn] of turnAuthorByTurnId) {
        if (turn.authorMemberId === member.id && turn.authorPseudo !== member.pseudo) {
          turnAuthorByTurnId.set(turnId, { ...turn, authorPseudo: member.pseudo });
          turnsChanged = true;
        }
      }
      const threadNotesByThreadId = new Map(current.threadNotesByThreadId);
      let notesChanged = false;
      for (const [threadId, notes] of threadNotesByThreadId) {
        let listChanged = false;
        const nextNotes = notes.map((note) => {
          const updateAuthor =
            note.authorMemberId === member.id &&
            (note.authorPseudo !== member.pseudo || note.authorRole !== member.role);
          const updateResolver =
            note.resolvedByMemberId === member.id && note.resolvedByPseudo !== member.pseudo;
          if (!updateAuthor && !updateResolver) return note;
          listChanged = true;
          return {
            ...note,
            ...(updateAuthor ? { authorPseudo: member.pseudo, authorRole: member.role } : {}),
            ...(updateResolver ? { resolvedByPseudo: member.pseudo } : {}),
          };
        });
        if (listChanged) {
          threadNotesByThreadId.set(threadId, nextNotes);
          notesChanged = true;
        }
      }
      return {
        ...current,
        currentMember,
        members,
        memberById,
        ...(attributionsChanged
          ? {
              threadAttributions: [...attributionByThreadId.values()],
              attributionByThreadId,
            }
          : {}),
        ...(turnsChanged ? { latestTurnByThreadId, turnAuthorByTurnId } : {}),
        ...(notesChanged ? { threadNotesByThreadId } : {}),
      };
    }

    case "inviteUpserted": {
      const invite = event.payload;
      const index = current.invites.findIndex((existing) => existing.id === invite.id);
      const invites =
        index === -1
          ? [invite, ...current.invites]
          : current.invites.map((existing, i) => (i === index ? invite : existing));
      return { ...current, invites };
    }

    case "threadAttributed": {
      const attribution = event.payload;
      const attributionByThreadId = new Map(current.attributionByThreadId);
      attributionByThreadId.set(attribution.threadId, attribution);
      return {
        ...current,
        threadAttributions: [...attributionByThreadId.values()],
        attributionByThreadId,
      };
    }

    case "turnAttributed": {
      const turn = event.payload;
      const latestTurnByThreadId = new Map(current.latestTurnByThreadId);
      latestTurnByThreadId.set(turn.threadId, turn);
      const turnAuthorByTurnId = new Map(current.turnAuthorByTurnId);
      turnAuthorByTurnId.delete(turn.turnId);
      turnAuthorByTurnId.set(turn.turnId, turn);
      while (turnAuthorByTurnId.size > MAX_TRACKED_TURN_ATTRIBUTIONS) {
        const oldestKey = turnAuthorByTurnId.keys().next().value;
        if (oldestKey === undefined) break;
        turnAuthorByTurnId.delete(oldestKey);
      }
      return {
        ...current,
        latestTurnByThreadId,
        turnAuthorByTurnId,
      };
    }

    case "viewUpserted": {
      const view = event.payload;
      const viewById = new Map(current.viewById);
      viewById.set(view.id, view);
      return {
        ...current,
        views: sortTeamViews(viewById.values()),
        viewById,
      };
    }

    case "viewDeleted": {
      const { viewId, fallbackViewId } = event.payload;
      const viewById = new Map(current.viewById);
      viewById.delete(viewId);
      const attributionByThreadId = new Map(current.attributionByThreadId);
      let attributionsChanged = false;
      for (const [threadId, attribution] of attributionByThreadId) {
        if (attribution.viewId === viewId) {
          attributionByThreadId.set(threadId, { ...attribution, viewId: fallbackViewId });
          attributionsChanged = true;
        }
      }
      const scheduledTaskMetaByTaskId = new Map(current.scheduledTaskMetaByTaskId);
      let metasChanged = false;
      for (const [taskId, meta] of scheduledTaskMetaByTaskId) {
        if (meta.viewId === viewId) {
          scheduledTaskMetaByTaskId.set(taskId, { ...meta, viewId: fallbackViewId });
          metasChanged = true;
        }
      }
      return {
        ...current,
        views: sortTeamViews(viewById.values()),
        viewById,
        ...(attributionsChanged
          ? {
              threadAttributions: [...attributionByThreadId.values()],
              attributionByThreadId,
            }
          : {}),
        ...(metasChanged
          ? {
              scheduledTaskMetas: [...scheduledTaskMetaByTaskId.values()],
              scheduledTaskMetaByTaskId,
            }
          : {}),
      };
    }

    case "threadRemoved": {
      const { threadId } = event.payload;
      const attributionByThreadId = new Map(current.attributionByThreadId);
      const hadAttribution = attributionByThreadId.delete(threadId);
      const followedThreadIds = new Set(current.followedThreadIds);
      const hadFollow = followedThreadIds.delete(threadId);
      const snoozedByThreadId = new Map(current.snoozedByThreadId);
      const hadSnooze = snoozedByThreadId.delete(threadId);
      const latestTurnByThreadId = new Map(current.latestTurnByThreadId);
      const hadLatestTurn = latestTurnByThreadId.delete(threadId);
      const turnAuthorByTurnId = new Map(current.turnAuthorByTurnId);
      let turnsChanged = hadLatestTurn;
      for (const [turnId, turn] of turnAuthorByTurnId) {
        if (turn.threadId === threadId) {
          turnAuthorByTurnId.delete(turnId);
          turnsChanged = true;
        }
      }
      const threadNotesByThreadId = new Map(current.threadNotesByThreadId);
      const hadNotes = threadNotesByThreadId.delete(threadId);
      const filteredQueuedNotifications = current.queuedMessageNotifications.filter(
        (item) => item.threadId !== threadId,
      );
      const hadQueuedNotifications =
        filteredQueuedNotifications.length !== current.queuedMessageNotifications.length;
      if (
        !hadAttribution &&
        !hadFollow &&
        !hadSnooze &&
        !turnsChanged &&
        !hadNotes &&
        !hadQueuedNotifications
      ) {
        return current;
      }
      return {
        ...current,
        ...(hadAttribution
          ? {
              threadAttributions: [...attributionByThreadId.values()],
              attributionByThreadId,
            }
          : {}),
        ...(hadFollow ? { followedThreadIds } : {}),
        ...(hadSnooze ? { snoozedByThreadId } : {}),
        ...(turnsChanged ? { latestTurnByThreadId, turnAuthorByTurnId } : {}),
        ...(hadNotes ? { threadNotesByThreadId } : {}),
        ...(hadQueuedNotifications
          ? { queuedMessageNotifications: filteredQueuedNotifications }
          : {}),
      };
    }

    case "threadSnoozeChanged": {
      const { memberId, threadId, snooze } = event.payload;
      if (current.currentMember?.id !== memberId) return current;
      const snoozedByThreadId = new Map(current.snoozedByThreadId);
      if (snooze === null) snoozedByThreadId.delete(threadId);
      else snoozedByThreadId.set(threadId, snooze);
      return { ...current, snoozedByThreadId };
    }

    case "threadFollowChanged": {
      const change = event.payload;
      if (current.currentMember?.id !== change.memberId) {
        return current;
      }
      const followedThreadIds = new Set(current.followedThreadIds);
      if (change.isFollowing) {
        followedThreadIds.add(change.threadId);
      } else {
        followedThreadIds.delete(change.threadId);
        if (current.snoozedByThreadId.has(change.threadId)) {
          const snoozedByThreadId = new Map(current.snoozedByThreadId);
          snoozedByThreadId.delete(change.threadId);
          return { ...current, followedThreadIds, snoozedByThreadId };
        }
      }
      return { ...current, followedThreadIds };
    }

    case "projectAssigned": {
      const assignment = event.payload;
      const nextById = new Map(current.projectAssignmentByProjectId);
      nextById.set(assignment.projectId, assignment);
      const teamProjects = [...nextById.values()];
      const { projectAssignmentByProjectId, projectAssignmentByRepoKey } =
        buildProjectMaps(teamProjects);
      return {
        ...current,
        teamProjects,
        projectAssignmentByProjectId,
        projectAssignmentByRepoKey,
      };
    }

    case "projectUnassigned": {
      const nextById = new Map(current.projectAssignmentByProjectId);
      if (!nextById.delete(event.payload.projectId)) return current;
      const teamProjects = [...nextById.values()];
      const { projectAssignmentByProjectId, projectAssignmentByRepoKey } =
        buildProjectMaps(teamProjects);
      return {
        ...current,
        teamProjects,
        projectAssignmentByProjectId,
        projectAssignmentByRepoKey,
      };
    }

    case "environmentUpserted": {
      const env = event.payload;
      const environmentById = new Map(current.environmentById);
      environmentById.set(env.environmentId, env);
      return {
        ...current,
        environments: sortTeamEnvironments(environmentById.values()),
        environmentById,
      };
    }

    case "environmentRemoved": {
      const environmentById = new Map(current.environmentById);
      if (!environmentById.delete(event.payload.environmentId)) return current;
      return {
        ...current,
        environments: sortTeamEnvironments(environmentById.values()),
        environmentById,
      };
    }

    case "threadNoteUpserted": {
      const note = event.payload;
      const threadNotesByThreadId = new Map(current.threadNotesByThreadId);
      const existing = threadNotesByThreadId.get(note.threadId) ?? [];
      const nextNotes = sortTeamThreadNotes([
        ...existing.filter((candidate) => candidate.id !== note.id),
        note,
      ]);
      threadNotesByThreadId.set(note.threadId, nextNotes);
      return {
        ...current,
        threadNotesByThreadId,
      };
    }

    case "threadNoteDeleted": {
      const { noteId, threadId } = event.payload;
      const existing = current.threadNotesByThreadId.get(threadId);
      if (!existing) return current;
      const filtered = existing.filter((candidate) => candidate.id !== noteId);
      if (filtered.length === existing.length) return current;
      const threadNotesByThreadId = new Map(current.threadNotesByThreadId);
      if (filtered.length === 0) {
        threadNotesByThreadId.delete(threadId);
      } else {
        threadNotesByThreadId.set(threadId, filtered);
      }
      return {
        ...current,
        threadNotesByThreadId,
      };
    }

    case "providerUpserted": {
      const provider = event.payload;
      const providers = [
        ...current.providers.filter((p) => p.providerInstanceId !== provider.providerInstanceId),
        provider,
      ].sort((a, b) =>
        (a.displayName ?? a.providerInstanceId).localeCompare(
          b.displayName ?? b.providerInstanceId,
          undefined,
          { sensitivity: "base" },
        ),
      );
      return { ...current, providers };
    }

    case "providerDeleted": {
      const providers = current.providers.filter(
        (p) => p.providerInstanceId !== event.payload.providerInstanceId,
      );
      return { ...current, providers };
    }

    case "skillUpserted": {
      const skill = event.payload;
      const skills = [...current.skills.filter((s) => s.id !== skill.id), skill].sort((a, b) =>
        a.slug.localeCompare(b.slug),
      );
      return {
        ...current,
        skills,
        assetsRevision: Math.max(current.assetsRevision, skill.revision),
      };
    }

    case "skillDeleted": {
      const skills = current.skills.filter((s) => s.id !== event.payload.skillId);
      return {
        ...current,
        skills,
        assetsRevision: Math.max(current.assetsRevision, event.payload.revision),
      };
    }

    case "prepromptUpserted": {
      const preprompt = event.payload;
      const preprompts = [
        ...current.preprompts.filter((p) => p.id !== preprompt.id),
        preprompt,
      ].sort(
        (a, b) =>
          a.injectionScope.localeCompare(b.injectionScope) ||
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      );
      return {
        ...current,
        preprompts,
        assetsRevision: Math.max(current.assetsRevision, preprompt.revision),
      };
    }

    case "prepromptDeleted": {
      const preprompts = current.preprompts.filter((p) => p.id !== event.payload.prepromptId);
      return {
        ...current,
        preprompts,
        assetsRevision: Math.max(current.assetsRevision, event.payload.revision),
      };
    }

    case "assetsUpdated": {
      return {
        ...current,
        assetsRevision: Math.max(current.assetsRevision, event.payload.revision),
      };
    }

    case "myGitHubIdentityUpdated": {
      if (current.currentMember?.id !== event.payload.memberId) {
        return current;
      }
      return {
        ...current,
        myGitHubIdentity: event.payload.identity,
      };
    }

    case "automationGitHubIdentityUpdated": {
      return {
        ...current,
        automationGitHubIdentity: event.payload.identity,
      };
    }

    case "githubAppConfigUpdated": {
      return {
        ...current,
        githubAppConfig: event.payload.config,
      };
    }

    case "scheduledTaskMetaUpserted": {
      const meta = event.payload;
      const scheduledTaskMetaByTaskId = new Map(current.scheduledTaskMetaByTaskId);
      scheduledTaskMetaByTaskId.set(meta.taskId, meta);
      return {
        ...current,
        scheduledTaskMetas: [...scheduledTaskMetaByTaskId.values()],
        scheduledTaskMetaByTaskId,
      };
    }

    case "scheduledTaskMetaDeleted": {
      const scheduledTaskMetaByTaskId = new Map(current.scheduledTaskMetaByTaskId);
      if (!scheduledTaskMetaByTaskId.delete(event.payload.taskId)) return current;
      return {
        ...current,
        scheduledTaskMetas: [...scheduledTaskMetaByTaskId.values()],
        scheduledTaskMetaByTaskId,
      };
    }

    case "queuedMessageNotification": {
      const notification = event.payload;
      if (
        current.queuedMessageNotifications.some(
          (existing) => existing.queuedRunId === notification.queuedRunId,
        )
      ) {
        return current;
      }
      const next = [...current.queuedMessageNotifications, notification];
      if (next.length > MAX_TRACKED_QUEUED_MESSAGE_NOTIFICATIONS) {
        next.splice(0, next.length - MAX_TRACKED_QUEUED_MESSAGE_NOTIFICATIONS);
      }
      return {
        ...current,
        queuedMessageNotifications: next,
      };
    }
  }
}

const MAX_TRACKED_TURN_ATTRIBUTIONS = 1_000;
const MAX_TRACKED_QUEUED_MESSAGE_NOTIFICATIONS = 100;

export function scanTeamStateStream<E, R>(
  stream: Stream.Stream<TeamStateStreamEvent, E, R>,
): Stream.Stream<TeamEnvironmentState, E, R> {
  // Drop Stream.scan's synthetic initial seed so clients stay unresolved until the first server snapshot lands.
  return stream.pipe(
    Stream.scan(() => EMPTY_TEAM_ENVIRONMENT_STATE, applyTeamStreamEvent),
    Stream.drop(1),
  );
}

export function createTeamEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  const state = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom(
        followStreamInEnvironment(
          environmentId,
          Stream.suspend(() =>
            scanTeamStateStream(subscribe(TEAM_WS_METHODS.teamSubscribeState, {})),
          ),
        ),
      )
      .pipe(Atom.withLabel(`environment-data:team:state:${environmentId}`)),
  );

  return {
    state,
    initialize: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:initialize",
      tag: TEAM_WS_METHODS.teamInitialize,
    }),
    leave: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:leave",
      tag: TEAM_WS_METHODS.teamLeave,
    }),
    deleteTeam: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:delete",
      tag: TEAM_WS_METHODS.teamDelete,
    }),
    updateMyPseudo: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:update-my-pseudo",
      tag: TEAM_WS_METHODS.teamUpdateMyPseudo,
    }),
    createInvite: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:create-invite",
      tag: TEAM_WS_METHODS.teamCreateInvite,
    }),
    revokeInvite: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:revoke-invite",
      tag: TEAM_WS_METHODS.teamRevokeInvite,
    }),
    snoozeThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:snooze-thread",
      tag: TEAM_WS_METHODS.teamSnoozeThread,
    }),
    unsnoozeThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:unsnooze-thread",
      tag: TEAM_WS_METHODS.teamUnsnoozeThread,
    }),
    followThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:follow-thread",
      tag: TEAM_WS_METHODS.teamFollowThread,
    }),
    unfollowThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:unfollow-thread",
      tag: TEAM_WS_METHODS.teamUnfollowThread,
    }),
    updateMemberRole: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:update-member-role",
      tag: TEAM_WS_METHODS.teamUpdateMemberRole,
    }),
    updateMemberStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:update-member-status",
      tag: TEAM_WS_METHODS.teamUpdateMemberStatus,
    }),
    createView: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:create-view",
      tag: TEAM_WS_METHODS.teamCreateView,
    }),
    updateView: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:update-view",
      tag: TEAM_WS_METHODS.teamUpdateView,
    }),
    deleteView: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:delete-view",
      tag: TEAM_WS_METHODS.teamDeleteView,
    }),
    setThreadView: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:set-thread-view",
      tag: TEAM_WS_METHODS.teamSetThreadView,
    }),
    setThreadLocked: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:set-thread-locked",
      tag: TEAM_WS_METHODS.teamSetThreadLocked,
    }),
    assignProject: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:assign-project",
      tag: TEAM_WS_METHODS.teamAssignProject,
    }),
    unassignProject: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:unassign-project",
      tag: TEAM_WS_METHODS.teamUnassignProject,
    }),
    attachEnvironment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:attach-environment",
      tag: TEAM_WS_METHODS.teamAttachEnvironment,
    }),
    updateEnvironment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:update-environment",
      tag: TEAM_WS_METHODS.teamUpdateEnvironment,
    }),
    detachEnvironment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:detach-environment",
      tag: TEAM_WS_METHODS.teamDetachEnvironment,
    }),
    syncLocalThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:sync-local-thread",
      tag: TEAM_WS_METHODS.teamSyncLocalThread,
    }),
    createThreadNote: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:create-thread-note",
      tag: TEAM_WS_METHODS.teamCreateThreadNote,
    }),
    deleteThreadNote: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:delete-thread-note",
      tag: TEAM_WS_METHODS.teamDeleteThreadNote,
    }),
    resolveThreadNote: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:resolve-thread-note",
      tag: TEAM_WS_METHODS.teamResolveThreadNote,
    }),
    editThreadNote: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:edit-thread-note",
      tag: TEAM_WS_METHODS.teamEditThreadNote,
    }),
    reserveAcceptedNotes: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:reserve-accepted-notes",
      tag: TEAM_WS_METHODS.teamReserveAcceptedNotes,
    }),
    releaseAcceptedNotes: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:release-accepted-notes",
      tag: TEAM_WS_METHODS.teamReleaseAcceptedNotes,
    }),
    consumeAcceptedNotes: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:consume-accepted-notes",
      tag: TEAM_WS_METHODS.teamConsumeAcceptedNotes,
    }),
    listThreadNotes: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:list-thread-notes",
      tag: TEAM_WS_METHODS.teamListThreadNotes,
    }),
    upsertProvider: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:upsert-provider",
      tag: TEAM_WS_METHODS.teamUpsertProvider,
    }),
    deleteProvider: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:delete-provider",
      tag: TEAM_WS_METHODS.teamDeleteProvider,
    }),
    listProviderUsage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:list-provider-usage",
      tag: TEAM_WS_METHODS.teamListProviderUsage,
    }),
    upsertSkill: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:upsert-skill",
      tag: TEAM_WS_METHODS.teamUpsertSkill,
    }),
    deleteSkill: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:delete-skill",
      tag: TEAM_WS_METHODS.teamDeleteSkill,
    }),
    upsertPreprompt: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:upsert-preprompt",
      tag: TEAM_WS_METHODS.teamUpsertPreprompt,
    }),
    deletePreprompt: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:delete-preprompt",
      tag: TEAM_WS_METHODS.teamDeletePreprompt,
    }),
    issueLocalSyncToken: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:issue-local-sync-token",
      tag: TEAM_WS_METHODS.teamIssueLocalSyncToken,
    }),
    syncLocalBinding: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:sync-local-binding",
      tag: TEAM_WS_METHODS.teamSyncLocalBinding,
    }),
    removeLocalBinding: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:remove-local-binding",
      tag: TEAM_WS_METHODS.teamRemoveLocalBinding,
    }),
    notifyLocalAssetsUpdated: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:notify-local-assets-updated",
      tag: TEAM_WS_METHODS.teamNotifyLocalAssetsUpdated,
    }),
    updateMyMobileVisibility: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:update-my-mobile-visibility",
      tag: TEAM_WS_METHODS.teamUpdateMyMobileVisibility,
    }),
    createMobilePairingLink: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:create-mobile-pairing-link",
      tag: TEAM_WS_METHODS.teamCreateMobilePairingLink,
    }),
    listMyMobilePairingLinks: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:list-my-mobile-pairing-links",
      tag: TEAM_WS_METHODS.teamListMyMobilePairingLinks,
    }),
    revokeMyMobilePairingLink: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:revoke-my-mobile-pairing-link",
      tag: TEAM_WS_METHODS.teamRevokeMyMobilePairingLink,
    }),
    connectMyGitHub: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:connect-my-github",
      tag: TEAM_WS_METHODS.teamConnectMyGitHub,
    }),
    disconnectMyGitHub: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:disconnect-my-github",
      tag: TEAM_WS_METHODS.teamDisconnectMyGitHub,
    }),
    setAutomationGitHub: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:set-automation-github",
      tag: TEAM_WS_METHODS.teamSetAutomationGitHub,
    }),
    clearAutomationGitHub: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:clear-automation-github",
      tag: TEAM_WS_METHODS.teamClearAutomationGitHub,
    }),
    setGitHubAppConfig: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:set-github-app-config",
      tag: TEAM_WS_METHODS.teamSetGitHubAppConfig,
    }),
    clearGitHubAppConfig: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:clear-github-app-config",
      tag: TEAM_WS_METHODS.teamClearGitHubAppConfig,
    }),
    startGitHubOAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:start-github-oauth",
      tag: TEAM_WS_METHODS.teamStartGitHubOAuth,
    }),
    completeGitHubOAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:complete-github-oauth",
      tag: TEAM_WS_METHODS.teamCompleteGitHubOAuth,
    }),
    startGitHubDeviceFlow: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:start-github-device-flow",
      tag: TEAM_WS_METHODS.teamStartGitHubDeviceFlow,
    }),
    pollGitHubDeviceFlow: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:poll-github-device-flow",
      tag: TEAM_WS_METHODS.teamPollGitHubDeviceFlow,
    }),
    cancelGitHubDeviceFlow: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:team:cancel-github-device-flow",
      tag: TEAM_WS_METHODS.teamCancelGitHubDeviceFlow,
    }),
  };
}

export interface TeamInvitePreviewInput {
  readonly serverUrl: string;
  readonly token: string;
}

export interface TeamInviteJoinInput {
  readonly serverUrl: string;
  readonly token: string;
  readonly pseudo: string;
}

export interface TeamInviteJoinResult {
  readonly environmentId: EnvironmentId;
  readonly team: TeamWorkspace;
  readonly member: TeamMember;
}

const normalizeTeamServerUrl = (serverUrl: string) =>
  Effect.try({
    try: () => normalizeHttpBaseUrl(serverUrl),
    catch: () =>
      new ConnectionBlockedError({
        reason: "configuration",
        detail: "The team server URL is invalid.",
      }),
  });

export const previewTeamInviteEffect = Effect.fn("clientRuntime.team.previewInvite")(function* (
  input: TeamInvitePreviewInput,
) {
  const httpBaseUrl = yield* normalizeTeamServerUrl(input.serverUrl);
  const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: httpBaseUrl });
  return yield* client.team.previewInvite({
    payload: { token: input.token.trim() },
  });
});

function teamBearerConnectionId(environmentId: EnvironmentId, httpBaseUrl: string): string {
  return `bearer:${environmentId}:${new URL(httpBaseUrl).origin}`;
}

export const redeemTeamInviteAndConnectEffect = Effect.fn("clientRuntime.team.redeemInvite")(
  function* (input: TeamInviteJoinInput) {
    const httpBaseUrl = yield* normalizeTeamServerUrl(input.serverUrl);
    const presentation = yield* ClientCapabilities.ClientPresentation;
    const descriptor = yield* fetchRemoteEnvironmentDescriptor({
      httpBaseUrl,
    }).pipe(Effect.mapError(mapRemoteEnvironmentError));

    const connectionId = teamBearerConnectionId(descriptor.environmentId, httpBaseUrl);
    const provisionalRoute = {
      target: new BearerConnectionTarget({
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        connectionId,
      }),
      profile: new BearerConnectionProfile({
        connectionId,
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        httpBaseUrl,
        wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
      }),
    };
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const existingEntry = (yield* SubscriptionRef.get(registry.entries)).get(
      descriptor.environmentId,
    );
    if (existingEntry !== undefined && existingEntry.target._tag === "PrimaryConnectionTarget") {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail:
          "This team server is already managed locally by this app and cannot be overwritten with a team invite.",
      });
    }
    // Reject spoofed addresses before spending a one-time team invite token.
    yield* registry.assertKnownAddress({
      ...provisionalRoute,
      profile: Option.some(provisionalRoute.profile),
    });

    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const dpopProof =
      descriptor.capabilities.accessTokenRenewal === true && Option.isSome(signer)
        ? yield* signer.value
            .createProof({
              method: "POST",
              url: environmentEndpointUrl(httpBaseUrl, "/api/team/invites/redeem"),
            })
            .pipe(Effect.option)
        : Option.none<string>();

    const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: httpBaseUrl });
    const redeemed = yield* client.team.redeemInvite({
      headers: Option.isSome(dpopProof) ? { dpop: dpopProof.value } : {},
      payload: {
        token: input.token.trim(),
        pseudo: input.pseudo.trim(),
        ...(presentation.metadata.label ? { clientLabel: presentation.metadata.label } : {}),
        ...(presentation.metadata.deviceType
          ? { clientDeviceType: presentation.metadata.deviceType }
          : {}),
        ...(presentation.metadata.os ? { clientOs: presentation.metadata.os } : {}),
      },
    });

    const label = redeemed.team.name || descriptor.label;
    const route = {
      target: new BearerConnectionTarget({
        environmentId: descriptor.environmentId,
        label,
        connectionId,
      }),
      profile: new BearerConnectionProfile({
        connectionId,
        environmentId: descriptor.environmentId,
        label,
        httpBaseUrl,
        wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
      }),
    };
    const credential =
      redeemed.tokenType === "DPoP"
        ? new DpopConnectionCredential({
            accessToken: redeemed.accessToken,
            expiresAtEpochMs: (yield* Clock.currentTimeMillis) + redeemed.expiresIn * 1_000,
          })
        : new BearerConnectionCredential({
            token: redeemed.accessToken,
          });

    const registered = yield* registry.register(
      new BearerConnectionRegistration({ ...route, credential }),
      { knownAddressOnly: true },
    );
    if (!registered) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail:
          "This team server is already managed locally by this app and cannot be overwritten with a team invite.",
      });
    }
    yield* registry.setCompatibility(descriptor.environmentId, null);
    yield* registry
      .setEnabled(descriptor.environmentId, true)
      .pipe(Effect.catchTags({ EnvironmentNotRegisteredError: () => Effect.void }));

    return {
      environmentId: descriptor.environmentId,
      team: redeemed.team,
      member: redeemed.member,
    };
  },
);
