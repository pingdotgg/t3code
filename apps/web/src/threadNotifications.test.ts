import {
  EMPTY_TEAM_ENVIRONMENT_STATE,
  type TeamEnvironmentState,
} from "@t3tools/client-runtime/team";
import {
  TeamId,
  TeamMemberId,
  TeamViewId,
  ThreadId,
  type TeamMember,
  type TeamPseudo,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const SOUND_SECONDS = 0.6;

const audio = { currentTime: 0, started: 0 };

class FakeAudioContext {
  state = "running";
  destination = {};
  get currentTime() {
    return audio.currentTime;
  }
  resume() {
    return Promise.resolve();
  }
  decodeAudioData() {
    return Promise.resolve({ duration: SOUND_SECONDS });
  }
  createBufferSource() {
    return {
      buffer: null,
      connect() {},
      start() {
        audio.started += 1;
      },
    };
  }
}

async function loadUnlocked() {
  const notifications = await import("./threadNotifications");
  notifications.unlockNotificationAudio();
  return notifications;
}

beforeEach(() => {
  vi.resetModules();
  audio.currentTime = 0;
  audio.started = 0;
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(0) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("playNotificationSound", () => {
  it("preloads both sounds on unlock and reuses them for playback", async () => {
    const { unlockNotificationAudio, playNotificationSound } = await loadUnlocked();
    expect(fetch).toHaveBeenCalledTimes(2);
    unlockNotificationAudio();
    await playNotificationSound("completion", () => true);
    await playNotificationSound("input", () => true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(audio.started).toBe(2);
  });

  it("retries failed preloads on an alert rather than every gesture", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    const { unlockNotificationAudio, playNotificationSound } = await loadUnlocked();
    await playNotificationSound("completion", () => true);
    expect(fetch).toHaveBeenCalledTimes(2);

    unlockNotificationAudio();
    expect(fetch).toHaveBeenCalledTimes(2);

    vi.mocked(fetch).mockResolvedValue(new Response(new ArrayBuffer(0)));
    await playNotificationSound("completion", () => true);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(audio.started).toBe(1);
  });

  it("plays one sound for threads that complete together", async () => {
    const { playNotificationSound } = await loadUnlocked();

    await Promise.all(
      Array.from({ length: 4 }, () => playNotificationSound("completion", () => true)),
    );

    expect(audio.started).toBe(1);
  });

  it("still plays an input alert over a completion sound", async () => {
    const { playNotificationSound } = await loadUnlocked();
    await playNotificationSound("completion", () => true);

    await playNotificationSound("input", () => true);

    expect(audio.started).toBe(2);
  });

  it("leaves the slot free when a sound is turned off before it plays", async () => {
    const { playNotificationSound } = await loadUnlocked();
    await playNotificationSound("completion", () => false);

    await playNotificationSound("completion", () => true);

    expect(audio.started).toBe(1);
  });
});

describe("team notification gating helpers", () => {
  const teamId = TeamId.make("team-1");
  const viewId = TeamViewId.make("view-1");
  const aliceId = TeamMemberId.make("member-alice");
  const bobId = TeamMemberId.make("member-bob");
  const aliceThreadId = ThreadId.make("thread-alice");

  const makeTeamState = (overrides: Partial<TeamEnvironmentState> = {}): TeamEnvironmentState => {
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
    const attribution = {
      threadId: aliceThreadId,
      teamId,
      creatorMemberId: aliceId,
      creatorPseudo: alice.pseudo,
      viewId,
      locked: false,
      lockedByMemberId: null,
      createdAt: "2026-01-01T00:00:01.000Z",
    };
    return {
      team: {
        id: teamId,
        name: "Core",
        defaultViewId: viewId,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      currentMember: bob,
      members: [alice, bob],
      views: [],
      invites: [],
      threadAttributions: [attribution],
      followedThreadIds: new Set(),
      latestTurnByThreadId: new Map(),
      turnAuthorByTurnId: new Map(),
      memberById: new Map([
        [aliceId, alice],
        [bobId, bob],
      ]),
      viewById: new Map(),
      attributionByThreadId: new Map([[aliceThreadId, attribution]]),
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
      ...overrides,
    };
  };

  it("leaves personal mode untouched and gates team threads by creator, follow, or completing turn author", async () => {
    const {
      formatTeamNotificationThreadTitle,
      resolveTeamEnvironmentThreadNotificationDecision,
      shouldNotifyForTeamEnvironmentThread,
    } = await import("./threadNotifications");

    expect(
      resolveTeamEnvironmentThreadNotificationDecision({
        teamState: null,
        threadId: aliceThreadId,
        latestRunId: "run-1",
      }),
    ).toBe("defer");
    expect(
      shouldNotifyForTeamEnvironmentThread({
        teamState: EMPTY_TEAM_ENVIRONMENT_STATE,
        threadId: aliceThreadId,
        latestRunId: "run-1",
      }),
    ).toBe(true);
    expect(
      formatTeamNotificationThreadTitle({
        title: "Personal task",
        teamState: EMPTY_TEAM_ENVIRONMENT_STATE,
        threadId: aliceThreadId,
      }),
    ).toBe("Personal task");

    const aliceTurn = {
      turnId: "run-alice-1",
      threadId: aliceThreadId,
      authorMemberId: aliceId,
      authorPseudo: "alice" as TeamPseudo,
      createdAt: "2026-01-01T00:00:01.000Z",
    };
    const silenced = makeTeamState({
      latestTurnByThreadId: new Map([[aliceThreadId, aliceTurn]]),
      turnAuthorByTurnId: new Map([[aliceTurn.turnId, aliceTurn]]),
    });
    expect(
      resolveTeamEnvironmentThreadNotificationDecision({
        teamState: silenced,
        threadId: aliceThreadId,
        latestRunId: "run-alice-1",
      }),
    ).toBe("suppress");
    expect(
      resolveTeamEnvironmentThreadNotificationDecision({
        teamState: silenced,
        threadId: aliceThreadId,
        latestRunId: "run-in-flight",
      }),
    ).toBe("defer");
    expect(
      shouldNotifyForTeamEnvironmentThread({
        teamState: silenced,
        threadId: aliceThreadId,
        latestRunId: "run-alice-1",
      }),
    ).toBe(false);
    expect(
      formatTeamNotificationThreadTitle({
        title: "Fix login",
        teamState: silenced,
        threadId: aliceThreadId,
      }),
    ).toBe("alice: Fix login");

    const followed = makeTeamState({ followedThreadIds: new Set([aliceThreadId]) });
    expect(
      shouldNotifyForTeamEnvironmentThread({
        teamState: followed,
        threadId: aliceThreadId,
        latestRunId: "run-alice-1",
      }),
    ).toBe(true);

    const bobTurn = {
      turnId: "run-bob-2",
      threadId: aliceThreadId,
      authorMemberId: bobId,
      authorPseudo: "bob" as TeamPseudo,
      createdAt: "2026-01-01T00:00:02.000Z",
    };
    const ownTurn = makeTeamState({
      latestTurnByThreadId: new Map([[aliceThreadId, bobTurn]]),
      turnAuthorByTurnId: new Map([[bobTurn.turnId, bobTurn]]),
    });
    expect(
      shouldNotifyForTeamEnvironmentThread({
        teamState: ownTurn,
        threadId: aliceThreadId,
        latestRunId: "run-bob-2",
      }),
    ).toBe(true);
  });
});
