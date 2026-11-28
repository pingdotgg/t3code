import {
  EMPTY_TEAM_ENVIRONMENT_STATE,
  type TeamEnvironmentState,
} from "@t3tools/client-runtime/team";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  NonNegativeInt,
  TeamId,
  TeamMemberId,
  TeamThreadNoteId,
  TeamViewId,
  ThreadId,
  type TeamMember,
  type TeamNotificationSoundPreset,
  type TeamPseudo,
  type TeamThreadNote,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render, stubGlobal } from "../../../test/render";
import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
} from "../../hooks/useSettings";
import { TeamLocalThreadSyncCoordinator } from "./TeamLocalThreadSyncCoordinator";

const mockState = vi.hoisted(() => ({
  teamStates: new Map<EnvironmentId, TeamEnvironmentState>(),
  playSound: vi.fn(),
  navigate: vi.fn(),
  toastAdd: vi.fn(() => "toast-1"),
  toastClose: vi.fn(),
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useRouter: (() => ({ navigate: mockState.navigate })) as never,
}));

vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => [],
  useThreadShells: () => [],
}));

vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: [] })) as never,
  usePrimaryEnvironmentId: () => null,
}));

vi.mock(import("~/state/team"), async (original) => ({
  ...(await original()),
  useTeamStatesByEnvironment: () => mockState.teamStates,
}));

vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn(async () => ({ _tag: "Success", value: undefined }))) as never,
}));

vi.mock(import("~/threadNotifications"), async (original) => ({
  ...(await original()),
  playNotificationSound: mockState.playSound,
}));

vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: {
      ...actual.toastManager,
      add: mockState.toastAdd as never,
      close: mockState.toastClose as never,
    },
  };
});

class TestNotification {
  static permission = "granted";
  static sent: Array<{
    readonly title: string;
    readonly options: NotificationOptions | undefined;
  }> = [];
  static throwOnConstruct = false;
  onclick: (() => void) | null = null;
  constructor(title: string, options?: NotificationOptions) {
    if (TestNotification.throwOnConstruct) {
      throw new Error("Notification blocked");
    }
    TestNotification.sent.push({ title, options });
  }
}

describe("TeamLocalThreadSyncCoordinator note alert sounds", () => {
  it("uses per-team sound preset, mutes sound when off, and sends silent desktop notifications", async () => {
    vi.clearAllMocks();
    TestNotification.sent = [];
    TestNotification.throwOnConstruct = false;
    TestNotification.permission = "granted";

    using _notification = stubGlobal("Notification", TestNotification);
    using _focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    using _visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden" as DocumentVisibilityState);
    using _cleanup = {
      [Symbol.dispose]() {
        mockState.teamStates = new Map();
        __resetClientSettingsPersistenceForTests();
      },
    };

    const envId = EnvironmentId.make("env-team-notes");
    const teamId = TeamId.make("team-notes");
    const viewId = TeamViewId.make("view-notes");
    const aliceId = TeamMemberId.make("member-alice");
    const bobId = TeamMemberId.make("member-bob");
    const threadId = ThreadId.make("thread-owned-by-alice");

    const alice: TeamMember = {
      id: aliceId,
      teamId,
      pseudo: "alice" as TeamPseudo,
      role: "owner",
      status: "active",
      createdAt: "2026-09-13T07:00:00.000Z",
      updatedAt: "2026-09-13T07:00:00.000Z",
    };
    const attribution = {
      threadId,
      teamId,
      creatorMemberId: aliceId,
      creatorPseudo: alice.pseudo,
      viewId,
      locked: false,
      lockedByMemberId: null,
      createdAt: "2026-09-13T07:00:00.000Z",
    };
    const baseState: TeamEnvironmentState = {
      ...EMPTY_TEAM_ENVIRONMENT_STATE,
      team: {
        id: teamId,
        name: "Notes Team",
        defaultViewId: viewId,
        createdAt: "2026-09-13T07:00:00.000Z",
        updatedAt: "2026-09-13T07:00:00.000Z",
      },
      currentMember: alice,
      members: [alice],
      threadAttributions: [attribution],
      memberById: new Map([[aliceId, alice]]),
      attributionByThreadId: new Map([[threadId, attribution]]),
    };

    const makeNote = (id: string, body: string): TeamThreadNote => ({
      id: TeamThreadNoteId.make(id),
      threadId,
      teamId,
      authorMemberId: bobId,
      authorPseudo: "bob" as TeamPseudo,
      authorRole: "modo",
      originalBody: body,
      originalContentHash: `hash-${id}`,
      editedBody: null,
      editedContentHash: null,
      status: "pending",
      anchorTurnId: null,
      anchorSeq: NonNegativeInt.make(0),
      includedInTurnId: null,
      resolvedByMemberId: null,
      resolvedByPseudo: null,
      resolvedAt: null,
      createdAt: "2026-09-13T07:01:00.000Z",
    });

    const setTeamSound = (preset: TeamNotificationSoundPreset) => {
      __setClientSettingsForTests({
        ...DEFAULT_CLIENT_SETTINGS,
        notificationMode: "notifications-and-sound",
        teamNotificationSounds: { [teamId]: preset },
      });
    };

    // Initial mount seeds initializedTeamEnvsRef without alerting.
    setTeamSound("bell");
    mockState.teamStates = new Map([[envId, baseState]]);
    await using screen = await render(<TeamLocalThreadSyncCoordinator />);
    expect(mockState.playSound).not.toHaveBeenCalled();
    expect(TestNotification.sent).toHaveLength(0);

    // 1. Incoming note with preset "bell" plays "bell" and creates a silent desktop notification.
    const note1 = makeNote("note-1", "Check the edge case");
    mockState.teamStates = new Map([
      [envId, { ...baseState, threadNotesByThreadId: new Map([[threadId, [note1]]]) }],
    ]);
    await screen.rerender(<TeamLocalThreadSyncCoordinator />);
    expect(mockState.playSound).toHaveBeenCalledTimes(1);
    expect(mockState.playSound).toHaveBeenLastCalledWith("input", expect.any(Function), "bell");
    expect(TestNotification.sent).toHaveLength(1);
    expect(TestNotification.sent[0]?.options?.silent).toBe(true);

    // 2. Incoming note with preset "off" skips Web Audio playback while keeping silent desktop notification.
    setTeamSound("off");
    const note2 = makeNote("note-2", "Quiet note");
    mockState.teamStates = new Map([
      [envId, { ...baseState, threadNotesByThreadId: new Map([[threadId, [note1, note2]]]) }],
    ]);
    await screen.rerender(<TeamLocalThreadSyncCoordinator />);
    expect(mockState.playSound).toHaveBeenCalledTimes(1);
    expect(TestNotification.sent).toHaveLength(2);
    expect(TestNotification.sent[1]?.options?.silent).toBe(true);

    // 3. Throwing Notification constructor is caught cleanly without aborting subsequent notes.
    TestNotification.throwOnConstruct = true;
    setTeamSound("pulse");
    const note3 = makeNote("note-3", "First while blocked");
    const note4 = makeNote("note-4", "Second while blocked");
    mockState.teamStates = new Map([
      [
        envId,
        {
          ...baseState,
          threadNotesByThreadId: new Map([[threadId, [note1, note2, note3, note4]]]),
        },
      ],
    ]);
    await screen.rerender(<TeamLocalThreadSyncCoordinator />);
    expect(mockState.playSound).toHaveBeenCalledTimes(3);
    expect(mockState.playSound).toHaveBeenLastCalledWith("input", expect.any(Function), "pulse");
  });
});
