import {
  EnvironmentId,
  WS_METHODS,
  type GitActionProgressEvent,
  type GitRunStackedActionResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
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
import { vcsRefsCacheStateAtom } from "./vcsRefInvalidation.ts";

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

const target = new PrimaryConnectionTarget({
  environmentId,
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

function progress<T extends GitActionProgressEvent>(event: T): T {
  return event;
}

function cacheStore(onClearVcsRefs: (environmentId: EnvironmentId) => void) {
  return Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeed(Option.none()),
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeed(Option.none()),
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeed(Option.none()),
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeed(Option.none()),
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: (environmentId) => Effect.sync(() => onClearVcsRefs(environmentId)),
    clear: () => Effect.void,
  });
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

  it("keeps running presentation state until the finished action settles", () => {
    const initial = beginVcsActionState({
      operation: "run_change_request",
      label: "Running source control action",
      actionId,
    });
    const pushing = applyVcsActionProgressEvent(
      initial,
      progress({
        actionId,
        action,
        cwd,
        kind: "phase_started",
        phase: "push",
        label: "Pushing...",
      }),
    );
    const finished = applyVcsActionProgressEvent(
      pushing,
      progress({
        actionId,
        action,
        cwd,
        kind: "action_finished",
        result,
      }),
    );

    expect(finished).toMatchObject({
      isRunning: true,
      operation: "run_change_request",
      actionId,
      action,
      currentLabel: "Pushing...",
      currentPhaseLabel: "Pushing...",
      lastOutputLine: null,
      error: null,
    });
  });

  it("keeps running presentation state and retains a terminal action error until settle", () => {
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
      isRunning: true,
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
      EnvironmentRegistry.EnvironmentRegistry | Persistence.EnvironmentCacheStore,
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
      EnvironmentRegistry.EnvironmentRegistry | Persistence.EnvironmentCacheStore,
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
      EnvironmentRegistry.EnvironmentRegistry | Persistence.EnvironmentCacheStore,
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

  it.effect("invalidates persisted refs after successful and failed stacked actions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connectionState: SupervisorConnectionState = {
          ...AVAILABLE_CONNECTION_STATE,
          desired: true,
          network: "online",
          phase: "connected",
          attempt: 1,
          generation: 1,
        };
        const targetKey = { environmentId, cwd };
        const successfulActionId = "invalidate-success";
        const failedActionId = "invalidate-failure";
        const interruptedActionId = "invalidate-interrupted";
        const successfulTransportActionId = createVcsActionTransportId(
          targetKey,
          successfulActionId,
        );
        const failedTransportActionId = createVcsActionTransportId(targetKey, failedActionId);
        const interruptedTransportActionId = createVcsActionTransportId(
          targetKey,
          interruptedActionId,
        );
        const client = {
          [WS_METHODS.gitRunStackedAction]: (input: { readonly actionId: string }) =>
            input.actionId === successfulTransportActionId
              ? Stream.make(
                  progress({
                    kind: "action_finished",
                    actionId: successfulTransportActionId,
                    cwd,
                    action,
                    result,
                  }),
                )
              : input.actionId === interruptedTransportActionId
                ? Stream.fromEffect(Effect.interrupt)
                : Stream.make(
                    progress({
                      kind: "action_failed",
                      actionId: failedTransportActionId,
                      cwd,
                      action,
                      phase: "push",
                      message: "push failed after creating the branch",
                    }),
                  ),
        } as unknown as WsRpcProtocolClient;
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target,
          state: yield* SubscriptionRef.make(connectionState),
          session: yield* SubscriptionRef.make(Option.some(session(client))),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (
          _environmentId,
          effect,
        ) => Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
        const runStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["runStream"] = (
          _environmentId,
          stream,
        ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
        const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
          run,
          runStream,
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
        const removed = new Array<string>();
        const runtime = Atom.runtime(
          Layer.merge(
            Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
            Layer.succeed(
              Persistence.EnvironmentCacheStore,
              cacheStore((removedEnvironmentId) => {
                removed.push(`${removedEnvironmentId}:*`);
              }),
            ),
          ),
        );
        const manager = createVcsActionManager(runtime);
        const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
          Effect.sync(() => registry.dispose()),
        );
        const state = vcsRefsCacheStateAtom({ environmentId });

        expect(registry.get(state).revision).toBe(0);
        const successfulResult = yield* Effect.promise(() =>
          manager.runStackedAction(targetKey).run(registry, {
            actionId: successfulActionId,
            action,
          }),
        );

        expect(AsyncResult.isSuccess(successfulResult)).toBe(true);
        expect(registry.get(manager.stateAtom(targetKey))).toEqual(EMPTY_VCS_ACTION_STATE);
        expect(registry.get(state).revision).toBe(1);
        expect(removed).toEqual([`${environmentId}:*`]);

        const failedResult = yield* Effect.promise(() =>
          manager.runStackedAction(targetKey).run(registry, {
            actionId: failedActionId,
            action,
          }),
        );

        expect(AsyncResult.isFailure(failedResult)).toBe(true);
        expect(registry.get(manager.stateAtom(targetKey))).toMatchObject({
          isRunning: false,
          operation: "run_change_request",
          actionId: failedActionId,
          error: "Source control action 'commit_push' failed during push.",
        });
        expect(registry.get(state).revision).toBe(2);
        expect(removed).toEqual([`${environmentId}:*`, `${environmentId}:*`]);

        const interruptedResult = yield* Effect.promise(() =>
          manager.runStackedAction(targetKey).run(registry, {
            actionId: interruptedActionId,
            action,
          }),
        );

        expect(AsyncResult.isFailure(interruptedResult)).toBe(true);
        if (AsyncResult.isFailure(interruptedResult)) {
          expect(Cause.hasInterruptsOnly(interruptedResult.cause)).toBe(true);
        }
        expect(registry.get(manager.stateAtom(targetKey))).toEqual(EMPTY_VCS_ACTION_STATE);
        expect(registry.get(state).revision).toBe(3);
        expect(removed).toEqual([`${environmentId}:*`, `${environmentId}:*`, `${environmentId}:*`]);
      }),
    ),
  );
});
