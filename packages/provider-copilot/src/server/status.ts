import type { ModelInfo } from "@github/copilot-sdk";
import {
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProviderAuth,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import {
  AUTH_PROBE_TIMEOUT_MS,
  buildSelectOptionDescriptor,
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  type ProviderProbeResult,
  providerModelsFromSettings,
  type ServerProviderDraft,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";

import type { GitHubCopilotSettings } from "../settings.ts";
import {
  copilotLaunchCommand,
  makeCopilotSdkClient,
  type CopilotSdkClient,
  type CopilotSdkCommand,
} from "./copilotSdkRuntime.ts";

class GitHubCopilotProbeError extends Schema.TaggedError<GitHubCopilotProbeError>()(
  "GitHubCopilotProbeError",
  { cause: Schema.Defect() },
) {}

const DRIVER_KIND = ProviderDriverKind.make("githubCopilot");
const PRESENTATION = { displayName: "GitHub Copilot" } as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  { slug: "auto", name: "Auto", isCustom: false, capabilities: EMPTY_CAPABILITIES },
];
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const LOGIN_HINT = "Run `copilot login`.";

/** Only the models this account can use, each with its own reasoning levels. */
const REASONING_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

export function gitHubCopilotModels(
  models: ReadonlyArray<ModelInfo>,
): ReadonlyArray<ServerProviderModel> {
  return models.flatMap((model) => {
    if (model.policy !== undefined && model.policy.state !== "enabled") return [];
    const efforts = model.supportedReasoningEfforts ?? [];
    return [
      {
        slug: model.id,
        name: model.name,
        isCustom: false,
        capabilities:
          efforts.length === 0
            ? EMPTY_CAPABILITIES
            : createModelCapabilities({
                optionDescriptors: [
                  buildSelectOptionDescriptor({
                    id: "reasoning_effort",
                    label: "Reasoning",
                    options: efforts.map((effort) => ({
                      value: effort,
                      label: REASONING_LABELS[effort] ?? effort,
                      isDefault: effort === model.defaultReasoningEffort,
                    })),
                  }),
                ],
              }),
      },
    ];
  });
}

export function gitHubCopilotSlashCommands(
  commands: ReadonlyArray<CopilotSdkCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  return [
    COMPACT_SLASH_COMMAND,
    ...commands
      .filter((command) => command.name !== COMPACT_SLASH_COMMAND.name)
      .map((command) => ({
        name: command.name,
        description: command.description,
        ...(command.input === undefined ? {} : { input: { hint: command.input.hint } }),
      })),
  ];
}

const snapshot = (
  settings: GitHubCopilotSettings,
  checkedAt: string,
  probe: ProviderProbeResult,
  listed: ReadonlyArray<ServerProviderModel> = BUILT_IN_MODELS,
  slashCommands: ReadonlyArray<ServerProviderSlashCommand> = [COMPACT_SLASH_COMMAND],
) =>
  buildServerProvider({
    driver: DRIVER_KIND,
    presentation: PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: providerModelsFromSettings(listed, settings.customModels, EMPTY_CAPABILITIES),
    slashCommands,
    probe,
  });

export const buildInitialGitHubCopilotProviderSnapshot = Effect.fn(
  "GitHubCopilotProvider.buildInitialSnapshot",
)(function* (settings: GitHubCopilotSettings): Effect.fn.Return<ServerProviderDraft> {
  const now = yield* DateTime.now;
  return snapshot(settings, DateTime.formatIso(now), {
    installed: settings.enabled,
    version: null,
    status: "warning",
    auth: { status: "unknown" },
    message: settings.enabled
      ? "Checking GitHub Copilot CLI availability..."
      : "GitHub Copilot is disabled in T3 Code settings.",
  });
});

const runCopilotVersion = Effect.fn("GitHubCopilotProvider.runCopilotVersion")(function* (
  command: string,
  environment: NodeJS.ProcessEnv,
) {
  const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], { env: environment });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
    }),
  );
});

const CLIENT_STOP_TIMEOUT_MS = 2_000;

/** Reads everything without opening a session, so a status check leaves no Copilot history. */
export const readGitHubCopilotAccount = (client: CopilotSdkClient) => {
  const probe = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => new GitHubCopilotProbeError({ cause }),
    });
  const forceStop = probe(() => client.forceStop()).pipe(Effect.ignore);
  const stop = probe(() => client.stop()).pipe(
    Effect.timeoutOption(CLIENT_STOP_TIMEOUT_MS),
    Effect.flatMap(Option.match({ onNone: () => forceStop, onSome: () => Effect.void })),
    Effect.ignore,
    Effect.interruptible,
  );
  // A CLI that never finishes its handshake leaves `start` pending, and only `forceStop` ends it.
  return probe(async () => {
    await client.start();
    const auth = await client.authStatus();
    if (!auth.isAuthenticated) return { auth, models: [], commands: [] };
    const [models, commands] = await Promise.all([client.listModels(), client.serverCommands()]);
    return { auth, models, commands };
  }).pipe(
    Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
    Effect.onExit((exit) => (Exit.isSuccess(exit) && Option.isSome(exit.value) ? stop : forceStop)),
  );
};

export function gitHubCopilotAuth(input: {
  readonly isAuthenticated: boolean;
  readonly login?: string;
}): ServerProviderAuth {
  return input.isAuthenticated
    ? { status: "authenticated", ...(input.login === undefined ? {} : { label: input.login }) }
    : { status: "unauthenticated" };
}

export const checkGitHubCopilotProviderStatus = Effect.fn("checkGitHubCopilotProviderStatus")(
  function* (
    settings: GitHubCopilotSettings,
    environment: NodeJS.ProcessEnv,
    makeClient: typeof makeCopilotSdkClient = makeCopilotSdkClient,
  ): Effect.fn.Return<
    ServerProviderDraft,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (!settings.enabled) {
      return snapshot(settings, checkedAt, {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "GitHub Copilot is disabled in T3 Code settings.",
      });
    }

    const command = settings.binaryPath || "copilot";
    const versionResult = yield* runCopilotVersion(command, environment).pipe(
      Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
      Effect.result,
    );
    if (Result.isFailure(versionResult) || Option.isNone(versionResult.success)) {
      const missing =
        Result.isFailure(versionResult) && isCommandMissingCause(versionResult.failure);
      return snapshot(settings, checkedAt, {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? "GitHub Copilot CLI (`copilot`) is not installed or not on PATH."
          : "Failed to run `copilot --version`.",
      });
    }
    const output = versionResult.success.value;
    const version = parseGenericCliVersion(`${output.stdout}\n${output.stderr}`);

    // The SDK only checks that the file exists, so it never searches PATH itself.
    const resolved = yield* resolveCommandPath(command, { env: environment });
    const account = yield* readGitHubCopilotAccount(
      makeClient({
        command: yield* copilotLaunchCommand(resolved ?? command),
        args: [],
        env: environment,
      }),
    ).pipe(Effect.result);
    if (Result.isFailure(account) || Option.isNone(account.success)) {
      return snapshot(settings, checkedAt, {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: "Could not read your GitHub Copilot account from the CLI.",
      });
    }
    const { auth, models, commands } = account.success.value;
    if (!auth.isAuthenticated) {
      return snapshot(settings, checkedAt, {
        installed: true,
        version,
        status: "error",
        auth: gitHubCopilotAuth(auth),
        message: `GitHub Copilot CLI is installed but not signed in. ${LOGIN_HINT}`,
      });
    }
    const listed = gitHubCopilotModels(models);
    return snapshot(
      settings,
      checkedAt,
      { installed: true, version, status: "ready", auth: gitHubCopilotAuth(auth) },
      listed.length === 0 ? BUILT_IN_MODELS : listed,
      gitHubCopilotSlashCommands(commands),
    );
  },
);
