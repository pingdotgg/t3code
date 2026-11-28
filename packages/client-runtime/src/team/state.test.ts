import {
  ALL_TEAM_ROLES,
  DEFAULT_TEAM_NOTIFICATION_SOUND,
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledTaskId,
  TeamEnvironmentRecordId,
  TeamId,
  TeamMemberId,
  TeamPrepromptId,
  TeamProviderId,
  TeamSkillId,
  TeamSkillSlug,
  TeamThreadNoteId,
  TeamViewId,
  ThreadId,
  makeTeamProviderInstanceId,
  type TeamMember,
  type TeamPseudo,
  type TeamStateStreamEvent,
  type TeamView,
  type TeamWorkspace,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";
import {
  applyTeamStreamEvent,
  canCurrentMemberChangeThreadView,
  canCurrentMemberConfigurePrivilegedTeamScheduledTask,
  canCurrentMemberCreateTeamScheduledTask,
  canCurrentMemberInterruptThread,
  canCurrentMemberLeaveThreadNote,
  canCurrentMemberManageQueuedRun,
  canCurrentMemberMutateTeamScheduledTask,
  canCurrentMemberPromoteQueuedRun,
  canCurrentMemberResolveThreadNotes,
  canCurrentMemberSteerActiveTurn,
  canCurrentMemberToggleThreadLock,
  countFollowedTeamThreads,
  EMPTY_TEAM_ENVIRONMENT_STATE,
  type TeamEnvironmentState,
  filterProviderEntriesForTeamProject,
  formatTeamThreadTitle,
  hasActiveTeamEnvironment,
  isDuplicateMirroredLocalTeamThread,
  isFollowingTeamThread,
  isTeamColleagueThread,
  isTeamHubOnlyServerConfig,
  isTeamOwnedThread,
  isTeamThreadLocked,
  listAccessibleTeamEnvironments,
  listAccessibleTeamViews,
  listConnectedTeams,
  listRemoteOnlyTeamProviders,
  resolveCorrelatedLocalSyncedTeamThread,
  resolveOwningTeamEnvironment,
  resolveProjectTeamAssignment,
  resolveTeamForkModelSelection,
  resolveTeamNotificationSoundPreset,
  resolveTeamQueuedRunAuthorPseudo,
  resolveTeamScheduledTaskMeta,
  resolveTeamThreadAcceptedNotes,
  resolveThreadTeamId,
  resolveTeamThreadCreatorPseudo,
  resolveTeamThreadEnvironmentAccessForClient,
  resolveTeamThreadNotes,
  resolveTeamThreadPendingNotes,
  resolveTeamThreadNotificationDecision,
  resolveTeamThreadPostPermission,
  resolveTeamThreadTurnControls,
  resolveTeamThreadView,
  scanTeamStateStream,
  shouldNotifyForTeamThread,
  shouldShowThreadInTeamFilter,
} from "./index.ts";

const envId = EnvironmentId.make("env-team");
const teamId = TeamId.make("team-1");
const viewId = TeamViewId.make("view-default");
const aliceId = TeamMemberId.make("member-alice");
const bobId = TeamMemberId.make("member-bob");
const aliceThreadId = ThreadId.make("thread-alice");
const bobThreadId = ThreadId.make("thread-bob");

const team: TeamWorkspace = {
  id: teamId,
  name: "Core Team",
  displayName: "Core Team",
  defaultViewId: viewId,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const alice: TeamMember = {
  id: aliceId,
  teamId,
  pseudo: "alice" as TeamPseudo,
  role: "owner",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const defaultView: TeamView = {
  id: viewId,
  teamId,
  name: "Default",
  description: null,
  isDefault: true,
  readRule: { roles: [...ALL_TEAM_ROLES], memberIds: [] },
  postRule: { roles: [...ALL_TEAM_ROLES], memberIds: [] },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const bob: TeamMember = {
  id: bobId,
  teamId,
  pseudo: "bob" as TeamPseudo,
  role: "regular",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("team client-runtime state and presentation", () => {
  it("short-circuits filtering and formatting in personal mode", () => {
    const personalStates = new Map([[envId, EMPTY_TEAM_ENVIRONMENT_STATE]]);
    expect(hasActiveTeamEnvironment(personalStates)).toBe(false);
    expect(
      resolveTeamThreadCreatorPseudo({
        environmentId: envId,
        threadId: aliceThreadId,
        teamStates: personalStates,
      }),
    ).toBeNull();
    expect(formatTeamThreadTitle("Fix auth", null)).toBe("Fix auth");
    expect(
      shouldShowThreadInTeamFilter({
        environmentId: envId,
        threadId: aliceThreadId,
        teamStates: personalStates,
        showColleaguesThreads: false,
      }),
    ).toBe(true);
  });

  it("prefixes titles dynamically, reflects pseudo renames, and filters colleagues by default", () => {
    let state = applyTeamStreamEvent(EMPTY_TEAM_ENVIRONMENT_STATE, {
      version: 1,
      type: "snapshot",
      payload: {
        team,
        currentMember: bob,
        members: [alice, bob],
        views: [defaultView],
        invites: [],
        threadAttributions: [
          {
            threadId: aliceThreadId,
            teamId,
            creatorMemberId: aliceId,
            creatorPseudo: alice.pseudo,
            viewId,
            locked: false,
            lockedByMemberId: null,
            createdAt: "2026-01-01T00:00:01.000Z",
          },
          {
            threadId: bobThreadId,
            teamId,
            creatorMemberId: bobId,
            creatorPseudo: bob.pseudo,
            viewId,
            locked: false,
            lockedByMemberId: null,
            createdAt: "2026-01-01T00:00:02.000Z",
          },
        ],
        followedThreadIds: [],
        latestTurnAttributions: [],
      },
    });

    const states = new Map([[envId, state]]);
    expect(hasActiveTeamEnvironment(states)).toBe(true);

    // Bob sees his own thread, not Alice's, when colleagues toggle is off.
    expect(
      shouldShowThreadInTeamFilter({
        environmentId: envId,
        threadId: bobThreadId,
        teamStates: states,
        showColleaguesThreads: false,
      }),
    ).toBe(true);
    expect(
      shouldShowThreadInTeamFilter({
        environmentId: envId,
        threadId: aliceThreadId,
        teamStates: states,
        showColleaguesThreads: false,
      }),
    ).toBe(false);

    // Turning colleagues toggle on reveals Alice's thread.
    expect(
      shouldShowThreadInTeamFilter({
        environmentId: envId,
        threadId: aliceThreadId,
        teamStates: states,
        showColleaguesThreads: true,
      }),
    ).toBe(true);

    // Dynamic pseudo prefixing without mutating stored title.
    const pseudo = resolveTeamThreadCreatorPseudo({
      environmentId: envId,
      threadId: aliceThreadId,
      teamStates: states,
    });
    expect(formatTeamThreadTitle("Fix auth", pseudo)).toBe("alice: Fix auth");

    // Live pseudo update immediately updates displayed prefix.
    state = applyTeamStreamEvent(state, {
      version: 1,
      type: "memberUpserted",
      payload: { ...alice, pseudo: "alice_core" as TeamPseudo },
    });
    const updatedStates = new Map([[envId, state]]);
    expect(
      formatTeamThreadTitle(
        "Fix auth",
        resolveTeamThreadCreatorPseudo({
          environmentId: envId,
          threadId: aliceThreadId,
          teamStates: updatedStates,
        }),
      ),
    ).toBe("alice_core: Fix auth");
  });

  it("syncs follow state, gates notifications, and filters followed threads", () => {
    let state = applyTeamStreamEvent(EMPTY_TEAM_ENVIRONMENT_STATE, {
      version: 1,
      type: "snapshot",
      payload: {
        team,
        currentMember: bob,
        members: [alice, bob],
        views: [defaultView],
        invites: [],
        threadAttributions: [
          {
            threadId: aliceThreadId,
            teamId,
            creatorMemberId: aliceId,
            creatorPseudo: alice.pseudo,
            viewId,
            locked: false,
            lockedByMemberId: null,
            createdAt: "2026-01-01T00:00:01.000Z",
          },
          {
            threadId: bobThreadId,
            teamId,
            creatorMemberId: bobId,
            creatorPseudo: bob.pseudo,
            viewId,
            locked: false,
            lockedByMemberId: null,
            createdAt: "2026-01-01T00:00:02.000Z",
          },
        ],
        followedThreadIds: [],
        latestTurnAttributions: [
          {
            turnId: "run-alice-1",
            threadId: aliceThreadId,
            authorMemberId: aliceId,
            authorPseudo: alice.pseudo,
            createdAt: "2026-01-01T00:00:03.000Z",
          },
        ],
      },
    });

    // Follow controls apply only to colleagues' threads, never own threads.
    expect(isTeamColleagueThread({ teamState: state, threadId: aliceThreadId })).toBe(true);
    expect(isTeamColleagueThread({ teamState: state, threadId: bobThreadId })).toBe(false);

    // Before following: Bob's own thread notifies, Alice's thread is silenced.
    expect(
      shouldNotifyForTeamThread({
        teamState: state,
        threadId: bobThreadId,
        latestRunId: "run-bob-1",
      }),
    ).toBe(true);
    expect(
      shouldNotifyForTeamThread({
        teamState: state,
        threadId: aliceThreadId,
        latestRunId: "run-alice-1",
      }),
    ).toBe(false);

    // Follow events for another member are ignored.
    state = applyTeamStreamEvent(state, {
      version: 1,
      type: "threadFollowChanged",
      payload: { threadId: bobThreadId, memberId: aliceId, isFollowing: true },
    });
    expect(isFollowingTeamThread({ teamState: state, threadId: bobThreadId })).toBe(false);

    // Bob follows Alice's thread -> notifications enabled, sidebar keeps it visible, followedOnly matches only it.
    state = applyTeamStreamEvent(state, {
      version: 1,
      type: "threadFollowChanged",
      payload: { threadId: aliceThreadId, memberId: bobId, isFollowing: true },
    });
    const followedStates = new Map([[envId, state]]);
    expect(isFollowingTeamThread({ teamState: state, threadId: aliceThreadId })).toBe(true);
    expect(countFollowedTeamThreads(followedStates)).toBe(1);
    expect(
      shouldNotifyForTeamThread({
        teamState: state,
        threadId: aliceThreadId,
        latestRunId: "run-alice-1",
      }),
    ).toBe(true);
    expect(
      shouldShowThreadInTeamFilter({
        environmentId: envId,
        threadId: aliceThreadId,
        teamStates: followedStates,
        showColleaguesThreads: false,
      }),
    ).toBe(true);
    expect(
      shouldShowThreadInTeamFilter({
        environmentId: envId,
        threadId: aliceThreadId,
        teamStates: followedStates,
        showColleaguesThreads: false,
        followedOnly: true,
      }),
    ).toBe(true);
    expect(
      shouldShowThreadInTeamFilter({
        environmentId: envId,
        threadId: bobThreadId,
        teamStates: followedStates,
        showColleaguesThreads: false,
        followedOnly: true,
      }),
    ).toBe(false);

    // Bob unfollows -> silenced again, except for a turn Bob himself authors.
    state = applyTeamStreamEvent(state, {
      version: 1,
      type: "threadFollowChanged",
      payload: { threadId: aliceThreadId, memberId: bobId, isFollowing: false },
    });
    expect(
      shouldNotifyForTeamThread({
        teamState: state,
        threadId: aliceThreadId,
        latestRunId: "run-alice-1",
      }),
    ).toBe(false);

    state = applyTeamStreamEvent(state, {
      version: 1,
      type: "turnAttributed",
      payload: {
        turnId: "run-bob-2",
        threadId: aliceThreadId,
        authorMemberId: bobId,
        authorPseudo: bob.pseudo,
        createdAt: "2026-01-01T00:00:05.000Z",
      },
    });
    expect(
      shouldNotifyForTeamThread({
        teamState: state,
        threadId: aliceThreadId,
        latestRunId: "run-bob-2",
      }),
    ).toBe(true);
    // A different later run ID not yet attributed defers (and does not notify).
    expect(
      resolveTeamThreadNotificationDecision({
        teamState: state,
        threadId: aliceThreadId,
        latestRunId: "run-alice-3",
      }),
    ).toBe("defer");
    expect(
      shouldNotifyForTeamThread({
        teamState: state,
        threadId: aliceThreadId,
        latestRunId: "run-alice-3",
      }),
    ).toBe(false);

    // A queued follow-up turn by Alice must NOT evict Bob's active run attribution!
    state = applyTeamStreamEvent(state, {
      version: 1,
      type: "turnAttributed",
      payload: {
        turnId: "run-alice-3",
        threadId: aliceThreadId,
        authorMemberId: aliceId,
        authorPseudo: alice.pseudo,
        createdAt: "2026-01-01T00:00:06.000Z",
      },
    });
    expect(
      resolveTeamThreadNotificationDecision({
        teamState: state,
        threadId: aliceThreadId,
        latestRunId: "run-bob-2",
      }),
    ).toBe("allow");
    expect(
      resolveTeamThreadNotificationDecision({
        teamState: state,
        threadId: aliceThreadId,
        latestRunId: "run-alice-3",
      }),
    ).toBe("suppress");

    // Unresolved team state and post-team unattributed threads defer; pre-team legacy threads allow.
    expect(
      resolveTeamThreadNotificationDecision({
        teamState: null,
        threadId: aliceThreadId,
        latestRunId: "run-alice-1",
      }),
    ).toBe("defer");
    expect(
      resolveTeamThreadNotificationDecision({
        teamState: state,
        threadId: ThreadId.make("thread-brand-new"),
        threadCreatedAt: "2026-01-01T00:01:00.000Z",
      }),
    ).toBe("defer");
    expect(
      resolveTeamThreadNotificationDecision({
        teamState: state,
        threadId: ThreadId.make("thread-pre-team"),
        threadCreatedAt: "2025-12-31T23:59:00.000Z",
      }),
    ).toBe("allow");

    // countFollowedTeamThreads ignores non-colleague (own) threads even if present in followedThreadIds.
    const pollutedFollowed = new Map([
      [
        envId,
        {
          ...state,
          followedThreadIds: new Set([aliceThreadId, bobThreadId]),
        },
      ],
    ]);
    expect(countFollowedTeamThreads(pollutedFollowed)).toBe(1);
  });

  it.effect(
    "does not emit EMPTY_TEAM_ENVIRONMENT_STATE before the first server snapshot arrives",
    () =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<TeamStateStreamEvent>();
        const observed: Array<TeamId | null> = [];
        const collector = yield* scanTeamStateStream(Stream.fromQueue(events)).pipe(
          Stream.tap((next) =>
            Effect.sync(() => {
              observed.push(next.team?.id ?? null);
            }),
          ),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );

        // Before any server snapshot arrives, the stream must emit nothing so clients stay deferred.
        yield* Effect.yieldNow;
        expect(observed).toEqual([]);

        yield* Queue.offer(events, {
          version: 1,
          type: "snapshot",
          payload: {
            team,
            currentMember: bob,
            members: [alice, bob],
            views: [defaultView],
            invites: [],
            threadAttributions: [],
            followedThreadIds: [],
            latestTurnAttributions: [],
          },
        });
        yield* Fiber.join(collector);
        expect(observed).toEqual([teamId]);
      }),
  );

  it("hydrates latestTurnByThreadId with the newest ascending turn while retaining older runs", () => {
    const hydrated = applyTeamStreamEvent(EMPTY_TEAM_ENVIRONMENT_STATE, {
      version: 1,
      type: "snapshot",
      payload: {
        team,
        currentMember: bob,
        members: [alice, bob],
        views: [defaultView],
        invites: [],
        threadAttributions: [
          {
            threadId: aliceThreadId,
            teamId,
            creatorMemberId: aliceId,
            creatorPseudo: alice.pseudo,
            viewId,
            locked: false,
            lockedByMemberId: null,
            createdAt: "2026-01-01T00:00:01.000Z",
          },
        ],
        followedThreadIds: [],
        latestTurnAttributions: [
          {
            turnId: "run-bob-active",
            threadId: aliceThreadId,
            authorMemberId: bobId,
            authorPseudo: bob.pseudo,
            createdAt: "2026-01-01T00:00:02.000Z",
          },
          {
            turnId: "run-alice-newest",
            threadId: aliceThreadId,
            authorMemberId: aliceId,
            authorPseudo: alice.pseudo,
            createdAt: "2026-01-01T00:00:05.000Z",
          },
        ],
      },
    });

    expect(hydrated.latestTurnByThreadId.get(aliceThreadId)?.turnId).toBe("run-alice-newest");
    expect(hydrated.turnAuthorByTurnId.get("run-bob-active")?.authorMemberId).toBe(bobId);
    expect(hydrated.turnAuthorByTurnId.get("run-alice-newest")?.authorMemberId).toBe(aliceId);
  });

  it("tracks views, view deletions, thread removal, post permissions, and lock controls", () => {
    const announcementsViewId = TeamViewId.make("view-announcements");
    const announcementsView: TeamView = {
      id: announcementsViewId,
      teamId,
      name: "Announcements",
      description: "Read-only for regulars",
      isDefault: false,
      readRule: { roles: [...ALL_TEAM_ROLES], memberIds: [] },
      postRule: { roles: ["owner", "admin", "modo"], memberIds: [] },
      createdAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    };
    let state = applyTeamStreamEvent(EMPTY_TEAM_ENVIRONMENT_STATE, {
      version: 1,
      type: "snapshot",
      payload: {
        team,
        currentMember: bob,
        members: [alice, bob],
        views: [defaultView],
        invites: [],
        threadAttributions: [
          {
            threadId: aliceThreadId,
            teamId,
            creatorMemberId: aliceId,
            creatorPseudo: alice.pseudo,
            viewId: announcementsViewId,
            locked: false,
            lockedByMemberId: null,
            createdAt: "2026-01-01T00:00:01.000Z",
          },
          {
            threadId: bobThreadId,
            teamId,
            creatorMemberId: bobId,
            creatorPseudo: bob.pseudo,
            viewId: announcementsViewId,
            locked: false,
            lockedByMemberId: null,
            createdAt: "2026-01-01T00:00:02.000Z",
          },
        ],
        followedThreadIds: [aliceThreadId],
        latestTurnAttributions: [],
      },
    });

    state = applyTeamStreamEvent(state, {
      version: 1,
      type: "viewUpserted",
      payload: announcementsView,
    });
    expect(state.views.map((view) => view.name)).toEqual(["Default", "Announcements"]);
    expect(resolveTeamThreadView({ teamState: state, threadId: aliceThreadId })?.name).toBe(
      "Announcements",
    );
    expect(listAccessibleTeamViews(state).map((view) => view.id)).toEqual([
      viewId,
      announcementsViewId,
    ]);
    expect(canCurrentMemberChangeThreadView(state)).toBe(false);
    expect(canCurrentMemberToggleThreadLock(state)).toBe(false);

    // Bob cannot post in Alice's thread in Announcements, but can post in his own thread.
    expect(resolveTeamThreadPostPermission({ teamState: state, threadId: aliceThreadId })).toEqual({
      canPost: false,
      blockReason: "view_read_only",
    });
    expect(resolveTeamThreadPostPermission({ teamState: state, threadId: bobThreadId })).toEqual({
      canPost: true,
      blockReason: null,
    });

    // Locking Bob's own thread blocks even Bob.
    state = applyTeamStreamEvent(state, {
      version: 1,
      type: "threadAttributed",
      payload: {
        threadId: bobThreadId,
        teamId,
        creatorMemberId: bobId,
        creatorPseudo: bob.pseudo,
        viewId: announcementsViewId,
        locked: true,
        lockedByMemberId: aliceId,
        createdAt: "2026-01-01T00:00:02.000Z",
      },
    });
    expect(isTeamThreadLocked({ teamState: state, threadId: bobThreadId })).toBe(true);
    expect(resolveTeamThreadPostPermission({ teamState: state, threadId: bobThreadId })).toEqual({
      canPost: false,
      blockReason: "locked",
    });

    // threadRemoved evicts attribution and follow state immediately.
    state = applyTeamStreamEvent(state, {
      version: 1,
      type: "threadRemoved",
      payload: { threadId: aliceThreadId },
    });
    expect(state.attributionByThreadId.has(aliceThreadId)).toBe(false);
    expect(state.followedThreadIds.has(aliceThreadId)).toBe(false);

    // viewDeleted removes view and reassigns threads back to Default View.
    state = applyTeamStreamEvent(state, {
      version: 1,
      type: "viewDeleted",
      payload: { viewId: announcementsViewId, fallbackViewId: viewId },
    });
    expect(state.viewById.has(announcementsViewId)).toBe(false);
    expect(state.attributionByThreadId.get(bobThreadId)?.viewId).toBe(viewId);
  });

  it("resolves creator-only Send now, explicit owner/admin Interrupt, and queued run author pseudo", () => {
    const modoId = TeamMemberId.make("member-modo");
    const charlie: TeamMember = {
      id: modoId,
      teamId,
      pseudo: "charlie" as TeamPseudo,
      role: "modo",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const buildState = (currentMember: TeamMember) =>
      applyTeamStreamEvent(EMPTY_TEAM_ENVIRONMENT_STATE, {
        version: 1,
        type: "snapshot",
        payload: {
          team,
          currentMember,
          members: [alice, charlie, bob],
          views: [defaultView],
          invites: [],
          threadAttributions: [
            {
              threadId: aliceThreadId,
              teamId,
              creatorMemberId: aliceId,
              creatorPseudo: alice.pseudo,
              viewId,
              locked: false,
              lockedByMemberId: null,
              createdAt: "2026-01-01T00:00:01.000Z",
            },
            {
              threadId: bobThreadId,
              teamId,
              creatorMemberId: bobId,
              creatorPseudo: bob.pseudo,
              viewId,
              locked: false,
              lockedByMemberId: null,
              createdAt: "2026-01-01T00:00:02.000Z",
            },
          ],
          followedThreadIds: [],
          latestTurnAttributions: [
            {
              turnId: "run-bob-active",
              threadId: bobThreadId,
              authorMemberId: bobId,
              authorPseudo: bob.pseudo,
              createdAt: "2026-01-01T00:00:03.000Z",
            },
            {
              turnId: "run-alice-queued",
              threadId: bobThreadId,
              authorMemberId: aliceId,
              authorPseudo: alice.pseudo,
              createdAt: "2026-01-01T00:00:04.000Z",
            },
            {
              turnId: "msg:msg-charlie-queued",
              threadId: bobThreadId,
              authorMemberId: modoId,
              authorPseudo: charlie.pseudo,
              createdAt: "2026-01-01T00:00:05.000Z",
            },
          ],
        },
      });

    const aliceState = buildState(alice);
    const charlieState = buildState(charlie);
    const bobState = buildState(bob);

    // Queued run author pseudo resolution (by runId or msg:<messageId>).
    expect(
      resolveTeamQueuedRunAuthorPseudo({
        teamState: bobState,
        threadId: bobThreadId,
        runId: "run-alice-queued",
      }),
    ).toBe("alice");
    expect(
      resolveTeamQueuedRunAuthorPseudo({
        teamState: bobState,
        threadId: bobThreadId,
        runId: "run-unattributed",
        userMessageId: "msg-charlie-queued",
      }),
    ).toBe("charlie");

    // Alice (owner) on Bob's thread: cannot Send now / steer, DOES get explicit admin Interrupt!
    expect(
      resolveTeamThreadTurnControls({
        teamState: aliceState,
        threadId: bobThreadId,
        activeRunId: "run-bob-active",
      }),
    ).toEqual({
      isTeamThread: true,
      canSteerActiveTurn: false,
      canPromoteQueuedRun: false,
      canInterrupt: true,
      canRespondToRuntimeRequest: true,
      isExplicitAdminInterrupt: true,
    });
    expect(canCurrentMemberPromoteQueuedRun({ teamState: aliceState, threadId: bobThreadId })).toBe(
      false,
    );
    expect(canCurrentMemberSteerActiveTurn({ teamState: aliceState, threadId: bobThreadId })).toBe(
      false,
    );
    expect(
      canCurrentMemberInterruptThread({
        teamState: aliceState,
        threadId: bobThreadId,
        activeRunId: "run-bob-active",
      }),
    ).toEqual({ canInterrupt: true, isExplicitAdminInterrupt: true });

    // Bob (creator) on Bob's thread: can Send now, can steer, normal Interrupt (not explicit admin).
    expect(
      resolveTeamThreadTurnControls({
        teamState: bobState,
        threadId: bobThreadId,
        activeRunId: "run-bob-active",
      }),
    ).toEqual({
      isTeamThread: true,
      canSteerActiveTurn: true,
      canPromoteQueuedRun: true,
      canInterrupt: true,
      canRespondToRuntimeRequest: true,
      isExplicitAdminInterrupt: false,
    });

    // Charlie (modo) on Bob's UNLOCKED thread: cannot Send now / steer / approve, DOES get explicit Interrupt!
    expect(
      resolveTeamThreadTurnControls({
        teamState: charlieState,
        threadId: bobThreadId,
        activeRunId: "run-bob-active",
      }),
    ).toEqual({
      isTeamThread: true,
      canSteerActiveTurn: false,
      canPromoteQueuedRun: false,
      canInterrupt: true,
      canRespondToRuntimeRequest: false,
      isExplicitAdminInterrupt: true,
    });
    // On a LOCKED thread, Charlie (modo) CANNOT interrupt; Alice (owner) still gets explicit Interrupt.
    const lockedBobAttribution = {
      ...bobState.attributionByThreadId.get(bobThreadId)!,
      locked: true,
      lockedByMemberId: alice.id,
    };
    const charlieLockedState = applyTeamStreamEvent(charlieState, {
      version: 1,
      type: "threadAttributed",
      payload: lockedBobAttribution,
    });
    expect(
      resolveTeamThreadTurnControls({
        teamState: charlieLockedState,
        threadId: bobThreadId,
        activeRunId: "run-bob-active",
      }),
    ).toEqual({
      isTeamThread: true,
      canSteerActiveTurn: false,
      canPromoteQueuedRun: false,
      canInterrupt: false,
      canRespondToRuntimeRequest: false,
      isExplicitAdminInterrupt: false,
    });
    const aliceLockedState = applyTeamStreamEvent(aliceState, {
      version: 1,
      type: "threadAttributed",
      payload: lockedBobAttribution,
    });
    expect(
      resolveTeamThreadTurnControls({
        teamState: aliceLockedState,
        threadId: bobThreadId,
        activeRunId: "run-bob-active",
      }),
    ).toEqual({
      isTeamThread: true,
      canSteerActiveTurn: false,
      canPromoteQueuedRun: false,
      canInterrupt: true,
      canRespondToRuntimeRequest: true,
      isExplicitAdminInterrupt: true,
    });

    // Regular non-creator (Eve) on Bob's thread: cannot Send now, steer, approve, or interrupt —
    // even if activeRunId is null while Eve has the newest queued turn!
    const eve: TeamMember = {
      id: TeamMemberId.make("member-eve"),
      teamId: team.id,
      pseudo: "eve" as TeamPseudo,
      role: "regular",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const eveState = applyTeamStreamEvent(
      applyTeamStreamEvent(charlieState, {
        version: 1,
        type: "snapshot",
        payload: {
          team,
          currentMember: eve,
          members: [alice, bob, charlie, eve],
          views: [defaultView],
          invites: [],
          threadAttributions: [...charlieState.attributionByThreadId.values()],
          followedThreadIds: [],
          latestTurnAttributions: [...charlieState.turnAuthorByTurnId.values()],
        },
      }),
      {
        version: 1,
        type: "turnAttributed",
        payload: {
          turnId: "run-eve-queued",
          threadId: bobThreadId,
          authorMemberId: eve.id,
          authorPseudo: eve.pseudo,
          createdAt: "2026-01-01T00:05:00.000Z",
        },
      },
    );
    expect(
      resolveTeamThreadTurnControls({
        teamState: eveState,
        threadId: bobThreadId,
        activeRunId: null,
        activeUserMessageId: null,
      }),
    ).toEqual({
      isTeamThread: true,
      canSteerActiveTurn: false,
      canPromoteQueuedRun: false,
      canInterrupt: false,
      canRespondToRuntimeRequest: false,
      isExplicitAdminInterrupt: false,
    });

    // Queued-message notification events are deduplicated by queuedRunId and cleaned up on threadRemoved.
    const queuedNotifEvent = {
      version: 1 as const,
      type: "queuedMessageNotification" as const,
      payload: {
        threadId: bobThreadId,
        queuedRunId: "run-charlie-queued-notif",
        senderMemberId: charlie.id,
        senderPseudo: "charlie",
        recipientMemberIds: [bob.id],
        messagePreview: "Please check tests",
        createdAt: "2026-01-01T00:06:00.000Z",
      },
    };
    const bobWithNotif = applyTeamStreamEvent(bobState, queuedNotifEvent);
    expect(bobWithNotif.queuedMessageNotifications).toHaveLength(1);
    expect(applyTeamStreamEvent(bobWithNotif, queuedNotifEvent)).toBe(bobWithNotif);
    const bobAfterRemove = applyTeamStreamEvent(bobWithNotif, {
      version: 1,
      type: "threadRemoved",
      payload: { threadId: bobThreadId },
    });
    expect(bobAfterRemove.queuedMessageNotifications).toHaveLength(0);

    // Queued run management: Charlie can manage his own queued message, not Alice's.
    expect(
      canCurrentMemberManageQueuedRun({
        teamState: charlieState,
        threadId: bobThreadId,
        runId: "run-unattributed",
        userMessageId: "msg-charlie-queued",
      }),
    ).toBe(true);
    expect(
      canCurrentMemberManageQueuedRun({
        teamState: charlieState,
        threadId: bobThreadId,
        runId: "run-alice-queued",
      }),
    ).toBe(false);
    expect(
      canCurrentMemberManageQueuedRun({
        teamState: aliceState,
        threadId: bobThreadId,
        runId: "run-unattributed",
        userMessageId: "msg-charlie-queued",
      }),
    ).toBe(true);

    // Personal mode remains completely unrestricted and never shows explicit admin Interrupt.
    expect(
      resolveTeamThreadTurnControls({
        teamState: EMPTY_TEAM_ENVIRONMENT_STATE,
        threadId: bobThreadId,
        activeRunId: "run-bob-active",
      }),
    ).toEqual({
      isTeamThread: false,
      canSteerActiveTurn: true,
      canPromoteQueuedRun: true,
      canInterrupt: true,
      canRespondToRuntimeRequest: true,
      isExplicitAdminInterrupt: false,
    });
  });

  it("correlates team projects by repository identity, filters environments by ACL, and tracks live thread notes", () => {
    const teamProjectId = ProjectId.make("proj-team-1");
    const localProjectId = ProjectId.make("proj-local-bob");
    const localEnvId = EnvironmentId.make("env-bob-local");
    const gpuEnvId = EnvironmentId.make("env-gpu-restricted");
    const noteId = TeamThreadNoteId.make("note-1");

    let bobState = applyTeamStreamEvent(EMPTY_TEAM_ENVIRONMENT_STATE, {
      version: 1,
      type: "snapshot",
      payload: {
        team,
        currentMember: bob,
        members: [alice, bob],
        views: [defaultView],
        invites: [],
        threadAttributions: [
          {
            threadId: bobThreadId,
            teamId,
            creatorMemberId: bobId,
            creatorPseudo: bob.pseudo,
            viewId,
            locked: false,
            lockedByMemberId: null,
            executionEnvironmentId: localEnvId,
            executionEnvironmentLabel: "Bob Laptop",
            isLocalSynced: true,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        followedThreadIds: [],
        latestTurnAttributions: [],
        teamProjects: [],
        environments: [
          {
            id: TeamEnvironmentRecordId.make("env-rec-0"),
            teamId,
            environmentId: envId,
            name: "Default Team Environment",
            isDefault: true,
            peerLinkId: null,
            accessRule: { roles: [...ALL_TEAM_ROLES], memberIds: [] },
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        threadNotes: [],
      },
    });

    // Assign project & correlate Bob's local clone via RepositoryIdentity canonicalKey.
    bobState = applyTeamStreamEvent(bobState, {
      version: 1,
      type: "projectAssigned",
      payload: {
        projectId: teamProjectId,
        teamId,
        defaultViewId: viewId,
        repoIdentityKey: "github.com/acme/repo",
        assignedByMemberId: aliceId,
        createdAt: "2026-01-01T00:00:01.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
      },
    });
    const teamStates = new Map([[envId, bobState]]);
    const correlated = resolveProjectTeamAssignment({
      project: {
        id: localProjectId,
        environmentId: localEnvId,
        repositoryIdentity: {
          canonicalKey: "github.com/acme/repo",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "https://github.com/acme/repo.git",
          },
        },
      },
      teamStates,
    });
    expect(correlated?.teamEnvironmentId).toBe(envId);
    expect(correlated?.assignment.projectId).toBe(teamProjectId);

    // Attach restricted GPU env -> hidden from regular Bob's listAccessibleTeamEnvironments.
    bobState = applyTeamStreamEvent(bobState, {
      version: 1,
      type: "environmentUpserted",
      payload: {
        id: TeamEnvironmentRecordId.make("env-rec-1"),
        teamId,
        environmentId: gpuEnvId,
        name: "GPU Runner",
        isDefault: false,
        peerLinkId: gpuEnvId,
        accessRule: { roles: ["owner", "admin"], memberIds: [] },
        createdAt: "2026-01-01T00:00:02.000Z",
        updatedAt: "2026-01-01T00:00:02.000Z",
      },
    });
    expect(listAccessibleTeamEnvironments(bobState).map((env) => env.environmentId)).toEqual([
      envId,
    ]);

    // Notes stream updates + pseudo rename propagation.
    bobState = applyTeamStreamEvent(bobState, {
      version: 1,
      type: "threadNoteUpserted",
      payload: {
        id: noteId,
        threadId: bobThreadId,
        teamId,
        authorMemberId: aliceId,
        authorPseudo: alice.pseudo,
        authorRole: "owner",
        originalBody: "Please check edge case X",
        originalContentHash: "hash-x",
        editedBody: null,
        editedContentHash: null,
        status: "pending",
        anchorTurnId: "run-1",
        anchorSeq: 1,
        includedInTurnId: null,
        resolvedByMemberId: null,
        resolvedByPseudo: null,
        resolvedAt: null,
        createdAt: "2026-01-01T00:00:03.000Z",
      },
    });
    expect(resolveTeamThreadNotes({ teamState: bobState, threadId: bobThreadId })).toHaveLength(1);
    expect(
      resolveTeamThreadPendingNotes({ teamState: bobState, threadId: bobThreadId }),
    ).toHaveLength(1);
    expect(
      resolveTeamThreadAcceptedNotes({ teamState: bobState, threadId: bobThreadId }),
    ).toHaveLength(0);
    expect(
      canCurrentMemberResolveThreadNotes({
        teamState: bobState,
        threadId: bobThreadId,
        viewingOnLocalExecutionEnvironment: true,
      }),
    ).toBe(true);

    // Pseudo rename updates cached authorPseudo on notes.
    bobState = applyTeamStreamEvent(bobState, {
      version: 1,
      type: "memberUpserted",
      payload: { ...alice, pseudo: "alice-lead" as TeamPseudo },
    });
    expect(
      resolveTeamThreadNotes({ teamState: bobState, threadId: bobThreadId })[0]?.authorPseudo,
    ).toBe("alice-lead");

    // Alice viewing Bob's local thread cannot execute, can leave note.
    const aliceState = applyTeamStreamEvent(bobState, {
      version: 1,
      type: "snapshot",
      payload: {
        team,
        currentMember: alice,
        members: [alice, bob],
        views: [defaultView],
        invites: [],
        threadAttributions: bobState.threadAttributions,
        followedThreadIds: [],
        latestTurnAttributions: [],
        teamProjects: bobState.teamProjects,
        environments: bobState.environments,
        threadNotes: resolveTeamThreadNotes({ teamState: bobState, threadId: bobThreadId }),
      },
    });
    expect(
      resolveTeamThreadEnvironmentAccessForClient({
        teamState: aliceState,
        threadId: bobThreadId,
        viewingOnLocalExecutionEnvironment: false,
      }),
    ).toMatchObject({ canExecute: false, reason: "other_member_local" });
    expect(canCurrentMemberLeaveThreadNote({ teamState: aliceState, threadId: bobThreadId })).toBe(
      true,
    );
    expect(
      canCurrentMemberResolveThreadNotes({ teamState: aliceState, threadId: bobThreadId }),
    ).toBe(false);

    // Deleting the note removes it from state.
    bobState = applyTeamStreamEvent(bobState, {
      version: 1,
      type: "threadNoteDeleted",
      payload: { noteId, threadId: bobThreadId },
    });
    expect(resolveTeamThreadNotes({ teamState: bobState, threadId: bobThreadId })).toHaveLength(0);
  });

  it("tracks Milestone 6 providers, skills, pre-prompts, assetsRevision, and strict team:<T>:* provider filtering", () => {
    let state = applyTeamStreamEvent(EMPTY_TEAM_ENVIRONMENT_STATE, {
      version: 1,
      type: "snapshot",
      payload: {
        team,
        currentMember: bob,
        members: [alice, bob],
        views: [defaultView],
        invites: [],
        threadAttributions: [],
        followedThreadIds: [],
        latestTurnAttributions: [],
        providers: [],
        skills: [],
        preprompts: [],
        assetsRevision: 0,
      },
    });

    state = applyTeamStreamEvent(state, {
      version: 1,
      type: "providerUpserted",
      payload: {
        id: TeamProviderId.make("tp-1"),
        teamId,
        providerInstanceId: ProviderInstanceId.make("team-proxy"),
        driver: ProviderDriverKind.make("claudeAgent"),
        displayName: "Team Claude",
        deliveryStrategy: "proxy",
        hasSecret: true,
        upstreamBaseUrl: "https://proxy.example",
        apiKeyHeader: null,
        apiKeyPrefix: null,
        config: {},
        enabled: true,
        updatedByMemberId: aliceId,
        createdAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
        updatedAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
      },
    });
    state = applyTeamStreamEvent(state, {
      version: 1,
      type: "providerUpserted",
      payload: {
        id: TeamProviderId.make("tp-2"),
        teamId,
        providerInstanceId: ProviderInstanceId.make("team-cursor"),
        driver: ProviderDriverKind.make("cursor"),
        displayName: "Team Cursor",
        deliveryStrategy: "remote-only",
        hasSecret: false,
        upstreamBaseUrl: null,
        apiKeyHeader: null,
        apiKeyPrefix: null,
        config: {},
        enabled: true,
        updatedByMemberId: aliceId,
        createdAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
        updatedAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
      },
    });
    state = applyTeamStreamEvent(state, {
      version: 1,
      type: "skillUpserted",
      payload: {
        id: TeamSkillId.make("sk-1"),
        teamId,
        slug: TeamSkillSlug.make("review"),
        providerDriver: "*",
        skillMd: "---\nname: review\ndescription: Review\n---\nBody",
        references: [],
        enabled: true,
        revision: NonNegativeInt.make(1),
        contentHash: "a".repeat(64),
        updatedByMemberId: aliceId,
        createdAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
        updatedAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
      },
    });
    state = applyTeamStreamEvent(state, {
      version: 1,
      type: "prepromptUpserted",
      payload: {
        id: TeamPrepromptId.make("pp-1"),
        teamId,
        name: "Rules",
        providerDriver: "*",
        injectionScope: "turn",
        content: "Follow rules",
        enabled: true,
        revision: NonNegativeInt.make(2),
        contentHash: "b".repeat(64),
        updatedByMemberId: aliceId,
        createdAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
        updatedAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
      },
    });
    state = applyTeamStreamEvent(state, {
      version: 1,
      type: "assetsUpdated",
      payload: { teamId, revision: NonNegativeInt.make(3) },
    });

    expect(state.providers).toHaveLength(2);
    expect(state.skills).toHaveLength(1);
    expect(state.preprompts).toHaveLength(1);
    expect(state.assetsRevision).toBe(3);

    const teamAssignment = {
      teamEnvironmentId: envId,
      team,
      teamState: state,
      assignment: {
        projectId: ProjectId.make("proj-1"),
        teamId,
        defaultViewId: viewId,
        repoIdentityKey: null,
        assignedByMemberId: aliceId,
        createdAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
        updatedAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
      },
    };
    expect(listRemoteOnlyTeamProviders(teamAssignment).map((p) => p.providerInstanceId)).toEqual([
      "team-cursor",
    ]);

    const personalEntry = { instanceId: ProviderInstanceId.make("codex") };
    const teamProxyEntry = {
      instanceId: makeTeamProviderInstanceId(teamId, ProviderInstanceId.make("team-proxy")),
    };
    const otherTeamEntry = {
      instanceId: makeTeamProviderInstanceId(
        TeamId.make("team-other"),
        ProviderInstanceId.make("x"),
      ),
    };

    // Strict isolation on team project: ONLY team:<T>:* is returned (never personal or another team).
    expect(
      filterProviderEntriesForTeamProject({
        entries: [personalEntry, teamProxyEntry, otherTeamEntry],
        teamAssignment,
      }),
    ).toEqual([teamProxyEntry]);

    // Personal project (teamAssignment = null): hides team:<T>:* instances and keeps personal ones!
    expect(
      filterProviderEntriesForTeamProject({
        entries: [personalEntry, teamProxyEntry, otherTeamEntry],
        teamAssignment: null,
      }),
    ).toEqual([personalEntry]);
  });

  it("applies member-scoped myGitHubIdentityUpdated and automationGitHubIdentityUpdated stream events", () => {
    const teamId = TeamId.make("team-gh");
    const aliceId = TeamMemberId.make("m-alice");
    const bobId = TeamMemberId.make("m-bob");
    const viewId = TeamViewId.make("v-default");
    const now = IsoDateTime.make("2026-11-26T12:00:00.000Z");

    let state = applyTeamStreamEvent(EMPTY_TEAM_ENVIRONMENT_STATE, {
      version: 1,
      type: "snapshot",
      payload: {
        team: {
          id: teamId,
          name: "Acme",
          displayName: "Acme",
          defaultViewId: viewId,
          createdAt: now,
          updatedAt: now,
        },
        currentMember: {
          id: aliceId,
          teamId,
          pseudo: "alice" as never,
          role: "owner",
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
        members: [],
        invites: [],
        views: [],
        threadAttributions: [],
        followedThreadIds: [],
        latestTurnAttributions: [],
        myGitHubIdentity: null,
        automationGitHubIdentity: null,
      },
    });

    // Event for another member is ignored client-side too (defense in depth)
    state = applyTeamStreamEvent(state, {
      version: 1,
      type: "myGitHubIdentityUpdated",
      payload: {
        memberId: bobId,
        identity: {
          authMethod: "pat",
          githubLogin: "bob-gh",
          githubName: "Bob",
          githubEmail: "bob@acme.dev",
          apiBaseUrl: "https://api.github.com",
          connectedAt: now,
          updatedAt: now,
        },
      },
    });
    expect(state.myGitHubIdentity).toBeNull();

    // Event for currentMember updates myGitHubIdentity
    state = applyTeamStreamEvent(state, {
      version: 1,
      type: "myGitHubIdentityUpdated",
      payload: {
        memberId: aliceId,
        identity: {
          authMethod: "pat",
          githubLogin: "alice-gh",
          githubName: "Alice",
          githubEmail: "alice@acme.dev",
          apiBaseUrl: "https://api.github.com",
          connectedAt: now,
          updatedAt: now,
        },
      },
    });
    expect(state.myGitHubIdentity?.githubLogin).toBe("alice-gh");

    // Automation account updated and cleared
    state = applyTeamStreamEvent(state, {
      version: 1,
      type: "automationGitHubIdentityUpdated",
      payload: {
        identity: {
          authMethod: "github_app",
          githubLogin: "acme-bot",
          githubName: "Acme Bot",
          githubEmail: "bot@acme.dev",
          apiBaseUrl: "https://api.github.com",
          updatedByMemberId: aliceId,
          connectedAt: now,
          updatedAt: now,
        },
      },
    });
    expect(state.automationGitHubIdentity?.githubLogin).toBe("acme-bot");

    state = applyTeamStreamEvent(state, {
      version: 1,
      type: "automationGitHubIdentityUpdated",
      payload: { identity: null },
    });
    expect(state.automationGitHubIdentity).toBeNull();

    // GitHub App OAuth config updated & cleared, plus reconnect-required identity update
    state = applyTeamStreamEvent(state, {
      version: 1,
      type: "githubAppConfigUpdated",
      payload: {
        config: {
          enabled: true,
          mode: "github_app",
          clientId: "Iv1.test",
          webBaseUrl: "https://github.com",
          apiBaseUrl: "https://api.github.com",
          scopes: "",
          hasClientSecret: true,
          updatedAt: now,
        },
      },
    });
    expect(state.githubAppConfig?.clientId).toBe("Iv1.test");
    expect(state.githubAppConfig?.hasClientSecret).toBe(true);

    state = applyTeamStreamEvent(state, {
      version: 1,
      type: "myGitHubIdentityUpdated",
      payload: {
        memberId: aliceId,
        identity: {
          authMethod: "github_app",
          githubLogin: "alice-gh",
          githubName: "Alice",
          githubEmail: "alice@acme.dev",
          apiBaseUrl: "https://api.github.com",
          connectedAt: now,
          updatedAt: now,
          hasRefreshToken: false,
          needsReconnect: true,
          reconnectReason: "GitHub authorization revoked.",
        },
      },
    });
    expect(state.myGitHubIdentity?.needsReconnect).toBe(true);
    expect(state.myGitHubIdentity?.reconnectReason).toBe("GitHub authorization revoked.");

    state = applyTeamStreamEvent(state, {
      version: 1,
      type: "githubAppConfigUpdated",
      payload: { config: null },
    });
    expect(state.githubAppConfig).toBeNull();
  });

  it("handles Milestone 8 team displayName updates, team-owned threads, and scheduled-task metadata/RBAC", () => {
    const teamThreadId = ThreadId.make("thread-team-auto-1");
    const taskMinId = ScheduledTaskId.make("task-min");
    const taskElevId = ScheduledTaskId.make("task-elev");
    const secondaryViewId = TeamViewId.make("view-ops");
    const now = IsoDateTime.make("2026-11-26T12:00:00.000Z");
    const modoMember: TeamMember = {
      id: bobId,
      teamId,
      pseudo: "charlie" as TeamPseudo,
      role: "modo",
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    const defaultView: TeamView = {
      id: viewId,
      teamId,
      name: "Default",
      description: null,
      isDefault: true,
      readRule: { roles: [...ALL_TEAM_ROLES], memberIds: [] },
      postRule: { roles: [...ALL_TEAM_ROLES], memberIds: [] },
      createdAt: now,
      updatedAt: now,
    };
    const opsView: TeamView = {
      id: secondaryViewId,
      teamId,
      name: "Ops",
      description: null,
      isDefault: false,
      readRule: { roles: [...ALL_TEAM_ROLES], memberIds: [] },
      postRule: { roles: ["owner", "admin", "modo"], memberIds: [] },
      createdAt: now,
      updatedAt: now,
    };

    let state = applyTeamStreamEvent(EMPTY_TEAM_ENVIRONMENT_STATE, {
      version: 1,
      type: "snapshot",
      payload: {
        team: { ...team, displayName: "Acme Bot" },
        currentMember: modoMember,
        members: [alice, modoMember],
        views: [defaultView, opsView],
        invites: [],
        threadAttributions: [
          {
            threadId: teamThreadId,
            teamId,
            ownerKind: "team",
            creatorMemberId: null,
            creatorPseudo: null,
            teamDisplayName: "Acme Bot",
            viewId: secondaryViewId,
            locked: false,
            lockedByMemberId: null,
            createdAt: now,
          },
        ],
        followedThreadIds: [],
        latestTurnAttributions: [
          {
            turnId: "run-auto-1",
            threadId: teamThreadId,
            authorKind: "team_automation",
            authorMemberId: null,
            authorPseudo: null,
            createdAt: now,
          },
        ],
        environments: [
          {
            id: TeamEnvironmentRecordId.make("tenv-1"),
            teamId,
            environmentId: envId,
            name: "Team Server",
            isDefault: true,
            peerLinkId: null,
            accessRule: { roles: [...ALL_TEAM_ROLES], memberIds: [] },
            createdAt: now,
            updatedAt: now,
          },
        ],
        scheduledTaskMetas: [
          {
            taskId: taskMinId,
            teamId,
            environmentId: envId,
            viewId: secondaryViewId,
            locked: false,
            mcpAccessLevel: "minimal",
            createdByMemberId: bobId,
            updatedByMemberId: bobId,
            createdAt: now,
            updatedAt: now,
          },
          {
            taskId: taskElevId,
            teamId,
            environmentId: envId,
            viewId,
            locked: true,
            mcpAccessLevel: "elevated",
            createdByMemberId: aliceId,
            updatedByMemberId: aliceId,
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    });

    // Team-owned thread renders with displayName, hides by default like colleagues, and produces zero notifications.
    expect(isTeamOwnedThread({ teamState: state, threadId: teamThreadId })).toBe(true);
    expect(isTeamColleagueThread({ teamState: state, threadId: teamThreadId })).toBe(true);
    expect(resolveTeamThreadCreatorPseudo({ teamState: state, threadId: teamThreadId })).toBe(
      "Acme Bot",
    );
    const teamStates = new Map([[envId, state]]);
    expect(
      shouldShowThreadInTeamFilter({
        environmentId: envId,
        threadId: teamThreadId,
        teamStates,
        showColleaguesThreads: false,
      }),
    ).toBe(false);
    expect(
      shouldShowThreadInTeamFilter({
        environmentId: envId,
        threadId: teamThreadId,
        teamStates,
        showColleaguesThreads: true,
      }),
    ).toBe(true);
    expect(
      resolveTeamThreadNotificationDecision({
        teamState: state,
        threadId: teamThreadId,
        latestRunId: "run-auto-1",
      }),
    ).toBe("suppress");

    // Live teamUpdated updates displayName on team-owned thread prefix & queued automation label.
    state = applyTeamStreamEvent(state, {
      version: 1,
      type: "teamUpdated",
      payload: { ...team, displayName: "Ops Bot" },
    });
    expect(resolveTeamThreadCreatorPseudo({ teamState: state, threadId: teamThreadId })).toBe(
      "Ops Bot",
    );
    expect(
      resolveTeamQueuedRunAuthorPseudo({
        teamState: state,
        threadId: teamThreadId,
        runId: "run-auto-1",
      }),
    ).toBe("Ops Bot");

    // Modo cannot steer/promote an active automation turn on the team-owned thread,
    // DOES get explicit Interrupt on an UNLOCKED team-owned thread, and loses Interrupt when LOCKED.
    expect(
      canCurrentMemberSteerActiveTurn({
        teamState: state,
        threadId: teamThreadId,
        activeRunId: "run-auto-1",
      }),
    ).toBe(false);
    expect(
      canCurrentMemberPromoteQueuedRun({
        teamState: state,
        threadId: teamThreadId,
        activeRunId: "run-auto-1",
      }),
    ).toBe(false);
    expect(
      canCurrentMemberInterruptThread({
        teamState: state,
        threadId: teamThreadId,
        activeRunId: "run-auto-1",
      }),
    ).toEqual({ canInterrupt: true, isExplicitAdminInterrupt: true });
    const lockedTeamState = applyTeamStreamEvent(state, {
      version: 1,
      type: "threadAttributed",
      payload: {
        ...state.attributionByThreadId.get(teamThreadId)!,
        locked: true,
        lockedByMemberId: alice.id,
      },
    });
    expect(
      canCurrentMemberInterruptThread({
        teamState: lockedTeamState,
        threadId: teamThreadId,
        activeRunId: "run-auto-1",
      }),
    ).toEqual({ canInterrupt: false, isExplicitAdminInterrupt: false });

    // On a locked member-owned thread before turnAttributed lands, the locked-out regular creator
    // must fail closed for interrupt and runtime-request controls (no speculative creator fallback).
    const lockedMemberThreadId = ThreadId.make("thread-m8-locked-member");
    const lockedMemberState = applyTeamStreamEvent(state, {
      version: 1,
      type: "threadAttributed",
      payload: {
        threadId: lockedMemberThreadId,
        teamId,
        ownerKind: "member",
        creatorMemberId: state.currentMember!.id,
        creatorPseudo: state.currentMember!.pseudo,
        teamDisplayName: "Ops Bot",
        viewId,
        locked: true,
        lockedByMemberId: alice.id,
        executionEnvironmentId: envId,
        executionEnvironmentLabel: "Main Server",
        isLocalSynced: false,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(
      resolveTeamThreadTurnControls({
        teamState: lockedMemberState,
        threadId: lockedMemberThreadId,
        activeRunId: "run-unattributed-locked",
      }),
    ).toMatchObject({
      canInterrupt: false,
      canRespondToRuntimeRequest: false,
      isExplicitAdminInterrupt: false,
    });

    // Scheduled task RBAC for modo: can create & mutate minimal task, cannot configure privileged or mutate elevated task.
    expect(canCurrentMemberCreateTeamScheduledTask(state, envId)).toBe(true);
    expect(canCurrentMemberConfigurePrivilegedTeamScheduledTask(state)).toBe(false);
    expect(
      canCurrentMemberMutateTeamScheduledTask({
        teamState: state,
        taskId: taskMinId,
        environmentId: envId,
      }),
    ).toBe(true);
    expect(
      canCurrentMemberMutateTeamScheduledTask({
        teamState: state,
        taskId: taskElevId,
        environmentId: envId,
      }),
    ).toBe(false);
    // Unhydrated / unattributed task fails closed for modo.
    expect(
      canCurrentMemberMutateTeamScheduledTask({
        teamState: state,
        taskId: ScheduledTaskId.make("task-unhydrated"),
        environmentId: envId,
      }),
    ).toBe(false);
    // Unlocked minimal task bound to a locked thread is NOT mutable by modo.
    const lockedThreadId = ThreadId.make("thread-m8-locked-bound");
    state = applyTeamStreamEvent(state, {
      version: 1,
      type: "threadAttributed",
      payload: {
        threadId: lockedThreadId,
        teamId,
        ownerKind: "team",
        creatorMemberId: null,
        creatorPseudo: null,
        teamDisplayName: "Ops Bot",
        viewId,
        locked: true,
        lockedByMemberId: null,
        executionEnvironmentId: envId,
        executionEnvironmentLabel: "Main Server",
        isLocalSynced: false,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(
      canCurrentMemberMutateTeamScheduledTask({
        teamState: state,
        taskId: taskMinId,
        environmentId: envId,
        boundThreadId: lockedThreadId,
      }),
    ).toBe(false);

    // View deletion reassigns scheduledTaskMeta to fallback view; scheduledTaskMetaDeleted removes it.
    state = applyTeamStreamEvent(state, {
      version: 1,
      type: "viewDeleted",
      payload: { viewId: secondaryViewId, fallbackViewId: viewId },
    });
    expect(resolveTeamScheduledTaskMeta(state, taskMinId)?.viewId).toBe(viewId);
    state = applyTeamStreamEvent(state, {
      version: 1,
      type: "scheduledTaskMetaDeleted",
      payload: { taskId: taskMinId },
    });
    expect(resolveTeamScheduledTaskMeta(state, taskMinId)).toBeNull();
  });

  it("resolves per-team notification sound presets, local team-project thread teamIds, and connected teams", () => {
    const teamAId = TeamId.make("team-alpha");
    const teamBId = TeamId.make("team-beta");
    const viewAId = TeamViewId.make("view-alpha");
    const localEnvId = EnvironmentId.make("env-local");
    const teamAEnvId = EnvironmentId.make("env-team-a");
    const teamAEnvMirrorId = EnvironmentId.make("env-team-a-mirror");
    const teamBEnvId = EnvironmentId.make("env-team-b");
    const now = IsoDateTime.make("2026-11-27T10:00:00.000Z");

    // Preset resolution: personal -> classic, unconfigured team -> chime, custom -> configured, off -> off
    expect(
      resolveTeamNotificationSoundPreset({
        teamId: null,
        teamNotificationSounds: { [teamAId]: "bell" },
      }),
    ).toBe("classic");
    expect(resolveTeamNotificationSoundPreset({ teamId: undefined })).toBe("classic");
    expect(
      resolveTeamNotificationSoundPreset({
        teamId: teamAId,
        teamNotificationSounds: {},
      }),
    ).toBe(DEFAULT_TEAM_NOTIFICATION_SOUND);
    expect(
      resolveTeamNotificationSoundPreset({
        teamId: teamAId,
        teamNotificationSounds: { [teamAId]: "marimba", [teamBId]: "off" },
      }),
    ).toBe("marimba");
    expect(
      resolveTeamNotificationSoundPreset({
        teamId: teamBId,
        teamNotificationSounds: { [teamAId]: "marimba", [teamBId]: "off" },
      }),
    ).toBe("off");
    expect(
      resolveTeamNotificationSoundPreset({
        teamId: "toString",
        teamNotificationSounds: {},
      }),
    ).toBe("chime");

    // Thread teamId resolution across remote Team Server, local team-assigned project, synced fallback, and personal
    const repoKey = "github.com/acme/platform";
    const teamProjectAssignment = {
      projectId: ProjectId.make("proj-remote"),
      teamId: teamAId,
      defaultViewId: viewAId,
      repoIdentityKey: repoKey,
      assignedByMemberId: aliceId,
      createdAt: now,
      updatedAt: now,
    };
    const syncedLocalThreadId = ThreadId.make("thread-local-synced");
    const teamAState: TeamEnvironmentState = {
      ...EMPTY_TEAM_ENVIRONMENT_STATE,
      team: {
        id: teamAId,
        name: "Alpha",
        displayName: "Alpha",
        defaultViewId: viewAId,
        createdAt: now,
        updatedAt: now,
      },
      teamProjects: [teamProjectAssignment],
      projectAssignmentByProjectId: new Map([
        [teamProjectAssignment.projectId, teamProjectAssignment],
      ]),
      projectAssignmentByRepoKey: new Map([[repoKey, teamProjectAssignment]]),
      attributionByThreadId: new Map([
        [
          syncedLocalThreadId,
          {
            threadId: syncedLocalThreadId,
            teamId: teamAId,
            creatorMemberId: aliceId,
            creatorPseudo: "alice" as TeamPseudo,
            viewId: viewAId,
            locked: false,
            lockedByMemberId: null,
            isLocalSynced: true,
            createdAt: now,
          },
        ],
      ]),
    };
    const teamBState = {
      ...EMPTY_TEAM_ENVIRONMENT_STATE,
      team: {
        id: teamBId,
        name: "Beta",
        displayName: "Beta",
        defaultViewId: TeamViewId.make("view-beta"),
        createdAt: now,
        updatedAt: now,
      },
    };
    const teamStates = new Map([
      [localEnvId, EMPTY_TEAM_ENVIRONMENT_STATE],
      [teamAEnvId, teamAState],
      [teamAEnvMirrorId, teamAState],
      [teamBEnvId, teamBState],
    ]);

    // 1. Remote Team Server thread -> resolves teamAId
    expect(
      resolveThreadTeamId({
        environmentId: teamAEnvId,
        threadId: ThreadId.make("thread-remote-1"),
        teamStates,
      }),
    ).toBe(teamAId);

    // 2. Local thread on a project correlated with Team A -> resolves teamAId
    expect(
      resolveThreadTeamId({
        environmentId: localEnvId,
        threadId: ThreadId.make("thread-local-team-project"),
        project: {
          id: ProjectId.make("proj-local-clone"),
          environmentId: localEnvId,
          repositoryIdentity: {
            canonicalKey: "local/platform",
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: "https://github.com/acme/platform.git",
            },
            displayName: "platform",
            origin: { canonicalKey: repoKey, host: "github.com", owner: "acme", repo: "platform" },
          } as never,
        },
        teamStates,
      }),
    ).toBe(teamAId);

    // 3. Local-synced thread without repositoryIdentity -> resolves via isLocalSynced attribution fallback
    // only when executionEnvironmentId matches (or is unset).
    expect(
      resolveThreadTeamId({
        environmentId: localEnvId,
        threadId: syncedLocalThreadId,
        project: { id: ProjectId.make("proj-uncorrelated"), environmentId: localEnvId },
        teamStates,
      }),
    ).toBe(teamAId);

    const otherLocalEnvId = EnvironmentId.make("env-other-local");
    const pinnedSyncedThreadId = ThreadId.make("thread-local-synced-pinned");
    const teamStatesWithPinned = new Map(teamStates);
    teamStatesWithPinned.set(teamAEnvId, {
      ...teamAState,
      attributionByThreadId: new Map([
        ...teamAState.attributionByThreadId,
        [
          pinnedSyncedThreadId,
          {
            threadId: pinnedSyncedThreadId,
            teamId: teamAId,
            creatorMemberId: aliceId,
            creatorPseudo: "alice" as TeamPseudo,
            viewId: viewAId,
            locked: false,
            lockedByMemberId: null,
            executionEnvironmentId: localEnvId,
            isLocalSynced: true,
            createdAt: now,
          },
        ],
      ]),
    });
    expect(
      resolveThreadTeamId({
        environmentId: localEnvId,
        threadId: pinnedSyncedThreadId,
        project: { id: ProjectId.make("proj-uncorrelated"), environmentId: localEnvId },
        teamStates: teamStatesWithPinned,
      }),
    ).toBe(teamAId);
    expect(
      resolveThreadTeamId({
        environmentId: otherLocalEnvId,
        threadId: pinnedSyncedThreadId,
        project: { id: ProjectId.make("proj-uncorrelated"), environmentId: otherLocalEnvId },
        teamStates: teamStatesWithPinned,
      }),
    ).toBeNull();

    // 4. Personal local thread -> null
    expect(
      resolveThreadTeamId({
        environmentId: localEnvId,
        threadId: ThreadId.make("thread-personal-1"),
        project: { id: ProjectId.make("proj-personal"), environmentId: localEnvId },
        teamStates,
      }),
    ).toBeNull();

    // Connected team list deduplicates by team.id and excludes personal environments
    expect(listConnectedTeams(teamStates).map((entry) => entry.team.id)).toEqual([
      teamAId,
      teamBId,
    ]);
  });

  it("P1-5/P1-6/P1-7: resolves t3runner owning teams, teamHubOnly configs, local fork provider isolation, and mirrored local thread deduplication", () => {
    const hubEnvId = EnvironmentId.make("env-hub");
    const runnerEnvId = EnvironmentId.make("env-runner");
    const localEnvId = EnvironmentId.make("env-alice-local");
    const teamId = TeamId.make("team-multi-env");
    const viewId = TeamViewId.make("view-default");
    const aliceId = TeamMemberId.make("member-alice");
    const bobId = TeamMemberId.make("member-bob");
    const now = "2026-11-26T12:00:00.000Z";

    const alice = {
      id: aliceId,
      teamId,
      pseudo: "alice" as TeamPseudo,
      role: "owner" as const,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    };
    const teamWorkspace = {
      id: teamId,
      name: "Hub Team",
      displayName: "Hub Team",
      defaultViewId: viewId,
      createdAt: now,
      updatedAt: now,
    };
    const syncedThreadId = ThreadId.make("thread-alice-local-synced");
    const bobSyncedThreadId = ThreadId.make("thread-bob-local-synced");
    const hubState = applyTeamStreamEvent(EMPTY_TEAM_ENVIRONMENT_STATE, {
      version: 1,
      type: "snapshot",
      payload: {
        team: teamWorkspace,
        currentMember: alice,
        members: [alice],
        views: [
          {
            id: viewId,
            teamId,
            name: "Default",
            description: null,
            isDefault: true,
            readRule: { roles: ["owner", "admin", "modo", "regular"], memberIds: [] },
            postRule: { roles: ["owner", "admin", "modo", "regular"], memberIds: [] },
            createdAt: now,
            updatedAt: now,
          },
        ],
        invites: [],
        threadAttributions: [
          {
            threadId: syncedThreadId,
            teamId,
            creatorMemberId: aliceId,
            creatorPseudo: alice.pseudo,
            viewId,
            locked: true,
            lockedByMemberId: aliceId,
            executionEnvironmentId: localEnvId,
            executionEnvironmentLabel: "Alice Laptop",
            isLocalSynced: true,
            createdAt: now,
          },
          {
            threadId: bobSyncedThreadId,
            teamId,
            creatorMemberId: bobId,
            creatorPseudo: "bob" as TeamPseudo,
            viewId,
            locked: false,
            lockedByMemberId: null,
            executionEnvironmentId: EnvironmentId.make("env-bob-local"),
            executionEnvironmentLabel: "Bob Laptop",
            isLocalSynced: true,
            createdAt: now,
          },
        ],
        followedThreadIds: [],
        latestTurnAttributions: [],
        teamProjects: [],
        environments: [
          {
            id: TeamEnvironmentRecordId.make("te-hub"),
            teamId,
            environmentId: hubEnvId,
            name: "Hub",
            isDefault: true,
            peerLinkId: null,
            accessRule: { roles: ["owner", "admin", "modo", "regular"], memberIds: [] },
            createdAt: now,
            updatedAt: now,
          },
          {
            id: TeamEnvironmentRecordId.make("te-runner"),
            teamId,
            environmentId: runnerEnvId,
            name: "Shared Runner",
            isDefault: false,
            peerLinkId: null,
            accessRule: { roles: ["owner", "admin", "modo", "regular"], memberIds: [] },
            createdAt: now,
            updatedAt: now,
          },
        ],
        providers: [
          {
            id: "tp-remote" as never,
            teamId,
            providerInstanceId: ProviderInstanceId.make("claude-remote"),
            driver: ProviderDriverKind.make("claudeAgent"),
            displayName: "Remote Claude",
            deliveryStrategy: "remote-only",
            upstreamBaseUrl: null,
            apiKeyHeader: null,
            apiKeyPrefix: null,
            hasSecret: true,
            config: {},
            enabled: true,
            updatedByMemberId: aliceId,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "tp-proxy" as never,
            teamId,
            providerInstanceId: ProviderInstanceId.make("codex-proxy"),
            driver: ProviderDriverKind.make("codex"),
            displayName: "Team Codex Proxy",
            deliveryStrategy: "proxy",
            upstreamBaseUrl: "https://proxy.example.com",
            apiKeyHeader: "authorization",
            apiKeyPrefix: "Bearer ",
            hasSecret: true,
            config: {},
            enabled: true,
            updatedByMemberId: aliceId,
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    });
    const teamStates = new Map<EnvironmentId, TeamEnvironmentState>([
      [hubEnvId, hubState],
      [runnerEnvId, EMPTY_TEAM_ENVIRONMENT_STATE],
      [localEnvId, EMPTY_TEAM_ENVIRONMENT_STATE],
    ]);

    // P1-5: resolveOwningTeamEnvironment resolves both direct hub and attached t3runner.
    expect(
      resolveOwningTeamEnvironment({ environmentId: hubEnvId, teamStates })?.teamEnvironmentId,
    ).toBe(hubEnvId);
    expect(
      resolveOwningTeamEnvironment({ environmentId: runnerEnvId, teamStates })?.teamEnvironmentId,
    ).toBe(hubEnvId);
    expect(resolveOwningTeamEnvironment({ environmentId: localEnvId, teamStates })).toBeNull();
    expect(
      isTeamHubOnlyServerConfig({
        environment: { capabilities: { teamHubOnly: true } },
      } as never),
    ).toBe(true);
    expect(
      isTeamHubOnlyServerConfig({
        environment: { capabilities: {} },
      } as never),
    ).toBe(false);

    // P1-6: Local fork excludes remote-only and personal providers and picks compatible team provider.
    const remoteTeamInstanceId = ProviderInstanceId.make(`team:${teamId}:claude-remote`);
    const proxyTeamInstanceId = ProviderInstanceId.make(`team:${teamId}:codex-proxy`);
    const personalInstanceId = ProviderInstanceId.make("codex");
    const sourceRemoteSelection = {
      instanceId: remoteTeamInstanceId,
      model: "claude-sonnet-4-6",
    };
    const localProviders = [
      {
        instanceId: personalInstanceId,
        driver: "codex" as const,
        enabled: true,
        status: "ready" as const,
        models: [{ slug: "gpt-5.4", name: "GPT-5.4" }],
      },
      {
        instanceId: remoteTeamInstanceId,
        driver: "claudeAgent" as const,
        enabled: true,
        status: "ready" as const,
        models: [{ slug: "claude-sonnet-4-6", name: "Claude Sonnet" }],
      },
      {
        instanceId: proxyTeamInstanceId,
        driver: "codex" as const,
        enabled: true,
        status: "ready" as const,
        models: [{ slug: "gpt-5.4-team", name: "GPT-5.4 Team" }],
      },
    ];
    expect(
      resolveTeamForkModelSelection({
        sourceModelSelection: sourceRemoteSelection,
        targetProviders: localProviders as never,
        teamState: hubState,
        isLocalTarget: true,
      }),
    ).toEqual({
      instanceId: proxyTeamInstanceId,
      model: "gpt-5.4-team",
    });
    // When only remote-only / personal providers exist on local target, returns null (blocks invalid fork).
    expect(
      resolveTeamForkModelSelection({
        sourceModelSelection: sourceRemoteSelection,
        targetProviders: localProviders.slice(0, 2) as never,
        teamState: hubState,
        isLocalTarget: true,
      }),
    ).toBeNull();
    // Remote target preserves remote-only team provider.
    expect(
      resolveTeamForkModelSelection({
        sourceModelSelection: sourceRemoteSelection,
        targetProviders: localProviders as never,
        teamState: hubState,
        isLocalTarget: false,
      }),
    ).toEqual(sourceRemoteSelection);

    // P1-7: Mirrored row deduplication & local row team metadata hydration.
    const liveLocalThreadKeys = new Set([`${localEnvId}\0${syncedThreadId}`]);
    expect(
      isDuplicateMirroredLocalTeamThread({
        environmentId: hubEnvId,
        threadId: syncedThreadId,
        teamStates,
        liveLocalThreadKeys,
      }),
    ).toBe(true);
    // Not a duplicate when local thread is absent (e.g. viewing from another device).
    expect(
      isDuplicateMirroredLocalTeamThread({
        environmentId: hubEnvId,
        threadId: syncedThreadId,
        teamStates,
        liveLocalThreadKeys: new Set(),
      }),
    ).toBe(false);
    // Colleague's local-synced thread is never hidden.
    expect(
      isDuplicateMirroredLocalTeamThread({
        environmentId: hubEnvId,
        threadId: bobSyncedThreadId,
        teamStates,
        liveLocalThreadKeys,
      }),
    ).toBe(false);
    const correlated = resolveCorrelatedLocalSyncedTeamThread({
      environmentId: localEnvId,
      threadId: syncedThreadId,
      teamStates,
    });
    expect(correlated?.teamEnvironmentId).toBe(hubEnvId);
    expect(correlated?.attribution.locked).toBe(true);
    expect(correlated?.attribution.creatorPseudo).toBe("alice");
  });
});
