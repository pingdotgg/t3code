/**
 * CommandCodeProvider — status probes and the per-instance snapshot holder
 * for the Command Code driver.
 *
 * Command Code has no cheap auth-status endpoint: `--list-models` lists the
 * model catalog whether or not the account can call any of it, so the probe
 * reports `auth.status: "unknown"` and real auth failures surface as exit
 * code 3 on the first turn. The snapshot therefore mirrors what can be
 * probed cheaply: binary presence, version, and the live model catalog.
 *
 * @module provider/CommandCodeProvider
 */
import type {
  CommandCodeSettings,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  COMMAND_CODE_LIST_MODELS_ARGS,
  COMMAND_CODE_VERSION_ARGS,
} from "./commandCodeLaunchArgs.ts";
import { parseCommandCodeModelList } from "./commandCodeModels.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "./providerMaintenance.ts";
import {
  buildServerProvider,
  spawnAndCollect,
  type CommandResult,
  type ServerProviderDraft,
} from "./providerSnapshot.ts";
import type { ServerProviderShape } from "./Services/ServerProvider.ts";

const UNKNOWN_AUTH: ServerProviderAuth = { status: "unknown" };

const checkedAtEffect = Effect.map(DateTime.now, DateTime.formatIso);

/** Version probe may start with an auto-update banner; the CLI version is the last semver. */
export function parseCommandCodeVersion(output: string): string | null {
  const matches = [...output.matchAll(/\b(\d+\.\d+\.\d+)\b/g)];
  return matches.length > 0 ? matches[matches.length - 1]![1]! : null;
}

const runCommandCodeCli = (
  binaryPath: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const resolved = yield* resolveSpawnCommand(binaryPath, [...args], { env, extendEnv: true });
    return yield* spawnAndCollect(
      binaryPath,
      ChildProcess.make(resolved.command, resolved.args, {
        env,
        extendEnv: true,
        shell: resolved.shell,
      }),
    );
  });

/**
 * One-shot probe that never fails: a launch problem, a nonzero exit, or a
 * probe that stalls past the deadline becomes a synthetic `code: -1` result
 * so callers branch on data, not on the error channel.
 */
const probeCommandCodeCli = (
  binaryPath: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Effect.Effect<CommandResult, never, ChildProcessSpawner.ChildProcessSpawner> =>
  runCommandCodeCli(binaryPath, args, env).pipe(
    Effect.timeoutOption("15 seconds"),
    Effect.map((attempt) =>
      Option.match(attempt, {
        onNone: () => ({
          stdout: "",
          stderr: "Command Code probe timed out after 15 seconds.",
          code: -1,
        }),
        onSome: (result) => result,
      }),
    ),
    Effect.catch((error) => Effect.succeed({ stdout: "", stderr: String(error), code: -1 })),
  );

export interface CommandCodeStatusCheckInput {
  readonly config: CommandCodeSettings;
  readonly env: NodeJS.ProcessEnv;
}

function notInstalledDraft(input: {
  readonly enabled: boolean;
  readonly checkedAt: string;
  readonly binaryPath: string;
}): ServerProviderDraft {
  return buildServerProvider({
    presentation: { displayName: "Command Code" },
    enabled: input.enabled,
    checkedAt: input.checkedAt,
    models: [],
    probe: {
      installed: false,
      version: null,
      status: "error",
      auth: UNKNOWN_AUTH,
      message:
        `Command Code CLI could not be started (looked for ${input.binaryPath}). ` +
        "Install it or set the Binary path in this instance's settings.",
    },
  });
}

export function checkCommandCodeProvider(input: CommandCodeStatusCheckInput) {
  return Effect.gen(function* () {
    const enabled = input.config.enabled;
    const checkedAt = yield* checkedAtEffect;

    if (!enabled) {
      return buildServerProvider({
        presentation: { displayName: "Command Code" },
        enabled: false,
        checkedAt,
        models: [],
        probe: { installed: false, version: null, status: "error", auth: UNKNOWN_AUTH },
      });
    }

    const binaryPath = input.config.binaryPath || "command-code";
    const versionRun = yield* probeCommandCodeCli(binaryPath, COMMAND_CODE_VERSION_ARGS, input.env);
    // Any nonzero exit (including the -1 sentinel) means the CLI did not
    // answer cleanly; a wrapper that echoes a version then fails is not ready.
    if (versionRun.code !== 0) {
      return notInstalledDraft({ enabled, checkedAt, binaryPath });
    }

    const version = parseCommandCodeVersion(versionRun.stdout);
    if (version === null) {
      return buildServerProvider({
        presentation: { displayName: "Command Code" },
        enabled,
        checkedAt,
        models: [],
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: UNKNOWN_AUTH,
          message: `Command Code answered a --version probe without a version (stdout: ${
            versionRun.stdout.trim().slice(0, 200) || "<empty>"
          }).`,
        },
      });
    }

    const modelsRun = yield* probeCommandCodeCli(
      binaryPath,
      COMMAND_CODE_LIST_MODELS_ARGS,
      input.env,
    );
    if (modelsRun.code !== 0) {
      return buildServerProvider({
        presentation: { displayName: "Command Code" },
        enabled,
        checkedAt,
        models: [],
        probe: {
          installed: true,
          version,
          status: "warning",
          auth: UNKNOWN_AUTH,
          message: "Command Code is installed but its model list could not be read.",
        },
      });
    }

    const models: ReadonlyArray<ServerProviderModel> = parseCommandCodeModelList(modelsRun.stdout);
    return buildServerProvider({
      presentation: { displayName: "Command Code" },
      enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "ready",
        auth: UNKNOWN_AUTH,
      },
    });
  });
}

function pendingCommandCodeProvider(input: {
  readonly enabled: boolean;
  readonly checkedAt: string;
  readonly message: string | undefined;
}): ServerProviderDraft {
  return buildServerProvider({
    presentation: { displayName: "Command Code" },
    enabled: input.enabled,
    checkedAt: input.checkedAt,
    models: [],
    probe: {
      installed: input.enabled,
      version: null,
      status: "warning",
      auth: UNKNOWN_AUTH,
      ...(input.message !== undefined ? { message: input.message } : {}),
    },
  });
}

export interface CommandCodeSnapshotInput {
  readonly config: CommandCodeSettings;
  readonly env: NodeJS.ProcessEnv;
  readonly stamp: (draft: ServerProviderDraft) => ServerProvider;
  readonly displayName: string;
  readonly driverKind: ServerProvider["driver"];
}

/**
 * Minimal `ServerProviderShape` for Command Code. The full managed-provider
 * machinery (installer ownership, update advisories, manifest refresh) does
 * not apply to a CLI that self-updates on launch, so this holder just runs
 * the status probe on demand and on settings-triggered recreation.
 */
export function makeCommandCodeSnapshotShape(input: CommandCodeSnapshotInput) {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const changes = yield* Effect.acquireRelease(
      PubSub.unbounded<ServerProvider>(),
      PubSub.shutdown,
    );
    const checkedAt = yield* checkedAtEffect;
    const pending = input.stamp(
      pendingCommandCodeProvider({
        enabled: input.config.enabled,
        checkedAt,
        message: input.config.enabled ? "Checking Command Code…" : undefined,
      }),
    );
    const state = yield* Ref.make<ServerProvider>(pending);

    const publish = (next: ServerProvider): Effect.Effect<void> =>
      Ref.modify(state, (current) => {
        if (Equal.equals(current, next)) {
          return [false, current] as const;
        }
        return [true, next] as const;
      }).pipe(
        Effect.flatMap((changed) =>
          changed ? PubSub.publish(changes, next).pipe(Effect.asVoid) : Effect.void,
        ),
      );

    const refresh = Effect.gen(function* () {
      const draft = yield* checkCommandCodeProvider({ config: input.config, env: input.env }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const next = input.stamp(draft);
      yield* publish(next);
      return next;
    });

    const maintenance = makeManualOnlyProviderMaintenanceCapabilities({
      provider: input.driverKind,
      packageName: null,
    });

    return {
      resolveMaintenance: () => Effect.succeed(maintenance),
      getSnapshot: Ref.get(state),
      refresh,
      get streamChanges() {
        return Stream.fromPubSub(changes);
      },
      applyUsageLimits: () => Effect.void,
    } satisfies ServerProviderShape;
  });
}
