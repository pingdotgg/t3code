import {
  AcpRegistryOperationError,
  AcpRegistryProbeResult,
  AcpRegistrySettings,
  type AcpRegistryProbeAuthMethod,
  type AcpRegistryProbeModel,
  type AcpRegistryUrlAuthAction,
  type ProviderInstanceId,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import { PtyAdapter } from "../../terminal/PtyAdapter.ts";
import { AcpRegistryCatalog, toAcpRegistryOperationError } from "./AcpRegistrySupport.ts";
import { parseSessionModeState } from "./AcpRuntimeModel.ts";
import { acpProviderOptionDescriptors } from "./AcpSessionConfig.ts";
import { AcpRegistryRuntimeCoordinator } from "./AcpRegistryRuntimeCoordinator.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const MAX_AUTH_METHODS = 32;
const MAX_MODELS = 256;
const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 1_024;
const MAX_COMMANDS = 128;
const MAX_COMMAND_LINE_LENGTH = 2_048;
// Covers a cold package command launch and ACP initialization after registry
// preparation globally installs the exact package.
const PROBE_TIMEOUT_SECONDS = 60;
const PROBE_TIMEOUT = `${PROBE_TIMEOUT_SECONDS} seconds`;
const COMMAND_ADVERTISEMENT_GRACE = "500 millis";

const boundedText = (value: string, maximumLength: number): string =>
  value.trim().slice(0, maximumLength);

const boundedOpaqueValue = (value: string, maximumLength: number): string | undefined =>
  value.length > 0 && value === value.trim() && value.length <= maximumLength ? value : undefined;

export function normalizeAcpRegistryWebUrl(value: string): string | undefined {
  if (value.length > 2_048 || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
}

function modelConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<EffectAcpSchema.SessionConfigSelectOption> {
  return (configOptions ?? []).flatMap((option) => {
    if (option.category !== "model" || option.type !== "select") return [];
    return option.options.flatMap((candidate) =>
      "value" in candidate ? [candidate] : candidate.options,
    );
  });
}

function normalizeModels(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<AcpRegistryProbeModel> {
  // Model discovery is the model config option's base models; ACP has no
  // other portable model inventory.
  const candidates = modelConfigOptions(configOptions).map((model) => ({
    id: model.value,
    name: model.name,
    description: model.description ?? null,
  }));
  const seen = new Set<string>();
  const models: Array<AcpRegistryProbeModel> = [];
  for (const candidate of candidates) {
    const id = boundedOpaqueValue(candidate.id, MAX_ID_LENGTH);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      name: boundedText(candidate.name, MAX_NAME_LENGTH) || id,
      description:
        candidate.description === null
          ? null
          : boundedText(candidate.description, MAX_DESCRIPTION_LENGTH) || null,
    });
    if (models.length === MAX_MODELS) break;
  }
  return models;
}

/** Agent spawn recipe used to compose runnable terminal-auth command lines. */
export interface AcpRegistryAuthSpawnContext {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const SHELL_SAFE_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/u;

function shellDisplayToken(token: string): string {
  return SHELL_SAFE_TOKEN.test(token) ? token : `'${token.replaceAll("'", `'\\''`)}'`;
}

function terminalAuthCommand(
  method: Extract<EffectAcpSchema.AuthMethod, { readonly type: "terminal" }>,
  spawn: AcpRegistryAuthSpawnContext,
): string | undefined {
  const environmentPrefix = Object.entries(method.env ?? {}).map(
    ([name, value]) => `${name}=${shellDisplayToken(value)}`,
  );
  const command = [spawn.command, ...spawn.args, ...(method.args ?? [])].map(shellDisplayToken);
  const displayCommand = [...environmentPrefix, ...command].join(" ");
  return displayCommand.length <= MAX_COMMAND_LINE_LENGTH ? displayCommand : undefined;
}

export function normalizeAcpRegistryAuthMethods(
  methods: ReadonlyArray<EffectAcpSchema.AuthMethod> | undefined,
  spawn?: AcpRegistryAuthSpawnContext,
): ReadonlyArray<AcpRegistryProbeAuthMethod> {
  const normalized: Array<AcpRegistryProbeAuthMethod> = [];
  for (const method of methods ?? []) {
    const id = boundedOpaqueValue(method.id, MAX_ID_LENGTH);
    if (id === undefined) continue;
    const type = method.type ?? "agent";
    const envVarNames =
      type === "env_var" && "vars" in method
        ? method.vars
            .flatMap((variable) => {
              const name = boundedOpaqueValue(variable.name, MAX_ID_LENGTH);
              return name === undefined ? [] : [name];
            })
            .slice(0, 16)
        : [];
    const command =
      spawn !== undefined && "type" in method && method.type === "terminal"
        ? terminalAuthCommand(method, spawn)
        : undefined;
    const link =
      type === "env_var" && "link" in method && method.link
        ? normalizeAcpRegistryWebUrl(method.link)
        : undefined;
    normalized.push({
      id,
      name: boundedText(method.name, MAX_NAME_LENGTH) || id,
      description:
        method.description == null
          ? null
          : boundedText(method.description, MAX_DESCRIPTION_LENGTH) || null,
      type,
      ...(command === undefined ? {} : { command }),
      ...(envVarNames.length > 0 ? { envVarNames } : {}),
      ...(link === undefined ? {} : { link }),
    });
    if (normalized.length === MAX_AUTH_METHODS) break;
  }
  return normalized;
}

export interface AcpRegistryAvailableCommands {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

export interface AcpRegistryLiveConfiguration {
  readonly models: ReadonlyArray<AcpRegistryProbeModel>;
  readonly currentModelId: string | null;
  readonly configOptions: AcpRegistryProbeResult["configOptions"];
  /** Whether T3's Plan toggle has an agent mode to switch to. */
  readonly supportsPlanMode: boolean;
}

/** The agent mode ids T3's Plan toggle switches to. */
export function isAcpRegistryPlanModeId(id: string): boolean {
  return id === "plan" || id === "architect";
}

/**
 * Whether the adapter can put this agent in a plan mode: a session mode, or a
 * mode or collaboration-mode choice, with a plan id.
 */
function acpRegistrySupportsPlanMode(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  modeState: Parameters<typeof acpProviderOptionDescriptors>[0]["modeState"],
): boolean {
  return (
    modeState?.availableModes.some((mode) => isAcpRegistryPlanModeId(mode.id)) === true ||
    configOptions.some(
      (option) =>
        option.type === "select" &&
        (option.category === "mode" || option.category === "collaboration_mode") &&
        option.options
          .flatMap((entry) => ("value" in entry ? [entry] : entry.options))
          .some((choice) => isAcpRegistryPlanModeId(choice.value)),
    )
  );
}

/** Normalizes volatile session configuration using the same bounds as discovery probes. */
export function normalizeAcpRegistryLiveConfiguration(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  modeState?: Parameters<typeof acpProviderOptionDescriptors>[0]["modeState"],
): AcpRegistryLiveConfiguration {
  const modelOption = configOptions.find(
    (option) => option.category === "model" && option.type === "select",
  );
  const boundedCurrentModelId =
    modelOption?.type === "select"
      ? (boundedOpaqueValue(modelOption.currentValue, MAX_ID_LENGTH) ?? null)
      : null;
  const models = normalizeModels(configOptions);
  return {
    models,
    currentModelId: models.some((model) => model.id === boundedCurrentModelId)
      ? boundedCurrentModelId
      : null,
    configOptions: acpProviderOptionDescriptors({ configOptions, modeState }),
    supportsPlanMode: acpRegistrySupportsPlanMode(configOptions, modeState),
  };
}

const emptyAcpRegistryAvailableCommands = (): AcpRegistryAvailableCommands => ({
  slashCommands: [],
  skills: [],
});

/** Splits the latest ACP command advertisement into T3's `/` and `$` menus. */
export function normalizeAcpRegistryCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): AcpRegistryAvailableCommands {
  const seen = new Set<string>();
  const slashCommands: Array<ServerProviderSlashCommand> = [];
  const skills: Array<ServerProviderSkill> = [];
  let accepted = 0;
  for (const command of commands) {
    const name = boundedOpaqueValue(command.name, MAX_ID_LENGTH);
    if (name === undefined) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const description = boundedText(command.description, MAX_DESCRIPTION_LENGTH);
    const hint = command.input ? boundedText(command.input.hint, MAX_DESCRIPTION_LENGTH) : "";
    if (name.startsWith("$")) {
      const skillName = boundedOpaqueValue(name.slice(1), MAX_ID_LENGTH);
      if (skillName === undefined) continue;
      skills.push({
        name: skillName,
        ...(description ? { description } : {}),
        path: `acp://skill/${encodeURIComponent(skillName)}`,
        scope: "agent",
        enabled: true,
      });
    } else {
      slashCommands.push({
        name,
        ...(description ? { description } : {}),
        ...(hint ? { input: { hint } } : {}),
      });
    }
    accepted += 1;
    if (accepted === MAX_COMMANDS) break;
  }
  return { slashCommands, skills };
}

/** Builds the bounded wire result from a successfully created disposable ACP session. */
export function acpRegistryProbeResult(
  instanceId: ProviderInstanceId,
  started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
  icon: string | null = null,
  spawn?: AcpRegistryAuthSpawnContext,
): AcpRegistryProbeResult {
  // The plan signal is server state, not part of the wire result.
  const { supportsPlanMode: _supportsPlanMode, ...liveConfiguration } =
    normalizeAcpRegistryLiveConfiguration(
      started.sessionSetupResult.configOptions ?? [],
      parseSessionModeState(started.sessionSetupResult),
    );
  return AcpRegistryProbeResult.make({
    instanceId,
    ready: true,
    icon,
    authMethods: normalizeAcpRegistryAuthMethods(started.initializeResult.authMethods, spawn),
    sessionManagement: {
      canList: started.initializeResult.agentCapabilities?.sessionCapabilities?.list != null,
      canLoad: started.initializeResult.agentCapabilities?.loadSession === true,
      canResume: started.initializeResult.agentCapabilities?.sessionCapabilities?.resume != null,
      canLogout: started.initializeResult.agentCapabilities?.auth?.logout != null,
      canDelete: started.initializeResult.agentCapabilities?.sessionCapabilities?.delete != null,
      canConfigureProviders: started.initializeResult.agentCapabilities?.providers != null,
    },
    ...liveConfiguration,
  });
}

export function acpRegistryProbeFailure(
  error: EffectAcpErrors.AcpError,
  authMethods: ReadonlyArray<AcpRegistryProbeAuthMethod> = [],
  authAction?: AcpRegistryUrlAuthAction,
): AcpRegistryOperationError {
  const detail = error._tag === "AcpTransportError" && error.detail ? error.detail : error.message;
  const authenticationFailed =
    (error._tag === "AcpRequestError" && error.code === -32000) ||
    /\b(?:authenticat(?:e|ed|es|ing|ion)|credentials?|log(?:[\s-]+)?in)\b/iu.test(detail);
  return new AcpRegistryOperationError({
    reason: authenticationFailed ? "authentication_failed" : "probe_failed",
    message: authenticationFailed
      ? "The ACP agent could not complete authentication."
      : "The ACP agent could not create a test session.",
    cause: error,
    ...(authMethods.length > 0 ? { authMethods } : {}),
    ...(authAction === undefined ? {} : { authAction }),
  });
}

export interface AcpRegistryConfigurationProbeInput {
  readonly instanceId: ProviderInstanceId;
  readonly settings: AcpRegistrySettings;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}

export interface AcpRegistryConfigurationProbeResult {
  readonly probe: AcpRegistryProbeResult;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly supportsPlanMode: boolean;
}

export type AcpRegistryConfigurationProbe<Requirements = never> = (
  input: AcpRegistryConfigurationProbeInput,
) => Effect.Effect<AcpRegistryConfigurationProbeResult, AcpRegistryOperationError, Requirements>;

/** Starts and immediately disposes an ACP session for one already-decoded configuration. */
export const probeAcpRegistryConfiguration = Effect.fn("AcpRegistryProbe.probeConfiguration")(
  function* (
    input: AcpRegistryConfigurationProbeInput,
  ): Effect.fn.Return<
    AcpRegistryConfigurationProbeResult,
    AcpRegistryOperationError,
    AcpRegistryCatalog | ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
  > {
    const catalog = yield* AcpRegistryCatalog;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const pty = yield* Effect.serviceOption(PtyAdapter);

    const result = yield* Effect.gen(function* () {
      // Resolution may install a missing registry package. Keep it inside the
      // probe deadline so a provider refresh cannot inherit the installer's
      // much longer timeout.
      const resolved = yield* catalog
        .resolve(input.settings, input.cwd, input.environment)
        .pipe(Effect.mapError(toAcpRegistryOperationError));
      const authMethodsRef = yield* Ref.make<ReadonlyArray<AcpRegistryProbeAuthMethod>>([]);
      const authActionRef = yield* Ref.make<AcpRegistryUrlAuthAction | undefined>(undefined);
      const runtimeCoordinator = yield* Effect.serviceOption(AcpRegistryRuntimeCoordinator);
      const runtimeContext = yield* Layer.build(
        AcpSessionRuntime.layer({
          spawn: resolved.spawn,
          cwd: input.cwd,
          clientCapabilities: {
            auth: { terminal: Option.isSome(pty) },
            elicitation: { url: {} },
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "t3-code-provider-test", version: "0.0.0" },
          authenticateOnAuthRequired: false,
          onInitialized: (initializeResult) =>
            Ref.set(
              authMethodsRef,
              normalizeAcpRegistryAuthMethods(initializeResult.authMethods, {
                command: resolved.spawn.command,
                args: resolved.spawn.args,
              }),
            ),
          ...(input.settings.authMethodId ? { authMethodId: input.settings.authMethodId } : {}),
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
              Layer.succeed(Crypto.Crypto, crypto),
            ),
          ),
        ),
      );
      const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
        Effect.provide(runtimeContext),
      );
      const commandsRef = yield* Ref.make<AcpRegistryAvailableCommands>(
        emptyAcpRegistryAvailableCommands(),
      );
      const commandsAdvertised = yield* Deferred.make<void>();
      yield* runtime.handleElicitation((request) =>
        Effect.gen(function* () {
          if (
            request.mode !== "url" ||
            !("url" in request) ||
            !("elicitationId" in request) ||
            typeof request.url !== "string" ||
            typeof request.elicitationId !== "string"
          ) {
            return { action: "decline" } as const;
          }
          const url = normalizeAcpRegistryWebUrl(request.url);
          const elicitationId = boundedOpaqueValue(request.elicitationId, MAX_ID_LENGTH);
          if (url === undefined || elicitationId === undefined) {
            return { action: "decline" } as const;
          }
          const action: AcpRegistryUrlAuthAction = {
            elicitationId,
            url,
            message: boundedText(request.message, MAX_DESCRIPTION_LENGTH),
          };
          yield* Ref.set(authActionRef, action);
          const accepted = yield* Option.match(runtimeCoordinator, {
            onNone: () => Effect.succeed(false),
            onSome: (coordinator) => coordinator.requestUrlAuthentication(input.instanceId, action),
          });
          return accepted ? ({ action: "accept" } as const) : ({ action: "decline" } as const);
        }),
      );
      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        return update.sessionUpdate === "available_commands_update"
          ? Ref.set(commandsRef, normalizeAcpRegistryCommands(update.availableCommands)).pipe(
              Effect.andThen(Deferred.succeed(commandsAdvertised, undefined)),
              Effect.asVoid,
            )
          : Effect.void;
      });
      const startResult = yield* Effect.result(runtime.start());
      if (Result.isFailure(startResult)) {
        return yield* acpRegistryProbeFailure(
          startResult.failure,
          yield* Ref.get(authMethodsRef),
          yield* Ref.get(authActionRef),
        );
      }
      const started = startResult.success;
      yield* Deferred.await(commandsAdvertised).pipe(
        Effect.timeoutOption(COMMAND_ADVERTISEMENT_GRACE),
      );
      return { resolved, started, commands: yield* Ref.get(commandsRef) };
    }).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: PROBE_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new AcpRegistryOperationError({
              reason: "probe_failed",
              message: `The ACP agent did not resolve and create a test session within ${PROBE_TIMEOUT_SECONDS} seconds. Package installation or agent startup may be slow; this check retries on the next provider refresh.`,
            }),
          ),
      }),
      Effect.mapError((error) =>
        error._tag === "AcpRegistryOperationError" ? error : acpRegistryProbeFailure(error),
      ),
    );
    return {
      probe: acpRegistryProbeResult(
        input.instanceId,
        result.started,
        result.resolved.agent.icon ?? null,
        {
          command: result.resolved.spawn.command,
          args: result.resolved.spawn.args,
        },
      ),
      slashCommands: result.commands.slashCommands,
      skills: result.commands.skills,
      supportsPlanMode: acpRegistrySupportsPlanMode(
        result.started.sessionSetupResult.configOptions ?? [],
        parseSessionModeState(result.started.sessionSetupResult),
      ),
    };
  },
);
