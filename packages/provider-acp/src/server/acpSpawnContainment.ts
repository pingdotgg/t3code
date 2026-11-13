// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpClient from "effect-acp/client";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";
import type * as EffectAcpProtocol from "effect-acp/protocol";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { AgentScope, AgentScopeThreadId, RAISE_OOM_SCORE_LINE } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
import { appendAcpStderrTail, sanitizeAcpStderrExcerpt } from "./stderr.ts";
import {
  collectSessionConfigOptionValues,
  decideToolCallUpdateEmission,
  extractModelConfigId,
  findModelConfigOption,
  findSessionConfigOption,
  mergeToolCallState,
  toolCallProgressLength,
  parseSessionModeState,
  parseSessionUpdateEvent,
  sessionUpdateCountsAsLoadReplayActivity,
  sessionUpdateIsReplay,
  waitForSessionLoadReplayIdle,
  type SessionLoadGate,
  type AcpParsedSessionEvent,
  type AcpSessionModeState,
  type AcpToolCallState,
} from "./runtimeModel.ts";
import {
  AcpProcessGroupTerminationError,
  isAcpProcessGroupTerminationError,
  makeLinuxCgroupController,
  resolveLinuxCgroupTargetCommand,
  wrapCommandForLinuxCgroup,
} from "./acpLinuxCgroup.ts";
import {
  capturePosixOwnershipLedger,
  makePosixProcessTreeController,
  observePosixOwnershipLedger,
  observePosixOwnershipLedgerContinuously,
  signalLinuxCgroupRootTerm,
  terminateLinuxCgroupLease,
  terminatePosixOwnedProcessTree,
  terminateWindowsProcessTreeWithTaskkill,
  withWallClock,
} from "./acpPosixProcessTree.ts";
import type {
  AcpOwnedPosixProcess,
  AcpLinuxCgroupLease,
  AcpPosixOwnershipRoot,
  AcpPosixProcessTreeController,
} from "./acpLinuxCgroup.ts";
import type { AcpSessionRuntimeOptions } from "./AcpSessionRuntime.ts";

const maxStderrChunkLength = 32_768;

export interface MakeAcpSpawnContainmentDeps {
  readonly options: AcpSessionRuntimeOptions;
  readonly recordTermination: (error: EffectAcpErrors.AcpError) => Effect.Effect<void>;
  readonly runtimeScope: Scope.Scope;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly stderrDrained: Deferred.Deferred<void>;
  readonly stderrFailure: Deferred.Deferred<never, EffectAcpErrors.AcpError>;
  readonly stderrTailRef: Ref.Ref<string>;
}


export const makeAcpSpawnContainment = Effect.fn("makeAcpSpawnContainment")(function* (
  deps: MakeAcpSpawnContainmentDeps,
) {
  const { recordTermination, runtimeScope, spawner, stderrDrained, stderrFailure, stderrTailRef, options } = deps;
  const spawnCommand =
    options.spawn.shell === false
      ? { command: options.spawn.command, args: options.spawn.args, shell: false }
      : yield* resolveSpawnCommand(options.spawn.command, options.spawn.args, {
          ...(options.spawn.env ? { env: options.spawn.env } : {}),
          extendEnv: options.spawn.extendEnv ?? true,
        });
  const linuxCgroupLease =
    options.ownDescendantProcessGroups === true && options.processGroupPlatform === "linux"
      ? yield* Effect.sync(() => {
          try {
            if (options.linuxCgroupController === null) return undefined;
            return (options.linuxCgroupController ?? makeLinuxCgroupController()).create();
          } catch {
            return undefined;
          }
        })
      : undefined;
  // This is lifecycle containment for inherited provider work. It is not a
  // security boundary against a provider that can modify its delegated cgroup.
  if (linuxCgroupLease !== undefined) {
    yield* Scope.addFinalizer(
      runtimeScope,
      Effect.uninterruptible(terminateLinuxCgroupLease(linuxCgroupLease)).pipe(
        Effect.ignoreCause({ log: true }),
      ),
    );
  }
  const containedTargetCommand =
    linuxCgroupLease === undefined || NodePath.isAbsolute(spawnCommand.command)
      ? spawnCommand.command
      : yield* Effect.gen(function* () {
          const resolved = resolveLinuxCgroupTargetCommand(
            spawnCommand.command,
            options.spawn.cwd ?? options.cwd,
            { ...process.env, ...options.spawn.env },
          );
          if (resolved !== undefined) return resolved;
          return yield* new EffectAcpErrors.AcpSpawnError({
            command: options.spawn.command,
            cause: new Error("Contained ACP command was not found on PATH"),
          });
        });
  const agentScope = yield* AgentScope;
  const scopedLaunch =
    linuxCgroupLease !== undefined || spawnCommand.shell
      ? undefined
      : yield* agentScope.wrap({
          command: spawnCommand.command,
          args: spawnCommand.args,
          name: "acp",
          threadId: yield* AgentScopeThreadId,
          env: { ...process.env, ...options.spawn.env },
        });
  const scopedSpawnCommand =
    scopedLaunch === undefined ? spawnCommand : { ...scopedLaunch, shell: false };
  // Finalizers run in reverse order: reap detached work after terminating the agent.
  const scopeUnit = scopedLaunch?.unit;
  const stopScope =
    scopeUnit === undefined ? Effect.void : yield* Effect.cached(agentScope.stop(scopeUnit));
  yield* Scope.addFinalizer(runtimeScope, stopScope);
  const containedSpawnCommand =
    linuxCgroupLease === undefined
      ? scopedSpawnCommand
      : {
          ...wrapCommandForLinuxCgroup(linuxCgroupLease, containedTargetCommand, spawnCommand.args),
          shell: false,
        };
  const spawnEnvironment =
    linuxCgroupLease === undefined
      ? options.spawn.env
      : {
          ...options.spawn.env,
          ELECTRON_RUN_AS_NODE: "1",
          T3_ACP_CGROUP_WRAPPER: "1",
        };
  const child = yield* spawner
    .spawn(
      ChildProcess.make(containedSpawnCommand.command, containedSpawnCommand.args, {
        ...(options.spawn.cwd ? { cwd: options.spawn.cwd } : {}),
        ...(spawnEnvironment ? { env: spawnEnvironment } : {}),
        extendEnv: options.spawn.extendEnv ?? true,
        ...(options.ownDetachedProcessGroup === undefined
          ? {}
          : { detached: options.ownDetachedProcessGroup }),
        shell: containedSpawnCommand.shell,
      }),
    )
    .pipe(
      Effect.provideService(Scope.Scope, runtimeScope),
      Effect.mapError(
        (cause) =>
          new EffectAcpErrors.AcpSpawnError({
            command: options.spawn.command,
            cause,
          }),
      ),
    );

  // Detached children can keep stdout open, delaying protocol termination.
  if (scopeUnit !== undefined) {
    yield* child.exitCode.pipe(
      Effect.matchEffect({ onFailure: () => stopScope, onSuccess: () => stopScope }),
      Effect.forkIn(runtimeScope),
    );
  }

  const posixOwnershipLedger = new Map<string, AcpOwnedPosixProcess>();
  const posixOwnershipFrontier = new Map<number, AcpOwnedPosixProcess>();
  const posixOwnershipChildQueues = new Map<number, Array<number>>();
  const posixOwnershipRoot: AcpPosixOwnershipRoot = { value: undefined };
  const posixController =
    options.ownDescendantProcessGroups === true
      ? yield* Effect.try({
          try: () => {
            if (options.posixProcessTreeController !== undefined) {
              return options.posixProcessTreeController;
            }
            if (options.processGroupPlatform === undefined) {
              throw new AcpProcessGroupTerminationError({
                detail: "POSIX ACP descendant ownership requires a supported host platform",
              });
            }
            return makePosixProcessTreeController(options.processGroupPlatform);
          },
          catch: (cause) =>
            new EffectAcpErrors.AcpSpawnError({ command: options.spawn.command, cause }),
        })
      : undefined;
  if (posixController !== undefined) {
    const observeOwnership = () =>
      observePosixOwnershipLedger({
        childQueues: posixOwnershipChildQueues,
        controller: posixController,
        frontier: posixOwnershipFrontier,
        ledger: posixOwnershipLedger,
        root: posixOwnershipRoot,
        rootPid: Number(child.pid),
      });
    yield* Effect.try({
      try: observeOwnership,
      catch: (cause) =>
        new EffectAcpErrors.AcpSpawnError({ command: options.spawn.command, cause }),
    });
    // Cgroup teardown needs only the root identity captured above.
    if (linuxCgroupLease === undefined) {
      yield* observePosixOwnershipLedgerContinuously({
        childQueues: posixOwnershipChildQueues,
        controller: posixController,
        frontier: posixOwnershipFrontier,
        ledger: posixOwnershipLedger,
        root: posixOwnershipRoot,
        rootPid: Number(child.pid),
      }).pipe(Effect.forkIn(runtimeScope));
    }
  }

  const signalOwnedProcessGroup = (signal: NodeJS.Signals) =>
    Effect.try({
      try: () => {
        signalProcessGroup(Number(child.pid), signal);
        return true;
      },
      catch: (cause) =>
        new AcpProcessGroupTerminationError({
          cause,
          detail: `Failed to signal ACP process group ${child.pid} with ${signal}`,
        }),
    }).pipe(
      Effect.catch((error) => {
        const cause = error.cause as NodeJS.ErrnoException | undefined;
        return cause?.code === "ESRCH" ? Effect.succeed(false) : Effect.fail(error);
      }),
    );
  const terminateWindowsProcessTree =
    options.windowsProcessTreeTerminator ??
    ((pid: number) =>
      terminateWindowsProcessTreeWithTaskkill(pid).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ));
  const terminatePosixProcessTree = Effect.fn("AcpSessionRuntime.terminatePosixProcessTree")(
    function* (grace: Duration.Input, platformOverride?: NodeJS.Platform) {
      const platform = platformOverride ?? options.processGroupPlatform;
      if (platform === undefined || platform === "win32") {
        return yield* new AcpProcessGroupTerminationError({
          detail: "POSIX ACP descendant ownership requires a supported host platform",
        });
      }
      const controller = yield* Effect.try({
        try: () => posixController ?? makePosixProcessTreeController(platform),
        catch: (cause) =>
          isAcpProcessGroupTerminationError(cause)
            ? cause
            : new AcpProcessGroupTerminationError({
                cause,
                detail: `Failed to initialize ACP descendant ownership on ${platform}`,
              }),
      });
      yield* terminatePosixOwnedProcessTree({
        controller,
        grace,
        ledger: posixOwnershipLedger,
        root: posixOwnershipRoot,
        rootPid: Number(child.pid),
      });
    },
  );
  const terminateOwnedProcessGroupImpl = Effect.gen(function* () {
    if (options.ownDetachedProcessGroup !== true) return;
    if (options.processGroupPlatform === undefined) {
      return yield* new AcpProcessGroupTerminationError({
        detail: "Detached ACP process-group ownership requires a host platform",
      });
    }
    if (options.processGroupPlatform === "win32") {
      return yield* terminateWindowsProcessTree(Number(child.pid));
    }
    if (linuxCgroupLease !== undefined) {
      if (posixController !== undefined) {
        yield* Effect.sync(() =>
          signalLinuxCgroupRootTerm({
            controller: posixController,
            lease: linuxCgroupLease,
            root: posixOwnershipRoot,
          }),
        );
      }
      const grace = options.processGroupTerminationGrace ?? "1 second";
      if (grace !== 0) yield* Effect.sleep(grace);
      return yield* terminateLinuxCgroupLease(linuxCgroupLease);
    }
    if (options.ownDescendantProcessGroups === true) {
      return yield* terminatePosixProcessTree(options.processGroupTerminationGrace ?? "1 second");
    }
    const groupExisted = yield* signalOwnedProcessGroup("SIGTERM");
    if (!groupExisted) return;
    const grace = options.processGroupTerminationGrace ?? "1 second";
    if (grace !== 0) {
      yield* Effect.sleep(grace);
    }
    yield* signalOwnedProcessGroup("SIGKILL");
  }).pipe(withWallClock);
  const terminateProcessGroup = yield* Effect.cached(
    Effect.uninterruptible(terminateOwnedProcessGroupImpl),
  );
  if (options.ownDetachedProcessGroup === true) {
    const hostPlatform = yield* HostProcess.Platform;
    const forceTerminateOwnedProcessGroup =
      hostPlatform === "win32"
        ? terminateWindowsProcessTreeWithTaskkill(Number(child.pid)).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          )
        : linuxCgroupLease !== undefined
          ? terminateLinuxCgroupLease(linuxCgroupLease)
          : options.ownDescendantProcessGroups === true
            ? terminatePosixProcessTree(0, hostPlatform)
            : signalOwnedProcessGroup("SIGKILL").pipe(Effect.asVoid);
    yield* Scope.addFinalizer(
      runtimeScope,
      Effect.uninterruptible(forceTerminateOwnedProcessGroup).pipe(
        Effect.ignoreCause({ log: true }),
      ),
    );
  }
  yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Ref.update(stderrTailRef, (current) => appendAcpStderrTail(current, chunk)).pipe(
        Effect.andThen(
          options.onStderr ? options.onStderr(chunk.slice(-maxStderrChunkLength)) : Effect.void,
        ),
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* Deferred.fail(stderrFailure, error);
            yield* recordTermination(error);
            yield* child.kill({ forceKillAfter: "1 second" }).pipe(Effect.ignore);
          }),
        ),
      ),
    ),
    Effect.ensuring(Deferred.succeed(stderrDrained, undefined)),
    Effect.ignore,
    Effect.forkIn(runtimeScope),
  );
  return { child, stopScope, terminateProcessGroup, posixController, linuxCgroupLease, signalOwnedProcessGroup, terminatePosixProcessTree };
});
