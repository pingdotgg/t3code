import { EnvironmentId, MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentThreadShell } from "./state/shell.ts";
import {
  captureThreadSoundState,
  captureThreadSoundStateWhileSettingsHydrating,
  deriveInteractionSoundCues,
  selectLiveThreadShells,
  shouldPlayInteractionSound,
} from "./interactionSounds.ts";

function makeThread(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    environmentId: "environment-1",
    id: "thread-1",
    projectId: "project-1",
    title: "Thread",
    modelSelection: null,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-07-11T12:00:00.000Z",
    updatedAt: "2026-07-11T12:00:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  } as EnvironmentThreadShell;
}

describe("interaction sounds", () => {
  it("plays success when a turn is associated with its initiating user message", () => {
    const running = makeThread({
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        initiatingUserMessageId: MessageId.make("message-1"),
        state: "running",
        requestedAt: "2026-07-11T12:00:02.000Z",
        startedAt: "2026-07-11T12:00:03.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const completed = makeThread({
      latestTurn: {
        ...running.latestTurn!,
        state: "completed",
        completedAt: "2026-07-11T12:00:05.000Z",
      },
    });

    expect(deriveInteractionSoundCues(captureThreadSoundState([running]), [completed])).toEqual([
      "success",
    ]);
  });

  it("supports older shells where a normal user message precedes provider startup", () => {
    const running = makeThread({
      latestUserMessageAt: "2026-07-11T12:00:00.000Z",
      latestTurn: {
        turnId: TurnId.make("legacy-turn"),
        state: "running",
        requestedAt: "2026-07-11T12:00:02.000Z",
        startedAt: "2026-07-11T12:00:03.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const completed = makeThread({
      latestUserMessageAt: running.latestUserMessageAt,
      latestTurn: {
        ...running.latestTurn!,
        state: "completed",
        completedAt: "2026-07-11T12:00:05.000Z",
      },
    });

    expect(deriveInteractionSoundCues(captureThreadSoundState([running]), [completed])).toEqual([
      "success",
    ]);
  });

  it("does not let a later steering message associate a background subagent turn", () => {
    const backgroundRunning = makeThread({
      latestUserMessageAt: "2026-07-11T12:00:00.000Z",
      latestTurn: {
        turnId: TurnId.make("subagent-turn"),
        initiatingUserMessageId: null,
        state: "running",
        requestedAt: "2026-07-11T12:05:00.000Z",
        startedAt: "2026-07-11T12:05:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const completedAfterSteering = makeThread({
      latestUserMessageAt: "2026-07-11T12:06:00.000Z",
      latestTurn: {
        ...backgroundRunning.latestTurn!,
        state: "completed",
        completedAt: "2026-07-11T12:06:05.000Z",
      },
    });

    expect(
      deriveInteractionSoundCues(captureThreadSoundState([backgroundRunning]), [
        completedAfterSteering,
      ]),
    ).toEqual([]);
  });

  it("does not associate an old user message with later background work", () => {
    const beforeBackgroundWork = makeThread({
      latestUserMessageAt: "2026-07-11T12:00:00.000Z",
    });
    const completedBackgroundTurn = makeThread({
      latestUserMessageAt: beforeBackgroundWork.latestUserMessageAt,
      latestTurn: {
        turnId: TurnId.make("background-turn"),
        state: "completed",
        requestedAt: "2026-07-11T12:05:00.000Z",
        startedAt: "2026-07-11T12:05:00.000Z",
        completedAt: "2026-07-11T12:05:05.000Z",
        assistantMessageId: null,
      },
    });

    expect(
      deriveInteractionSoundCues(captureThreadSoundState([beforeBackgroundWork]), [
        completedBackgroundTurn,
      ]),
    ).toEqual([]);
  });

  it("plays bloom when a thread starts requesting user input", () => {
    const thread = makeThread();

    expect(
      deriveInteractionSoundCues(captureThreadSoundState([thread]), [
        makeThread({ hasPendingUserInput: true }),
      ]),
    ).toEqual(["bloom"]);
  });

  it("plays bloom when a thread starts requesting approval", () => {
    const thread = makeThread();

    expect(
      deriveInteractionSoundCues(captureThreadSoundState([thread]), [
        makeThread({ hasPendingApprovals: true }),
      ]),
    ).toEqual(["bloom"]);
  });

  it("does not replay cues for unchanged state", () => {
    const thread = makeThread({
      latestUserMessageAt: "2026-07-11T12:00:00.000Z",
      hasPendingUserInput: true,
      hasPendingApprovals: true,
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: "2026-07-11T12:00:00.000Z",
        startedAt: "2026-07-11T12:00:01.000Z",
        completedAt: "2026-07-11T12:00:05.000Z",
        assistantMessageId: null,
      },
    });

    expect(deriveInteractionSoundCues(captureThreadSoundState([thread]), [thread])).toEqual([]);
  });

  it("does not replay success when a completed turn timestamp is corrected", () => {
    const completed = makeThread({
      latestUserMessageAt: "2026-07-11T12:00:00.000Z",
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: "2026-07-11T12:00:01.000Z",
        startedAt: "2026-07-11T12:00:02.000Z",
        completedAt: "2026-07-11T12:00:05.000Z",
        assistantMessageId: null,
      },
    });
    const corrected = makeThread({
      latestUserMessageAt: completed.latestUserMessageAt,
      latestTurn: {
        ...completed.latestTurn!,
        completedAt: "2026-07-11T12:00:06.000Z",
      },
    });

    expect(deriveInteractionSoundCues(captureThreadSoundState([completed]), [corrected])).toEqual(
      [],
    );
  });

  it("does not play cues while existing threads are first hydrated", () => {
    const thread = makeThread({
      hasPendingUserInput: true,
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: "2026-07-11T12:00:00.000Z",
        startedAt: "2026-07-11T12:00:01.000Z",
        completedAt: "2026-07-11T12:00:05.000Z",
        assistantMessageId: null,
      },
    });

    expect(deriveInteractionSoundCues(new Map(), [thread])).toEqual([]);
  });

  it("preserves pre-hydration thread state so cues can play after settings hydrate", () => {
    const running = makeThread({
      latestUserMessageAt: "2026-07-11T12:00:00.000Z",
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "running",
        requestedAt: "2026-07-11T12:00:01.000Z",
        startedAt: "2026-07-11T12:00:01.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const completed = makeThread({
      latestUserMessageAt: running.latestUserMessageAt,
      latestTurn: {
        ...running.latestTurn!,
        state: "completed",
        completedAt: "2026-07-11T12:00:05.000Z",
      },
    });

    const seeded = captureThreadSoundStateWhileSettingsHydrating(null, [running]);
    const frozen = captureThreadSoundStateWhileSettingsHydrating(seeded, [completed]);

    expect(deriveInteractionSoundCues(frozen, [completed])).toEqual(["success"]);
  });

  it("admits newly seen threads while settings are hydrating", () => {
    const seeded = captureThreadSoundStateWhileSettingsHydrating(null, []);
    const withThread = captureThreadSoundStateWhileSettingsHydrating(seeded, [
      makeThread({ hasPendingUserInput: true }),
    ]);

    expect(
      deriveInteractionSoundCues(withThread, [makeThread({ hasPendingUserInput: true })]),
    ).toEqual([]);
  });

  it("keeps input-request cues enabled when completion sounds are disabled", () => {
    expect(shouldPlayInteractionSound("success", false)).toBe(false);
    expect(shouldPlayInteractionSound("bloom", false)).toBe(true);
  });

  it("excludes cached thread shells until their environment is live", () => {
    const cached = makeThread({ environmentId: EnvironmentId.make("cached-environment") });
    const live = makeThread({
      environmentId: EnvironmentId.make("live-environment"),
      id: ThreadId.make("thread-2"),
    });

    expect(
      selectLiveThreadShells([cached, live], new Set([live.environmentId])).map(
        (thread) => thread.id,
      ),
    ).toEqual(["thread-2"]);
  });
});
