import {
  EnvironmentId,
  TeamId,
  TeamMemberId,
  TeamViewId,
  ThreadId,
  type TeamMember,
  type TeamPseudo,
  type TeamWorkspace,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  applyTeamStreamEvent,
  countFollowedTeamThreads,
  EMPTY_TEAM_ENVIRONMENT_STATE,
  formatTeamThreadTitle,
  hasActiveTeamEnvironment,
  isFollowingTeamThread,
  isTeamColleagueThread,
  resolveTeamThreadCreatorPseudo,
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
        invites: [],
        threadAttributions: [
          {
            threadId: aliceThreadId,
            teamId,
            creatorMemberId: aliceId,
            creatorPseudo: alice.pseudo,
            viewId,
            locked: false,
            createdAt: "2026-01-01T00:00:01.000Z",
          },
          {
            threadId: bobThreadId,
            teamId,
            creatorMemberId: bobId,
            creatorPseudo: bob.pseudo,
            viewId,
            locked: false,
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
        invites: [],
        threadAttributions: [
          {
            threadId: aliceThreadId,
            teamId,
            creatorMemberId: aliceId,
            creatorPseudo: alice.pseudo,
            viewId,
            locked: false,
            createdAt: "2026-01-01T00:00:01.000Z",
          },
          {
            threadId: bobThreadId,
            teamId,
            creatorMemberId: bobId,
            creatorPseudo: bob.pseudo,
            viewId,
            locked: false,
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
    // A different later run ID not authored by Bob does not falsely inherit Bob's earlier turn.
    expect(
      shouldNotifyForTeamThread({
        teamState: state,
        threadId: aliceThreadId,
        latestRunId: "run-alice-3",
      }),
    ).toBe(false);
  });
});
