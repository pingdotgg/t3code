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
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
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
  isCommandMissingCause,
  spawnAndCollect,
  type CommandResult,
  type ServerProviderDraft,
} from "./providerSnapshot.ts";
import type { ServerProviderShape } from "./Services/ServerProvider.ts";

const UNKNOWN_AUTH: ServerProviderAuth = { status: "unknown" };

/** Version probe may start with an auto-update banner; the CLI version is the last semver. */
export function parseCommandCodeVersion(output: string): string | null {
  const matches = [...output.matchAll(/\b(\d+\.\d+\.\d+)\b/g)];
  return matches.length > 0 ? matches[matches.length - 1]![1]! : null;
}

type CliRun =
  | { readonly kind: "ok"; readonly result: CommandResult }
  | { readonly kind: "failure" };

const runCommandCodeCli = (
  binaryPath: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const resolved = yield* resolveSpawnCommand(binaryPath, [...args], { env, extendEnv: true });
    return yield* spawnAndCollect(
      binaryPath,
      ChildProcess.make(resolved.command, resolved.args, {
        env,
        extendEnv: true,
        shell: resolved.shell,
      }),
    );
  }).pipe(
    Effect.map((result) => ({ kind: "ok", result }) as const),
    Effect.catchAll((cause) =>
      isCommandMissingCause(cause)
        ? Effect.succeed({ kind: "failure" } as const)
        : Effect.fail(cause),
    ),
  );

export interface CommandCodeStatusCheckInput {
  readonly config: CommandCodeSettings;
  readonly env: NodeJS.ProcessEnv;
}

export function checkCommandCodeProvider(
  input: CommandCodeStatusCheckInput,
): Effect.Effect<ServerProviderDraft, unknown> {
  return Effect.gen(function* () {
    const enabled = input.config.enabled;
    const checkedAt = new Date().toISOString();

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
    const versionRun = yield* runCommandCodeCli(binaryPath, COMMAND_CODE_VERSION_ARGS, input.env);
    if (versionRun.kind === "failure") {
      return buildServerProvider({
        presentation: { displayName: "Command Code" },
        enabled,
        checkedAt,
        models: [],
        probe: {
          installed: false,
          version: null,
          status: "error",
          auth: UNKNOWN_AUTH,
          message:
            `Command Code CLI not found (looked for ${binaryPath}). ` +
            "Install it or set the Binary path in this instance's settings.",
        },
      });
    }

    const version = parseCommandCodeVersion(versionRun.result.stdout);
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
          message: `Command Code answered a --version probe that did not contain a version (stdout: ${versionRun.result.stdout.trim().slice(0, 200) || "<empty>"}).`,
        },
      });
    }

    const modelsRun = yield* runCommandCodeCli(
      binaryPath,
      COMMAND_CODE_LIST_MODELS_ARGS,
      input.env,
    );
    if (modelsRun.kind === "failure") {
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

    const models: ReadonlyArray<ServerProviderModel> = parseCommandCodeModelList(
      modelsRun.result.stdout,
    );
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
  readonly displayName: string;
}): ServerProviderDraft {
  return buildServerProvider({
    presentation: { displayName: input.displayName },
    enabled: input.enabled,
    checkedAt: new Date().toISOString(),
    models: [],
    probe: {
      installed: input.enabled,
      version: null,
      status: "warning",
      auth: UNKNOWN_AUTH,
      message: input.enabled ? "Checking Command Code…" : undefined,
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
export function makeCommandCodeSnapshotShape(
  input: CommandCodeSnapshotInput,
): Effect.Effect<ServerProviderShape, never, Scope.Scope> {
  return Effect.gen(function* () {
    const changes = yield* Effect.acquireRelease(
      PubSub.unbounded<ServerProvider>(),
      PubSub.shutdown,
    );
    const pending = input.stamp(
      pendingCommandCodeProvider({
        enabled: input.config.enabled,
        displayName: input.displayName,
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

    const refresh: Effect.Effect<ServerProvider> = Effect.gen(function* () {
      const draft = yield* checkCommandCodeProvider({
        config: input.config,
        env: input.env,
      }).pipe(
        Effect.catchAll(() =>
          Effect.succeed(
            pendingCommandCodeProvider({ enabled: true, displayName: input.displayName }),
          ),
        ),
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
