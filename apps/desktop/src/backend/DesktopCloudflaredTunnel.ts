import type {
  DesktopCloudflaredTunnelInput,
  DesktopCloudflaredTunnelState,
} from "@t3tools/contracts";
import * as RelayClient from "@t3tools/shared/relayClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

interface ActiveTunnel {
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Closeable;
  readonly key: string;
  readonly enabled: boolean;
  readonly configPath: string;
}

function configKey(input: DesktopCloudflaredTunnelInput): string {
  return JSON.stringify({
    enabled: input.enabled,
    configPath: input.configPath,
  });
}

export class DesktopCloudflaredTunnel extends Context.Service<
  DesktopCloudflaredTunnel,
  {
    readonly getState: Effect.Effect<DesktopCloudflaredTunnelState>;
    readonly apply: (
      input: DesktopCloudflaredTunnelInput,
    ) => Effect.Effect<DesktopCloudflaredTunnelState>;
  }
>()("@t3tools/desktop/backend/DesktopCloudflaredTunnel") {}

export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const relayClient = yield* RelayClient.RelayClient;
  const activeRef = yield* Ref.make<ActiveTunnel | null>(null);
  const stateRef = yield* Ref.make<DesktopCloudflaredTunnelState>({
    status: "disabled",
    enabled: false,
    configPath: null,
    pid: null,
    error: null,
  });
  const reconcileSemaphore = yield* Semaphore.make(1);

  const stopActive = Effect.gen(function* () {
    const active = yield* Ref.get(activeRef);
    if (active === null) return true;
    const closed = yield* Scope.close(active.scope, Exit.void).pipe(
      Effect.tapCause((cause) => Effect.logError(cause)),
      Effect.as(true),
      Effect.catchCause(() => Effect.succeed(false)),
    );
    if (closed) yield* Ref.set(activeRef, null);
    return closed;
  });

  const apply = Effect.fn("desktop.cloudflared.apply")(function* (
    input: DesktopCloudflaredTunnelInput,
  ) {
    const normalized = {
      enabled: input.enabled,
      configPath:
        input.configPath !== null && input.configPath.trim().length > 0 ? input.configPath : null,
    } satisfies DesktopCloudflaredTunnelInput;
    const configPath = normalized.configPath;
    const key = configKey(normalized);
    const current = yield* Ref.get(activeRef);
    if (current?.key === key) {
      const running = yield* current.child.isRunning.pipe(Effect.orElseSucceed(() => false));
      if (running) return yield* Ref.get(stateRef);
    }

    const stopped = yield* stopActive;
    if (!stopped) {
      const active = yield* Ref.get(activeRef);
      const state = {
        status: "running",
        enabled: active?.enabled ?? normalized.enabled,
        configPath: active?.configPath ?? normalized.configPath,
        pid: active === null ? null : Number(active.child.pid),
        error: "The previous cloudflared process could not be stopped.",
      } satisfies DesktopCloudflaredTunnelState;
      yield* Ref.set(stateRef, state);
      return state;
    }
    if (configPath === null) {
      const state = {
        status: normalized.enabled ? "failed" : "disabled",
        enabled: normalized.enabled,
        configPath: null,
        pid: null,
        error: normalized.enabled ? "A cloudflared config file is required." : null,
      } satisfies DesktopCloudflaredTunnelState;
      yield* Ref.set(stateRef, state);
      return state;
    }
    if (!normalized.enabled) {
      const state = {
        status: "disabled",
        enabled: false,
        configPath,
        pid: null,
        error: null,
      } satisfies DesktopCloudflaredTunnelState;
      yield* Ref.set(stateRef, state);
      return state;
    }
    const executable = yield* relayClient.resolve;
    if (executable.status !== "available") {
      const state = {
        status: "failed",
        enabled: normalized.enabled,
        configPath,
        pid: null,
        error:
          executable.status === "unsupported"
            ? `cloudflared is unsupported on ${executable.platform}-${executable.arch}.`
            : "cloudflared was not found. Install it or add it to PATH.",
      } satisfies DesktopCloudflaredTunnelState;
      yield* Ref.set(stateRef, state);
      return state;
    }

    const tunnelScope = yield* Scope.make("sequential");
    const command = ChildProcess.make(
      executable.executablePath,
      ["tunnel", "--config", configPath as string, "run"],
      {
        detached: false,
        shell: false,
        stderr: "ignore",
        stdout: "ignore",
      },
    );
    const spawned = yield* Effect.result(
      spawner.spawn(command).pipe(Effect.provideService(Scope.Scope, tunnelScope)),
    );
    if (spawned._tag === "Failure") {
      yield* Effect.logError(spawned.failure);
      yield* Scope.close(tunnelScope, Exit.void).pipe(Effect.ignore);
      const state = {
        status: "failed",
        enabled: normalized.enabled,
        configPath: normalized.configPath,
        pid: null,
        error: "cloudflared could not be started.",
      } satisfies DesktopCloudflaredTunnelState;
      yield* Ref.set(stateRef, state);
      return state;
    }

    const active = {
      child: spawned.success,
      scope: tunnelScope,
      key,
      enabled: normalized.enabled,
      configPath,
    } satisfies ActiveTunnel;
    yield* Ref.set(activeRef, active);
    const state = {
      status: "running",
      enabled: normalized.enabled,
      configPath: normalized.configPath,
      pid: Number(spawned.success.pid),
      error: null,
    } satisfies DesktopCloudflaredTunnelState;
    yield* Ref.set(stateRef, state);

    yield* Effect.forkDetach(
      Effect.gen(function* () {
        const result = yield* Effect.result(spawned.success.exitCode);
        yield* reconcileSemaphore.withPermits(1)(
          Effect.gen(function* () {
            const currentActive = yield* Ref.get(activeRef);
            if (currentActive?.child.pid !== spawned.success.pid) return;
            yield* Scope.close(currentActive.scope, Exit.void).pipe(
              Effect.tapCause((cause) => Effect.logError(cause)),
              Effect.ignore,
            );
            yield* Ref.set(activeRef, null);
            const failedState = {
              status: "failed",
              enabled: currentActive.enabled,
              configPath: currentActive.configPath,
              pid: null,
              error:
                result._tag === "Success"
                  ? `cloudflared exited with code ${Number(result.success)}.`
                  : "cloudflared stopped unexpectedly.",
            } satisfies DesktopCloudflaredTunnelState;
            if (result._tag === "Failure") yield* Effect.logError(result.failure);
            yield* Ref.set(stateRef, failedState);
          }),
        );
      }).pipe(Effect.catchCause(() => Effect.void)),
    );
    return state;
  });

  yield* Effect.addFinalizer(() =>
    stopActive.pipe(
      Effect.flatMap((stopped) =>
        stopped ? Effect.void : Effect.die("cloudflared could not be stopped during shutdown"),
      ),
    ),
  );

  return DesktopCloudflaredTunnel.of({
    getState: Ref.get(stateRef),
    apply: (input: DesktopCloudflaredTunnelInput) =>
      reconcileSemaphore.withPermits(1)(apply(input)),
  });
});

export const layer = Layer.effect(DesktopCloudflaredTunnel, make);
