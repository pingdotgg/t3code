import {
  EnvironmentId,
  type GitActionProgressEvent,
  type GitRunStackedActionResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { AtomCommandResult } from "./runtime.ts";
import {
  applyVcsActionProgressEvent,
  beginVcsActionState,
  consumeVcsActionProgress,
  createVcsActionManager,
  createVcsActionTransportId,
  EMPTY_VCS_ACTION_STATE,
  getVcsActionTargetKey,
  normalizeVcsActionProgressEvent,
  parseVcsActionTargetKey,
  VcsActionMissingTerminalEventError,
  VcsActionRemoteFailureError,
  VcsActionTargetKeyParseError,
  VcsActionUnavailableError,
} from "./vcsAction.ts";

const actionId = "action-123";
const action = "commit_push" as const;
const cwd = "/repo";
const environmentId = EnvironmentId.make("environment-1");
const isVcsActionUnavailableError = Schema.is(VcsActionUnavailableError);
const result: GitRunStackedActionResult = {
  action,
  branch: {
    status: "skipped_not_requested",
  },
  commit: {
    status: "created",
    commitSha: "abc123",
    subject: "Test commit",
  },
  push: {
    status: "pushed",
    branch: "feature",
  },
  pr: {
    status: "skipped_not_requested",
  },
  toast: {
    title: "Changes pushed",
    cta: {
      kind: "none",
    },
  },
};

function progress<T extends GitActionProgressEvent>(event: T): T {
  return event;
}

describe("vcsActionState", () => {
  it("preserves malformed target key diagnostics and the native cause without copying the key", () => {
    const key = "not-json-with-credential=do-not-log";
    let error: unknown;

    try {
      parseVcsActionTargetKey(key);
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(VcsActionTargetKeyParseError);
    expect(error).toMatchObject({ keyLength: key.length, cause: expect.any(SyntaxError) });
    expect(error).not.toHaveProperty("key");
    expect((error as Error).message).not.toContain(key);
  });

  it("rejects invalid target key shapes", () => {
    const key = JSON.stringify([environmentId]);

    expect(() => parseVcsActionTargetKey(key)).toThrowError(VcsActionTargetKeyParseError);
  });

  it("projects phase and hook progress without owning the async operation", () => {
    const initial = beginVcsActionState({
      operation: "run_change_request",
      label: "Running source control action",
      actionId,
    });
    const phase = applyVcsActionProgressEvent(
      initial,
      progress({
        actionId,
        action,
        cwd,
        kind: "phase_started",
        phase: "commit",
        label: "Committing...",
      }),
    );
    const hook = applyVcsActionProgressEvent(
      phase,
      progress({
        actionId,
        action,
        cwd,
        kind: "hook_started",
        hookName: "post-commit",
      }),
    );
    const output = applyVcsActionProgressEvent(
      hook,
      progress({
        actionId,
        action,
        cwd,
        kind: "hook_output",
        hookName: "post-commit",
        stream: "stdout",
        text: "hook output",
      }),
    );
    const finished = applyVcsActionProgressEvent(
      output,
      progress({
        actionId,
        action,
        cwd,
        kind: "hook_finished",
        hookName: "post-commit",
        exitCode: 0,
        durationMs: 12,
      }),
    );

    expect(phase).toMatchObject({
      isRunning: true,
      currentLabel: "Committing...",
      currentPhaseLabel: "Committing...",
    });
    expect(output).toMatchObject({
      currentLabel: "Running post-commit...",
      hookName: "post-commit",
      lastOutputLine: "hook output",
    });
    expect(finished).toMatchObject({
      currentLabel: "Committing...",
      hookName: null,
      lastOutputLine: null,
    });
  });

  it("retains a terminal action error for presentation", () => {
    const initial = beginVcsActionState({
      operation: "run_change_request",
      label: "Running source control action",
      actionId,
    });
    const failed = applyVcsActionProgressEvent(
      initial,
      progress({
        actionId,
        action,
        cwd,
        kind: "action_failed",
        phase: null,
        message: "Push failed.",
      }),
    );

    expect(failed).toMatchObject({
      isRunning: false,
      operation: "run_change_request",
      actionId,
      action,
      error: "Push failed.",
    });
  });

  it("ignores progress after a newer action owns the target", () => {
    const current = beginVcsActionState({
      operation: "pull",
      label: "Pulling latest changes",
      actionId: "newer-action",
    });

    expect(
      applyVcsActionProgressEvent(
        current,
        progress({
          actionId,
          action,
          cwd,
          kind: "phase_started",
          phase: "push",
          label: "Pushing...",
        }),
      ),
    ).toBe(current);
  });

  it("keys presentation state only when the environment and repository are known", () => {
    expect(
      getVcsActionTargetKey({
        environmentId,
        cwd,
      }),
    ).toBe(JSON.stringify([environmentId, cwd]));
    expect(getVcsActionTargetKey({ environmentId: null, cwd })).toBeNull();
    expect(
      getVcsActionTargetKey({
        environmentId,
        cwd: null,
      }),
    ).toBeNull();
  });

  it("normalizes progress only for the matching environment-scoped action", () => {
    const target = { environmentId, cwd };
    const otherTarget = {
      environmentId: EnvironmentId.make("environment-2"),
      cwd,
    };
    const transportActionId = createVcsActionTransportId(target, actionId);
    const event = progress({
      actionId: createVcsActionTransportId(otherTarget, actionId),
      action,
      cwd,
      kind: "phase_started",
      phase: "push",
      label: "Pushing...",
    });

    expect(normalizeVcsActionProgressEvent(target, transportActionId, actionId, event)).toBeNull();
    expect(
      normalizeVcsActionProgressEvent(target, transportActionId, actionId, {
        ...event,
        actionId: transportActionId,
      }),
    ).toEqual({
      ...event,
      actionId,
    });
  });

  it.effect("consumes progress through the terminal event and returns its result", () =>
    Effect.gen(function* () {
      const target = { environmentId, cwd };
      const transportActionId = createVcsActionTransportId(target, actionId);
      const observed: GitActionProgressEvent[] = [];
      const events: GitActionProgressEvent[] = [
        {
          actionId: "unrelated-action",
          action,
          cwd,
          kind: "phase_started",
          phase: "commit",
          label: "Ignored",
        },
        {
          actionId: transportActionId,
          action,
          cwd,
          kind: "phase_started",
          phase: "push",
          label: "Pushing...",
        },
        {
          actionId: transportActionId,
          action,
          cwd,
          kind: "action_finished",
          result,
        },
      ];

      const actual = yield* consumeVcsActionProgress(Stream.fromIterable(events), {
        target,
        transportActionId,
        actionId,
        action,
        onProgress: (event) =>
          Effect.sync(() => {
            observed.push(event);
          }),
      });

      expect(actual).toEqual(result);
      expect(observed.map((event) => event.actionId)).toEqual([actionId, actionId]);
      expect(observed.map((event) => event.kind)).toEqual(["phase_started", "action_finished"]);
    }),
  );

  it.effect("retains structural remote failure context without copying the remote payload", () =>
    Effect.gen(function* () {
      const target = { environmentId, cwd };
      const transportActionId = createVcsActionTransportId(target, actionId);
      const remoteMessage = "The remote rejected the push with credential=do-not-log.";
      const error = yield* consumeVcsActionProgress(
        Stream.fromIterable<GitActionProgressEvent>([
          {
            actionId: transportActionId,
            action,
            cwd,
            kind: "action_failed",
            phase: "push",
            message: remoteMessage,
          },
        ]),
        {
          target,
          transportActionId,
          actionId,
          action,
          onProgress: () => Effect.void,
        },
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(VcsActionRemoteFailureError);
      expect(error).toMatchObject({
        actionId,
        transportActionId,
        action,
        environmentId,
        cwd,
        phase: "push",
        remoteMessageLength: remoteMessage.length,
      });
      expect(error).not.toHaveProperty("detail");
      expect(error.message).toBe("Source control action 'commit_push' failed during push.");
      expect(error.message).not.toContain(remoteMessage);
    }),
  );

  it.effect("reports a missing terminal event as a protocol failure", () =>
    Effect.gen(function* () {
      const target = { environmentId, cwd };
      const transportActionId = createVcsActionTransportId(target, actionId);
      const error = yield* consumeVcsActionProgress(
        Stream.fromIterable<GitActionProgressEvent>([
          {
            actionId: transportActionId,
            action,
            cwd,
            kind: "phase_started",
            phase: "commit",
            label: "Committing...",
          },
        ]),
        {
          target,
          transportActionId,
          actionId,
          action,
          onProgress: () => Effect.void,
        },
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(VcsActionMissingTerminalEventError);
      expect(error).toMatchObject({
        actionId,
        transportActionId,
        action,
        environmentId,
        cwd,
      });
      expect(error.message).toBe(
        "Source control action 'commit_push' ended without a terminal result.",
      );
    }),
  );

  it("keys mutation ownership by environment and cwd", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry,
      never
    >;
    const manager = createVcsActionManager(runtime);
    const registry = AtomRegistry.make();
    const target = { environmentId, cwd };
    const otherTarget = {
      environmentId: EnvironmentId.make("environment-2"),
      cwd,
    };

    expect(manager.runStackedAction(target)).toBe(manager.runStackedAction({ ...target }));
    expect(manager.runStackedAction(target)).not.toBe(manager.runStackedAction(otherTarget));
    expect(registry.get(manager.stateAtom(target))).toEqual(EMPTY_VCS_ACTION_STATE);

    registry.dispose();
  });

  it("retains the incomplete target and operation when tracking is unavailable", async () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry,
      never
    >;
    const manager = createVcsActionManager(runtime);
    const registry = AtomRegistry.make();
    const result = await manager.track(
      registry,
      { environmentId, cwd: null },
      { operation: "pull", label: "Pulling latest changes" },
      async () => AsyncResult.success(undefined),
    );

    expect(AsyncResult.isFailure(result)).toBe(true);
    if (AsyncResult.isFailure(result)) {
      const error = Cause.squash(result.cause);
      expect(error).toBeInstanceOf(VcsActionUnavailableError);
      if (!isVcsActionUnavailableError(error)) {
        throw error;
      }
      expect(error).toMatchObject({
        operation: "pull",
        environmentId,
        cwd: null,
      });
      expect(error.message).toBe("Source control operation 'pull' is unavailable.");
    }

    registry.dispose();
  });

  it("tracks finite mutations without letting an older completion clear newer state", async () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry,
      never
    >;
    const manager = createVcsActionManager(runtime);
    const registry = AtomRegistry.make();
    const target = { environmentId, cwd };
    let finishFirst!: () => void;
    let failSecond!: (error: Error) => void;
    const firstAction = new Promise<AtomCommandResult<void, never>>((resolve) => {
      finishFirst = () => resolve(AsyncResult.success(undefined));
    });
    const secondAction = new Promise<AtomCommandResult<void, Error>>((resolve) => {
      failSecond = (error) => resolve(AsyncResult.failure(Cause.fail(error)));
    });

    const first = manager.track(
      registry,
      target,
      { operation: "pull", label: "Pulling latest changes" },
      () => firstAction,
    );
    const firstActionId = registry.get(manager.stateAtom(target)).actionId;
    const second = manager.track(
      registry,
      target,
      { operation: "switch_ref", label: "Switching branch" },
      () => secondAction,
    );
    const secondActionId = registry.get(manager.stateAtom(target)).actionId;

    finishFirst();
    await first;
    expect(registry.get(manager.stateAtom(target))).toMatchObject({
      actionId: secondActionId,
      isRunning: true,
      operation: "switch_ref",
    });
    expect(secondActionId).not.toBe(firstActionId);

    failSecond(new Error("switch failed"));
    const secondFailure = await second;
    expect(AsyncResult.isFailure(secondFailure)).toBe(true);
    expect(registry.get(manager.stateAtom(target))).toMatchObject({
      actionId: secondActionId,
      error: "switch failed",
      isRunning: false,
      operation: "switch_ref",
    });

    registry.dispose();
  });
});
