// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  type KimiSettings,
  ProviderDriverKind,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import type { AcpSessionMode, AcpSessionModeState } from "./AcpRuntimeModel.ts";
import type * as EffectAcpSchema from "effect-acp/schema";

const KIMI_DRIVER_KIND = ProviderDriverKind.make("kimi");
export const KIMI_DEFAULT_MODEL_SLUG =
  DEFAULT_MODEL_BY_PROVIDER[KIMI_DRIVER_KIND] ?? "kimi-code/kimi-for-coding";
const KIMI_HOME_ENV = "KIMI_CODE_HOME";
const KIMI_CREDENTIALS_RELATIVE_PATH = ["credentials", "kimi-code.json"] as const;

type KimiAcpRuntimeKimiSettings = Pick<KimiSettings, "binaryPath">;

interface KimiAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kimiSettings: KimiAcpRuntimeKimiSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

/** Builds the child-process command for Kimi's ACP server. */
function buildKimiAcpSpawnInput(
  kimiSettings: KimiAcpRuntimeKimiSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: kimiSettings?.binaryPath || "kimi",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

/**
 * Spawns a scoped Kimi ACP runtime using the CLI's terminal login method.
 * Closing the required scope also owns cleanup of the child process.
 */
export const makeKimiAcpRuntime = (
  input: KimiAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildKimiAcpSpawnInput(input.kimiSettings, input.cwd, input.environment),
        authMethodId: "login",
        // Advertise form-mode elicitation so Kimi's ACP process sends
        // `session/elicitation` requests to the client instead of bailing out
        // with `methodNotFound`. The form capability is the only one Kimi
        // 0.43.x exercises today; URL elicitation stays off.
        clientCapabilities: {
          elicitation: {
            form: {},
          },
        },
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

/**
 * Resolves the Kimi data directory from `KIMI_CODE_HOME`, falling back to
 * `~/.kimi-code`. A leading `~` expands to the real home so the path matches
 * what the spawned CLI resolves. The returned path is never read — callers
 * only join it.
 */
function resolveKimiDataHome(environment: NodeJS.ProcessEnv | undefined): string {
  const override = environment?.[KIMI_HOME_ENV]?.trim();
  if (!override) {
    return NodePath.join(NodeOS.homedir(), ".kimi-code");
  }
  if (override === "~") {
    return NodeOS.homedir();
  }
  if (override.startsWith("~/")) {
    return NodePath.join(NodeOS.homedir(), override.slice(2));
  }
  return override;
}

/**
 * Existence of this file is the login signal (`kimi login` writes it). Never
 * read the file — it holds the access token.
 */
export function resolveKimiCredentialsPath(environment: NodeJS.ProcessEnv | undefined): string {
  return NodePath.join(resolveKimiDataHome(environment), ...KIMI_CREDENTIALS_RELATIVE_PATH);
}

/** Normalizes a model selection, using Kimi's default for missing or blank values. */
export function resolveKimiAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : KIMI_DEFAULT_MODEL_SLUG;
  return normalizeModelSlug(base, KIMI_DRIVER_KIND) ?? KIMI_DEFAULT_MODEL_SLUG;
}

/** The session's current model from the live `model` config option. */
export function currentKimiModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  const configOptions = sessionSetupResult.configOptions;
  if (!configOptions) {
    return undefined;
  }
  const modelOption = configOptions.find(
    (option) => option.category === "model" && option.type === "select",
  );
  if (!modelOption || typeof modelOption.currentValue !== "string") {
    return undefined;
  }
  return modelOption.currentValue.trim() || undefined;
}

const KIMI_PLAN_MODE_ALIASES = ["plan"];
const KIMI_APPROVAL_MODE_ALIASES = ["default"];
const KIMI_AUTO_MODE_ALIASES = ["auto"];
const KIMI_FULL_ACCESS_MODE_ALIASES = ["yolo"];

function normalizeModeSearchText(mode: AcpSessionMode): string {
  return [mode.id, mode.name, mode.description]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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
    if (exact) {
      return exact;
    }
  }
  for (const alias of normalizedAliases) {
    const partial = modes.find((mode) => normalizeModeSearchText(mode).includes(alias));
    if (partial) {
      return partial;
    }
  }
  return undefined;
}

/**
 * Maps T3's interaction/runtime modes onto the mode ids Kimi advertises on
 * `session/new`. Kimi has no acceptEdits equivalent: approval-required maps
 * to `default` and both auto modes map to `auto`. Aliases are resolved
 * against the live `modes` response; when none match the session's current
 * mode is kept.
 */
export function resolveRequestedKimiModeId(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState) {
    return undefined;
  }

  if (input.interactionMode === "plan") {
    return (
      findModeByAliases(modeState.availableModes, KIMI_PLAN_MODE_ALIASES)?.id ??
      modeState.currentModeId
    );
  }

  switch (input.runtimeMode) {
    case "approval-required":
      return (
        findModeByAliases(modeState.availableModes, KIMI_APPROVAL_MODE_ALIASES)?.id ??
        modeState.currentModeId
      );
    case "auto-accept-edits":
    case "auto":
      return (
        findModeByAliases(modeState.availableModes, KIMI_AUTO_MODE_ALIASES)?.id ??
        modeState.currentModeId
      );
    case "full-access":
      return (
        findModeByAliases(modeState.availableModes, KIMI_FULL_ACCESS_MODE_ALIASES)?.id ??
        modeState.currentModeId
      );
    default:
      return modeState.currentModeId;
  }
}

/**
 * Selects a nonblank model only when it differs from the session's current
 * model, returning the model id in effect after the operation.
 */
export function applyKimiAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const requestedModelId = input.requestedModelId?.trim() || undefined;
  if (requestedModelId === undefined || requestedModelId === input.currentModelId) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(requestedModelId));
}

/**
 * Kimi isolates sub-agent work behind a single `tool_call` whose title is the
 * dispatch name — there is no `_meta` linkage and no inner-activity stream.
 * Classify by title so the rows render like other providers' subagent spawns.
 */
export function classifyKimiSubagentLabel(
  title: string | undefined,
): "Subagent" | "Agent swarm" | undefined {
  const normalized = title?.trim().toLowerCase() ?? "";
  if (normalized === "agent") {
    return "Subagent";
  }
  if (normalized === "agentswarm") {
    return "Agent swarm";
  }
  return undefined;
}
