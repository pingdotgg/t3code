import {
  type OmpSettings,
  type ProviderApprovalDecision,
  type ProviderOptionSelection,
  type ProviderInteractionMode,
  type ProviderUserInputAnswers,
  type RuntimeMode,
  type UserInputQuestion,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { getProviderOptionStringSelectionValue } from "@t3tools/shared/model";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import {
  type AcpSessionMode,
  type AcpSessionModeState,
  type AcpPermissionRequest,
  collectSessionConfigOptionValues,
} from "./AcpRuntimeModel.ts";

export const OMP_RESUME_VERSION = 1 as const;
const ACP_PLAN_MODE_ALIASES = ["plan", "architect"];
const ACP_IMPLEMENT_MODE_ALIASES = ["code", "agent", "default", "chat", "implement"];

export const OMP_ACP_CLIENT_CAPABILITIES = {
  elicitation: { form: {} },
} satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

export interface OmpAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly ompSettings: Pick<OmpSettings, "binaryPath" | "launchArgs"> | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

export interface OmpAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-config-option" | "set-model";
  readonly configId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseOmpResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== OMP_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

function modeSearchTokens(mode: AcpSessionMode): ReadonlySet<string> {
  return new Set(
    [mode.id, mode.name, mode.description]
      .filter((value): value is string => typeof value === "string")
      .flatMap((value) => value.toLowerCase().match(/[a-z0-9]+/g) ?? []),
  );
}

function findModeByAliases(
  modes: ReadonlyArray<AcpSessionMode>,
  aliases: ReadonlyArray<string>,
): AcpSessionMode | undefined {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
  for (const alias of normalizedAliases) {
    const exact = modes.find((mode) => {
      const id = mode.id.toLowerCase();
      const name = mode.name.toLowerCase();
      return id === alias || name === alias;
    });
    if (exact) return exact;
  }
  return normalizedAliases
    .map((alias) => modes.find((mode) => modeSearchTokens(mode).has(alias)))
    .find((mode) => mode !== undefined);
}

function isPlanMode(mode: AcpSessionMode): boolean {
  return findModeByAliases([mode], ACP_PLAN_MODE_ALIASES) !== undefined;
}

function requestedOmpModeId(
  modeState: AcpSessionModeState | undefined,
  interactionMode: ProviderInteractionMode | undefined,
): string | undefined {
  if (!modeState) return undefined;
  if (interactionMode === "plan") {
    return findModeByAliases(modeState.availableModes, ACP_PLAN_MODE_ALIASES)?.id;
  }
  const implementationMode = findModeByAliases(
    modeState.availableModes,
    ACP_IMPLEMENT_MODE_ALIASES,
  );
  if (implementationMode) return implementationMode.id;
  const currentMode = modeState.availableModes.find((mode) => mode.id === modeState.currentModeId);
  if (currentMode && !isPlanMode(currentMode)) return currentMode.id;
  return modeState.availableModes.find((mode) => !isPlanMode(mode))?.id;
}

export function applyOmpRequestedSessionConfiguration<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getConfigOptions" | "getModeState" | "setConfigOption" | "setMode" | "setModel"
  >;
  readonly interactionMode?: ProviderInteractionMode;
  readonly modelSelection:
    | {
        readonly model: string;
        readonly options?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
      }
    | undefined;
  readonly defaultModel?: string | undefined;
  readonly mapError: (context: {
    readonly cause: EffectAcpErrors.AcpError;
    readonly method: "session/set_config_option" | "session/set_mode";
  }) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    if (input.modelSelection) {
      yield* applyOmpAcpModelSelection({
        runtime: input.runtime,
        model: input.modelSelection.model,
        selections: input.modelSelection.options,
        defaultModel: input.defaultModel,
        mapError: ({ cause }) => input.mapError({ cause, method: "session/set_config_option" }),
      });
    }

    const modeId = requestedOmpModeId(yield* input.runtime.getModeState, input.interactionMode);
    if (!modeId) return;
    yield* input.runtime
      .setMode(modeId)
      .pipe(Effect.mapError((cause) => input.mapError({ cause, method: "session/set_mode" })));
  });
}

export function selectAutoApprovedOmpPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  const allowAlwaysOption = request.options.find((option) => option.kind === "allow_always");
  if (typeof allowAlwaysOption?.optionId === "string" && allowAlwaysOption.optionId.trim()) {
    return allowAlwaysOption.optionId.trim();
  }
  const allowOnceOption = request.options.find((option) => option.kind === "allow_once");
  return typeof allowOnceOption?.optionId === "string" && allowOnceOption.optionId.trim()
    ? allowOnceOption.optionId.trim()
    : undefined;
}

export function shouldAutoApproveOmpPermission(
  runtimeMode: RuntimeMode,
  request: AcpPermissionRequest,
): boolean {
  if (runtimeMode === "full-access") return true;
  const locations = request.toolCall?.data.locations;
  return (
    runtimeMode === "auto-accept-edits" &&
    request.kind !== "execute" &&
    request.toolCall?.command === undefined &&
    Array.isArray(locations) &&
    locations.length > 0
  );
}

export function selectOmpPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const preferredKinds =
    decision === "acceptForSession"
      ? (["allow_always", "allow_once"] as const)
      : decision === "accept"
        ? (["allow_once", "allow_always"] as const)
        : (["reject_once", "reject_always"] as const);
  for (const kind of preferredKinds) {
    const option = request.options.find((candidate) => candidate.kind === kind);
    if (typeof option?.optionId === "string" && option.optionId.trim()) {
      return option.optionId.trim();
    }
  }
  return undefined;
}

export interface OmpElicitationQuestion {
  readonly key: string;
  readonly otherKey?: string;
  readonly otherSchema?: EffectAcpSchema.ElicitationPropertySchema;
  readonly required: boolean;
  readonly schema: EffectAcpSchema.ElicitationPropertySchema;
  readonly question: UserInputQuestion;
}

const CUSTOM_ANSWER_OPTION = {
  label: "Type a response",
  description: "Enter your answer in the message box.",
} as const;

function enumChoices(
  schema: EffectAcpSchema.ElicitationPropertySchema,
): ReadonlyArray<{ readonly value: string; readonly label: string }> {
  if (schema.type === "string") {
    if (schema.oneOf && schema.oneOf.length > 0) {
      return schema.oneOf.map((choice) => ({ value: choice.const, label: choice.title }));
    }
    return (schema.enum ?? []).map((value) => ({ value, label: value }));
  }
  if (schema.type !== "array") return [];
  return "anyOf" in schema.items
    ? schema.items.anyOf.map((choice) => ({ value: choice.const, label: choice.title }))
    : schema.items.enum.map((value) => ({ value, label: value }));
}

function choiceDisplayLabel(
  choices: ReadonlyArray<{ readonly value: string; readonly label: string }>,
  choice: { readonly value: string; readonly label: string },
): string {
  const label = choice.label.trim() || choice.value;
  const duplicateCount = choices.filter(
    (candidate) => (candidate.label.trim() || candidate.value) === label,
  ).length;
  return duplicateCount > 1 ? `${label} (${choice.value})` : label;
}

function selectedChoiceValue(
  schema: EffectAcpSchema.ElicitationPropertySchema,
  answer: string,
): string | undefined {
  const normalized = answer.trim();
  const choices = enumChoices(schema);
  return choices.find(
    (choice) => choice.value === normalized || choiceDisplayLabel(choices, choice) === normalized,
  )?.value;
}

export function ompElicitationQuestions(
  request: Extract<EffectAcpSchema.ElicitationRequest, { readonly mode: "form" }>,
): ReadonlyArray<OmpElicitationQuestion> {
  const properties = request.requestedSchema.properties ?? {};
  const requiredKeys = new Set(request.requestedSchema.required ?? []);
  const entries = Object.entries(properties).filter(
    ([key]) => !key.endsWith("__other") && requiredKeys.has(key),
  );
  return entries.map(([key, schema], index) => {
    const choices = enumChoices(schema);
    const options =
      schema.type === "boolean"
        ? [
            { label: "Yes", description: "Confirm this action." },
            { label: "No", description: "Do not confirm this action." },
          ]
        : choices.length > 0
          ? choices.map((choice) => {
              const label = choiceDisplayLabel(choices, choice);
              return { label, description: label };
            })
          : [CUSTOM_ANSWER_OPTION];
    const title = schema.title?.trim();
    const description = schema.description?.trim();
    const header =
      request.requestedSchema.title?.trim() ||
      (description && description.length <= 48 ? description : undefined) ||
      `Question ${index + 1}`;
    return {
      key,
      ...(properties[`${key}__other`]
        ? {
            otherKey: `${key}__other`,
            otherSchema: properties[`${key}__other`],
          }
        : {}),
      required: requiredKeys.has(key),
      schema,
      question: {
        id: key,
        header,
        question: title || request.message.trim() || `Answer question ${index + 1}.`,
        options,
        ...(schema.type === "array" ? { multiSelect: true } : {}),
      },
    };
  });
}

export function resolveEmptyOmpElicitationResponse(
  request: Extract<EffectAcpSchema.ElicitationRequest, { readonly mode: "form" }>,
): EffectAcpSchema.ElicitationResponse {
  return (request.requestedSchema.required?.length ?? 0) > 0
    ? { action: { action: "cancel" } }
    : { action: { action: "accept", content: {} } };
}
function normalizeElicitationAnswer(
  answer: unknown,
  schema: EffectAcpSchema.ElicitationPropertySchema,
): EffectAcpSchema.ElicitationContentValue | undefined {
  if (schema.type === "array") {
    const values = Array.isArray(answer) ? answer : typeof answer === "string" ? [answer] : [];
    const normalized = values.flatMap((value) => {
      if (typeof value !== "string") return [];
      const selected = selectedChoiceValue(schema, value);
      return selected === undefined ? [] : [selected];
    });
    return normalized.length > 0 ? normalized : undefined;
  }
  const scalar = Array.isArray(answer) ? answer[0] : answer;
  if (schema.type === "boolean") {
    if (typeof scalar === "boolean") return scalar;
    if (typeof scalar !== "string") return undefined;
    const normalized = scalar.trim().toLowerCase();
    if (["yes", "true", "1"].includes(normalized)) return true;
    if (["no", "false", "0"].includes(normalized)) return false;
    return undefined;
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (scalar == null || (typeof scalar === "string" && scalar.trim().length === 0)) {
      return undefined;
    }
    const value = typeof scalar === "number" ? scalar : Number(scalar);
    if (!Number.isFinite(value)) return undefined;
    return schema.type === "integer" && !Number.isInteger(value) ? undefined : value;
  }
  if (typeof scalar !== "string" || scalar.trim().length === 0) return undefined;
  return selectedChoiceValue(schema, scalar) ?? scalar.trim();
}

export function buildOmpElicitationContent(
  questions: ReadonlyArray<OmpElicitationQuestion>,
  answers: ProviderUserInputAnswers,
): Record<string, EffectAcpSchema.ElicitationContentValue> {
  const content: Record<string, EffectAcpSchema.ElicitationContentValue> = {};
  for (const question of questions) {
    const rawAnswer = answers[question.key];
    if (question.schema.type === "array" && Array.isArray(rawAnswer)) {
      const selectedValues = normalizeElicitationAnswer(rawAnswer, question.schema);
      if (selectedValues !== undefined) {
        content[question.key] = selectedValues;
      }
      const customValues = rawAnswer.flatMap((answer) => {
        if (typeof answer !== "string") return [];
        const value = answer.trim();
        return value && selectedChoiceValue(question.schema, value) === undefined ? [value] : [];
      });
      if (question.otherKey && customValues.length > 0) {
        content[question.otherKey] =
          question.otherSchema?.type === "array" ? customValues : customValues.join(", ");
      }
      continue;
    }
    const normalized = normalizeElicitationAnswer(rawAnswer, question.schema);
    const scalarAnswer = Array.isArray(rawAnswer) ? rawAnswer[0] : rawAnswer;
    if (
      question.otherKey &&
      typeof scalarAnswer === "string" &&
      scalarAnswer.trim().length > 0 &&
      selectedChoiceValue(question.schema, scalarAnswer) === undefined
    ) {
      content[question.otherKey] = scalarAnswer.trim();
      continue;
    }
    if (normalized !== undefined) content[question.key] = normalized;
  }
  return content;
}

export function buildOmpAcpSpawnInput(
  ompSettings: Pick<OmpSettings, "binaryPath" | "launchArgs"> | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
): AcpSessionRuntime.AcpSpawnInput {
  const configuredArgs = tokenizeCliArgs(ompSettings?.launchArgs);
  const launchArgs = runtimeMode
    ? [...withoutOmpApprovalArgs(configuredArgs), "--approval-mode", ompApprovalMode(runtimeMode)]
    : configuredArgs;
  return {
    command: ompSettings?.binaryPath?.trim() || "omp",
    args: ["acp", ...launchArgs],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

function withoutOmpApprovalArgs(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const safeArgs: Array<string> = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (
      arg === "--auto-approve" ||
      arg === "--yolo" ||
      arg?.startsWith("--auto-approve=") ||
      arg?.startsWith("--yolo=") ||
      arg?.startsWith("--approval-mode=")
    ) {
      continue;
    }
    if (arg === "--approval-mode") {
      index += 1;
      continue;
    }
    if (arg !== undefined) safeArgs.push(arg);
  }
  return safeArgs;
}

export function ompApprovalMode(runtimeMode: RuntimeMode): "always-ask" | "write" | "yolo" {
  switch (runtimeMode) {
    case "full-access":
      return "yolo";
    case "auto-accept-edits":
      return "write";
    case "approval-required":
    case "auto":
      return "always-ask";
  }
}

const OMP_TEXT_GENERATION_ACP_ARGS = [
  "--no-tools",
  "--no-session",
  "--no-extensions",
  "--no-skills",
  "--no-rules",
  "--approval-mode",
  "always-ask",
] as const;

function hasBalancedCliQuotes(launchArgs: string | undefined): boolean {
  if (!launchArgs) return true;

  let quote: "'" | '"' | undefined;
  for (let index = 0; index < launchArgs.length; index++) {
    const char = launchArgs[index];
    if (char === undefined) continue;

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (char === "\\" && quote === '"') {
        index++;
      }
      continue;
    }

    if (char === "'" || char === '"') quote = char;
  }

  return quote === undefined;
}

export function ompProfileFromLaunchArgs(launchArgs: string | undefined): string | undefined {
  if (!hasBalancedCliQuotes(launchArgs)) return undefined;

  let profile: string | undefined;
  const args = tokenizeCliArgs(launchArgs);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--profile") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) return undefined;
      if (profile !== undefined) return undefined;
      profile = value;
      index++;
      continue;
    }

    if (arg?.startsWith("--profile=")) {
      const value = arg.slice("--profile=".length);
      if (!value || value.startsWith("-")) return undefined;
      if (profile !== undefined) return undefined;
      profile = value;
    }
  }

  return profile;
}

function textGenerationSettingsArgs(launchArgs: string | undefined): ReadonlyArray<string> {
  if (!hasBalancedCliQuotes(launchArgs)) return [];
  const safeArgs: string[] = [];
  const profile = ompProfileFromLaunchArgs(launchArgs);
  if (profile) safeArgs.push("--profile", profile);

  const args = tokenizeCliArgs(launchArgs);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--config") {
      const value = args[index + 1];
      if (value && !value.startsWith("-")) {
        safeArgs.push("--config", value);
        index++;
      }
      continue;
    }
    if (arg?.startsWith("--config=")) {
      const value = arg.slice("--config=".length);
      if (value) safeArgs.push("--config", value);
    }
  }
  return safeArgs;
}

export function buildOmpTextGenerationAcpSpawnInput(
  ompSettings: Pick<OmpSettings, "binaryPath" | "launchArgs"> | null | undefined,
  cwd: string,
  sessionDir: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: ompSettings?.binaryPath?.trim() || "omp",
    args: [
      "acp",
      ...textGenerationSettingsArgs(ompSettings?.launchArgs),
      "--session-dir",
      sessionDir,
      ...OMP_TEXT_GENERATION_ACP_ARGS,
    ],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

const makeOmpAcpRuntimeWithSpawn = (
  input: OmpAcpRuntimeInput,
  spawn: AcpSessionRuntime.AcpSpawnInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn,
        authMethodId: "agent",
        clientCapabilities: OMP_ACP_CLIENT_CAPABILITIES,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export const makeOmpAcpRuntime = (
  input: OmpAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  makeOmpAcpRuntimeWithSpawn(
    input,
    buildOmpAcpSpawnInput(input.ompSettings, input.cwd, input.environment, input.runtimeMode),
  );

export const makeOmpTextGenerationAcpRuntime = (
  input: OmpAcpRuntimeInput & { readonly sessionDir: string },
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  makeOmpAcpRuntimeWithSpawn(
    input,
    buildOmpTextGenerationAcpSpawnInput(
      input.ompSettings,
      input.cwd,
      input.sessionDir,
      input.environment,
    ),
  );

interface OmpAcpModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntime.AcpSessionRuntime["Service"]["getConfigOptions"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

function normalizeConfigValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "-");
}

function findConfigOptionByCategory(
  options: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  category: string,
  names: ReadonlyArray<string>,
): EffectAcpSchema.SessionConfigOption | undefined {
  const normalizedNames = names.map(normalizeConfigValue);
  return (
    options.find((option) => option.category?.trim().toLowerCase() === category) ??
    options.find((option) => {
      const id = normalizeConfigValue(option.id);
      const name = normalizeConfigValue(option.name);
      return normalizedNames.some((candidate) => id === candidate || name.includes(candidate));
    })
  );
}
export function getOmpAcpCurrentModel(
  options: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): string | undefined {
  const currentValue = findConfigOptionByCategory(options, "model", ["model"])?.currentValue;
  return typeof currentValue === "string" && currentValue.trim() ? currentValue.trim() : undefined;
}

function resolveConfigValue(
  option: EffectAcpSchema.SessionConfigOption | undefined,
  requested: string | undefined,
): string | boolean | undefined {
  if (!option || requested === undefined) return undefined;
  if (option.type === "boolean") {
    const normalized = normalizeConfigValue(requested);
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    return undefined;
  }
  const wanted = normalizeConfigValue(requested);
  return collectSessionConfigOptionValues(option).find(
    (value) => normalizeConfigValue(value) === wanted,
  );
}

export function resolveOmpAcpConfigUpdates(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ReadonlyArray<{ readonly configId: string; readonly value: string | boolean }> {
  if (!configOptions || configOptions.length === 0) return [];

  const updates: Array<{ readonly configId: string; readonly value: string | boolean }> = [];
  const thinkingOption = findConfigOptionByCategory(configOptions, "thought_level", [
    "thinking",
    "reasoning",
    "effort",
  ]);
  const thinkingValue = resolveConfigValue(
    thinkingOption,
    getProviderOptionStringSelectionValue(selections, "thinking") ??
      getProviderOptionStringSelectionValue(selections, "reasoning"),
  );
  if (thinkingOption && thinkingValue !== undefined) {
    updates.push({ configId: thinkingOption.id, value: thinkingValue });
  }

  const modeOption = findConfigOptionByCategory(configOptions, "mode", ["mode"]);
  const modeValue = resolveConfigValue(
    modeOption,
    getProviderOptionStringSelectionValue(selections, "mode"),
  );
  if (modeOption && modeValue !== undefined) {
    updates.push({ configId: modeOption.id, value: modeValue });
  }

  return updates;
}

export function applyOmpAcpModelSelection<E>(input: {
  readonly runtime: OmpAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly defaultModel?: string | undefined;
  readonly mapError: (context: OmpAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const requestedModel = input.model?.trim();
    const model = requestedModel === "default" ? input.defaultModel?.trim() : requestedModel;
    if (model) {
      yield* input.runtime
        .setModel(model)
        .pipe(Effect.mapError((cause) => input.mapError({ cause, step: "set-model" })));
    }

    const configOptions = yield* input.runtime.getConfigOptions;
    for (const update of resolveOmpAcpConfigUpdates(configOptions, input.selections)) {
      yield* input.runtime
        .setConfigOption(update.configId, update.value)
        .pipe(
          Effect.mapError((cause) =>
            input.mapError({ cause, step: "set-config-option", configId: update.configId }),
          ),
        );
    }
  });
}
