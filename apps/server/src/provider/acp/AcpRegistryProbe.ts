import {
  AcpRegistryOperationError,
  AcpRegistryProbeResult,
  AcpRegistrySettings,
  type AcpRegistryProbeAuthMethod,
  type AcpRegistryProbeModel,
  type ProviderInstanceId,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { AcpRegistryCatalog, toAcpRegistryOperationError } from "./AcpRegistrySupport.ts";
import { parseSessionModeState } from "./AcpRuntimeModel.ts";
import { acpProviderOptionDescriptors } from "./AcpSessionConfig.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const MAX_AUTH_METHODS = 32;
const MAX_MODELS = 256;
const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 1_024;
const MAX_COMMANDS = 128;
const MAX_COMMAND_LINE_LENGTH = 2_048;
// Covers cold npx/uvx package materialization, which happens on the first
// probe after an agent is added and can dominate the session-create time.
const PROBE_TIMEOUT_SECONDS = 60;
const PROBE_TIMEOUT = `${PROBE_TIMEOUT_SECONDS} seconds`;
const COMMAND_ADVERTISEMENT_GRACE = "500 millis";

const boundedText = (value: string, maximumLength: number): string =>
  value.trim().slice(0, maximumLength);

const boundedOpaqueValue = (value: string, maximumLength: number): string | undefined =>
  value.length > 0 && value === value.trim() && value.length <= maximumLength ? value : undefined;

function modelConfigOptions(
  setup: AcpSessionRuntime.AcpSessionRuntimeStartResult["sessionSetupResult"],
): ReadonlyArray<EffectAcpSchema.SessionConfigSelectOption> {
  return (setup.configOptions ?? []).flatMap((option) => {
    if (option.category !== "model" || option.type !== "select") return [];
    return option.options.flatMap((candidate) =>
      "value" in candidate ? [candidate] : candidate.options,
    );
  });
}

function normalizeModels(
  setup: AcpSessionRuntime.AcpSessionRuntimeStartResult["sessionSetupResult"],
): ReadonlyArray<AcpRegistryProbeModel> {
  // Model discovery is the model config option's base models; ACP has no
  // other portable model inventory.
  const candidates = modelConfigOptions(setup).map((model) => ({
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
    const type = "type" in method ? method.type : "agent";
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
    });
    if (normalized.length === MAX_AUTH_METHODS) break;
  }
  return normalized;
}

export interface AcpRegistryAvailableCommands {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

export const emptyAcpRegistryAvailableCommands = (): AcpRegistryAvailableCommands => ({
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
  const modelOption = (started.sessionSetupResult.configOptions ?? []).find(
    (option) => option.category === "model" && option.type === "select",
  );
  const configModelId = modelOption?.type === "select" ? modelOption.currentValue : null;
  // Bound the agent-reported current model the same way normalizeModels bounds
  // model IDs, so it stays wire-encodable and matches a normalized model row.
  const rawCurrentModelId = configModelId ?? null;
  const boundedCurrentModelId =
    rawCurrentModelId == null
      ? null
      : (boundedOpaqueValue(rawCurrentModelId, MAX_ID_LENGTH) ?? null);
  const models = normalizeModels(started.sessionSetupResult);
  const currentModelId = models.some((model) => model.id === boundedCurrentModelId)
    ? boundedCurrentModelId
    : null;
  return AcpRegistryProbeResult.make({
    instanceId,
    ready: true,
    icon,
    authMethods: normalizeAcpRegistryAuthMethods(started.initializeResult.authMethods, spawn),
    models,
    currentModelId,
    configOptions: acpProviderOptionDescriptors({
      configOptions: started.sessionSetupResult.configOptions,
      modeState: parseSessionModeState(started.sessionSetupResult),
    }),
  });
}

export function acpRegistryProbeFailure(
  error: EffectAcpErrors.AcpError,
  authMethods: ReadonlyArray<AcpRegistryProbeAuthMethod> = [],
): AcpRegistryOperationError {
  const detail = error._tag === "AcpTransportError" && error.detail ? error.detail : error.message;
  const authenticationFailed =
    (error._tag === "AcpRequestError" && error.code === -32000) ||
    /authenticat|credential|log.?in/iu.test(detail);
  return new AcpRegistryOperationError({
    reason: authenticationFailed ? "authentication_failed" : "probe_failed",
    message: authenticationFailed
      ? `The ACP agent could not complete authentication: ${detail}`
      : `The ACP agent could not create a test session: ${detail}`,
    ...(authMethods.length > 0 ? { authMethods } : {}),
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
    const resolved = yield* catalog
      .resolve(input.settings, input.cwd, input.environment)
      .pipe(Effect.mapError(toAcpRegistryOperationError));

    const result = yield* Effect.gen(function* () {
      const authMethodsRef = yield* Ref.make<ReadonlyArray<AcpRegistryProbeAuthMethod>>([]);
      const runtimeContext = yield* Layer.build(
        AcpSessionRuntime.layer({
          spawn: resolved.spawn,
          cwd: input.cwd,
          clientCapabilities: {
            auth: { terminal: false },
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
        return yield* acpRegistryProbeFailure(startResult.failure, yield* Ref.get(authMethodsRef));
      }
      const started = startResult.success;
      yield* Deferred.await(commandsAdvertised).pipe(
        Effect.timeoutOption(COMMAND_ADVERTISEMENT_GRACE),
      );
      return { started, commands: yield* Ref.get(commandsRef) };
    }).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: PROBE_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new AcpRegistryOperationError({
              reason: "probe_failed",
              message: `The ACP agent did not create a test session within ${PROBE_TIMEOUT_SECONDS} seconds. A first run may still be downloading its package; this check retries on the next provider refresh.`,
            }),
          ),
      }),
      Effect.mapError((error) =>
        error._tag === "AcpRegistryOperationError" ? error : acpRegistryProbeFailure(error),
      ),
    );
    return {
      probe: acpRegistryProbeResult(input.instanceId, result.started, resolved.agent.icon ?? null, {
        command: resolved.spawn.command,
        args: resolved.spawn.args,
      }),
      slashCommands: result.commands.slashCommands,
      skills: result.commands.skills,
    };
  },
);
