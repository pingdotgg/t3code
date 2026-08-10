import { MessageId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentThreadShell } from "./state/shell.ts";
import {
  captureThreadSoundState,
  deriveInteractionSoundCues,
  observeThreadSoundState,
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

  it("plays bloom when pending input changes directly to pending approval", () => {
    const pendingInput = makeThread({ hasPendingUserInput: true });
    const pendingApproval = makeThread({ hasPendingApprovals: true });

    expect(
      deriveInteractionSoundCues(captureThreadSoundState([pendingInput]), [pendingApproval]),
    ).toEqual(["bloom"]);
  });

  it("plays bloom when pending approval changes directly to pending input", () => {
    const pendingApproval = makeThread({ hasPendingApprovals: true });
    const pendingInput = makeThread({ hasPendingUserInput: true });

    expect(
      deriveInteractionSoundCues(captureThreadSoundState([pendingApproval]), [pendingInput]),
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

    const seeded = observeThreadSoundState(null, running, {
      environmentLive: true,
      environmentPreviouslyLive: false,
      settingsHydrated: false,
    });
    const frozen = observeThreadSoundState(seeded.state, completed, {
      environmentLive: true,
      environmentPreviouslyLive: true,
      settingsHydrated: false,
    });
    const hydrated = observeThreadSoundState(frozen.state, completed, {
      environmentLive: true,
      environmentPreviouslyLive: true,
      settingsHydrated: true,
    });

    expect(hydrated.cues).toEqual(["success"]);
  });

  it("preserves a thread baseline while its environment is synchronizing", () => {
    const running = makeThread({
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        initiatingUserMessageId: MessageId.make("message-1"),
        state: "running",
        requestedAt: "2026-07-11T12:00:01.000Z",
        startedAt: "2026-07-11T12:00:01.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const completedDuringSync = makeThread({
      latestTurn: {
        ...running.latestTurn!,
        state: "completed",
        completedAt: "2026-07-11T12:00:05.000Z",
      },
    });
    const beforeSync = captureThreadSoundState([running]);
    const whileSynchronizing = observeThreadSoundState(beforeSync, completedDuringSync, {
      environmentLive: false,
      environmentPreviouslyLive: true,
      settingsHydrated: true,
    });
    const reconnected = observeThreadSoundState(whileSynchronizing.state, completedDuringSync, {
      environmentLive: true,
      environmentPreviouslyLive: true,
      settingsHydrated: true,
    });

    expect(reconnected.cues).toEqual(["success"]);
  });

  it("refreshes cached startup state until the environment first becomes live", () => {
    const staleRunning = makeThread({
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        initiatingUserMessageId: MessageId.make("message-1"),
        state: "running",
        requestedAt: "2026-07-11T12:00:00.000Z",
        startedAt: "2026-07-11T12:00:01.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const refreshedCompleted = makeThread({
      latestTurn: {
        ...staleRunning.latestTurn!,
        state: "completed",
        completedAt: "2026-07-11T12:00:05.000Z",
      },
    });
    const seeded = observeThreadSoundState(null, staleRunning, {
      environmentLive: false,
      environmentPreviouslyLive: false,
      settingsHydrated: true,
    });
    const refreshed = observeThreadSoundState(seeded.state, refreshedCompleted, {
      environmentLive: false,
      environmentPreviouslyLive: false,
      settingsHydrated: true,
    });
    const firstLive = observeThreadSoundState(refreshed.state, refreshedCompleted, {
      environmentLive: true,
      environmentPreviouslyLive: false,
      settingsHydrated: true,
    });

    expect(firstLive.cues).toEqual([]);
  });

  it("plays later cues after the first live snapshot seeds the baseline", () => {
    const running = makeThread({
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        initiatingUserMessageId: MessageId.make("message-1"),
        state: "running",
        requestedAt: "2026-07-11T12:00:00.000Z",
        startedAt: "2026-07-11T12:00:01.000Z",
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
    let environmentObservedLive = false;
    const firstLive = observeThreadSoundState(null, running, {
      environmentLive: true,
      environmentPreviouslyLive: environmentObservedLive,
      settingsHydrated: true,
    });
    environmentObservedLive = true;
    const laterUpdate = observeThreadSoundState(firstLive.state, completed, {
      environmentLive: true,
      environmentPreviouslyLive: environmentObservedLive,
      settingsHydrated: true,
    });

    expect(firstLive.cues).toEqual([]);
    expect(laterUpdate.cues).toEqual(["success"]);
  });

  it("detects a user-input request received while its environment is synchronizing", () => {
    const idle = makeThread();
    const pendingInputDuringSync = makeThread({ hasPendingUserInput: true });
    const beforeSync = captureThreadSoundState([idle]);
    const whileSynchronizing = observeThreadSoundState(beforeSync, pendingInputDuringSync, {
      environmentLive: false,
      environmentPreviouslyLive: true,
      settingsHydrated: true,
    });
    const reconnected = observeThreadSoundState(whileSynchronizing.state, pendingInputDuringSync, {
      environmentLive: true,
      environmentPreviouslyLive: true,
      settingsHydrated: true,
    });

    expect(reconnected.cues).toEqual(["bloom"]);
  });

  it("compares a thread first discovered after reconnect with an idle baseline", () => {
    const discovered = observeThreadSoundState(null, makeThread({ hasPendingUserInput: true }), {
      environmentLive: true,
      environmentPreviouslyLive: true,
      settingsHydrated: true,
    });

    expect(discovered.cues).toEqual(["bloom"]);
  });

  it("plays completion for a thread first discovered after reconnect", () => {
    const discovered = observeThreadSoundState(
      null,
      makeThread({
        latestTurn: {
          turnId: TurnId.make("remote-turn"),
          initiatingUserMessageId: MessageId.make("remote-message"),
          state: "completed",
          requestedAt: "2026-07-11T12:00:01.000Z",
          startedAt: "2026-07-11T12:00:02.000Z",
          completedAt: "2026-07-11T12:00:05.000Z",
          assistantMessageId: null,
        },
      }),
      {
        environmentLive: true,
        environmentPreviouslyLive: true,
        settingsHydrated: true,
      },
    );

    expect(discovered.cues).toEqual(["success"]);
  });

  it("seeds a thread from the first live hydration without playing a cue", () => {
    const discovered = observeThreadSoundState(null, makeThread({ hasPendingUserInput: true }), {
      environmentLive: true,
      environmentPreviouslyLive: false,
      settingsHydrated: true,
    });

    expect(discovered.cues).toEqual([]);
  });

  it("keeps input-request cues enabled when completion sounds are disabled", () => {
    expect(shouldPlayInteractionSound("success", false)).toBe(false);
    expect(shouldPlayInteractionSound("bloom", false)).toBe(true);
  });
});
