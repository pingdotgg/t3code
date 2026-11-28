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

interface FakeBuffer {
  readonly duration: number;
  readonly sampleRate: number;
  readonly length: number;
  readonly data: Float32Array;
  getChannelData: (channel: number) => Float32Array;
}

const audio = {
  currentTime: 0,
  started: 0,
  stopped: 0,
  resumed: 0,
  createdBuffers: 0,
  initialState: "running" as AudioContextState,
  lastPlayedBuffer: null as FakeBuffer | { duration: number } | null,
};

class FakeAudioContext {
  state: AudioContextState = audio.initialState;
  sampleRate = 44100;
  destination = {};
  get currentTime() {
    return audio.currentTime;
  }
  resume() {
    audio.resumed += 1;
    this.state = "running";
    return Promise.resolve();
  }
  decodeAudioData() {
    return Promise.resolve({ duration: SOUND_SECONDS });
  }
  createBuffer(_channels: number, length: number, sampleRate: number): FakeBuffer {
    audio.createdBuffers += 1;
    const data = new Float32Array(length);
    return {
      duration: length / sampleRate,
      sampleRate,
      length,
      data,
      getChannelData: () => data,
    };
  }
  createBufferSource() {
    const source = {
      buffer: null as FakeBuffer | { duration: number } | null,
      onended: null as (() => void) | null,
      connect() {},
      start() {
        audio.started += 1;
        audio.lastPlayedBuffer = source.buffer;
      },
      stop() {
        audio.stopped += 1;
      },
    };
    return source;
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
  audio.stopped = 0;
  audio.resumed = 0;
  audio.createdBuffers = 0;
  audio.initialState = "running";
  audio.lastPlayedBuffer = null;
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

  it("synthesizes, caches, and coalesces Web Audio buffers for all team presets without network fetches", async () => {
    const { playNotificationSound } = await loadUnlocked();
    vi.mocked(fetch).mockClear();

    for (const preset of ["chime", "bell", "marimba", "pulse"] as const) {
      await playNotificationSound("completion", () => true, preset);
      const completionBuffer = audio.lastPlayedBuffer as FakeBuffer;
      expect(completionBuffer.duration).toBeGreaterThan(0.3);
      let completionPeak = 0;
      for (const sample of completionBuffer.data) {
        const abs = Math.abs(sample);
        if (abs > completionPeak) completionPeak = abs;
      }
      expect(completionPeak).toBeGreaterThan(0.2);
      expect(completionPeak).toBeLessThanOrEqual(0.4);

      await playNotificationSound("input", () => true, preset);
      const inputBuffer = audio.lastPlayedBuffer as FakeBuffer;
      expect(inputBuffer).not.toBe(completionBuffer);
    }

    // 4 presets x 2 kinds = 8 synthesized buffers, zero MP3 fetches.
    expect(audio.createdBuffers).toBe(8);
    expect(audio.started).toBe(8);
    expect(fetch).not.toHaveBeenCalled();

    // Burst on same (preset, kind) coalesces; after duration passes it plays from cache without re-synthesizing.
    await playNotificationSound("completion", () => true, "chime");
    expect(audio.started).toBe(8);

    audio.currentTime += 2;
    await playNotificationSound("completion", () => true, "chime");
    expect(audio.started).toBe(9);
    expect(audio.createdBuffers).toBe(8);
  });

  it("skips playback entirely when preset is off", async () => {
    const { playNotificationSound } = await loadUnlocked();
    vi.mocked(fetch).mockClear();

    await playNotificationSound("completion", () => true, "off");
    await playNotificationSound("input", () => true, "off");

    expect(audio.started).toBe(0);
    expect(audio.createdBuffers).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("unlocks suspended audio and prevents overlap clipping on previewTeamNotificationSound", async () => {
    audio.initialState = "suspended";
    const { previewTeamNotificationSound } = await import("./threadNotifications");

    await previewTeamNotificationSound("off");
    expect(audio.started).toBe(0);
    expect(audio.resumed).toBe(0);

    await previewTeamNotificationSound("chime");
    expect(audio.resumed).toBe(1);
    expect(audio.started).toBe(1);
    expect(audio.stopped).toBe(0);

    // Triggering another preview immediately stops the prior preview source to prevent clipping.
    await previewTeamNotificationSound("bell");
    expect(audio.stopped).toBe(1);
    expect(audio.started).toBe(2);

    // Classic preview uses the bundled MP3 buffer.
    await previewTeamNotificationSound("classic");
    expect(audio.stopped).toBe(2);
    expect(audio.started).toBe(3);
  });

  it("handles AudioContext construction failures and ignores stale async preview completions", async () => {
    vi.stubGlobal("AudioContext", function ThrowingAudioContext() {
      throw new Error("AudioContext limit reached");
    });
    const failingModule = await import("./threadNotifications");
    await expect(failingModule.previewTeamNotificationSound("chime")).resolves.toBeUndefined();

    // Verify generation guard: a slow classic fetch resolving after a newer bell preview does not play.
    vi.resetModules();
    audio.started = 0;
    audio.stopped = 0;
    audio.resumed = 0;
    audio.initialState = "running";
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const pendingFetches: Array<(value: { arrayBuffer: () => Promise<ArrayBuffer> }) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<{ arrayBuffer: () => Promise<ArrayBuffer> }>((resolve) => {
            pendingFetches.push(resolve);
          }),
      ),
    );
    const notifications = await import("./threadNotifications");
    const classicPromise = notifications.previewTeamNotificationSound("classic");
    const bellPromise = notifications.previewTeamNotificationSound("bell");
    await bellPromise;
    expect(audio.started).toBe(1);

    for (const resolve of pendingFetches) {
      resolve({ arrayBuffer: async () => new ArrayBuffer(0) });
    }
    await classicPromise;
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
      snoozedByThreadId: new Map(),
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
      githubAppConfig: null,
      scheduledTaskMetas: [],
      scheduledTaskMetaByTaskId: new Map(),
      queuedMessageNotifications: [],
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

  it("formats queued-message notifications and builds stable short tags", async () => {
    const { EnvironmentId } = await import("@t3tools/contracts");
    const { formatTeamQueuedMessageNotification, teamQueuedMessageNotificationTag } =
      await import("./threadNotifications");

    expect(
      formatTeamQueuedMessageNotification({
        senderPseudo: "bob",
        threadTitle: "Release checklist",
        messagePreview: "Please run the migration check",
      }),
    ).toEqual({
      title: 'bob queued a message in "Release checklist"',
      body: "Please run the migration check",
    });

    expect(
      formatTeamQueuedMessageNotification({
        senderPseudo: "bob",
        threadTitle: "",
        messagePreview: "   ",
      }),
    ).toEqual({
      title: "bob queued a message",
      body: "Open thread to review or click Send now.",
    });

    const tagA = teamQueuedMessageNotificationTag(
      EnvironmentId.make("env-1"),
      aliceThreadId,
      "run-queued-1",
    );
    const tagB = teamQueuedMessageNotificationTag(
      EnvironmentId.make("env-1"),
      aliceThreadId,
      "run-queued-2",
    );
    expect(tagA).toHaveLength(16);
    expect(tagA).not.toBe(tagB);
  });
});
