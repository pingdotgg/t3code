import type * as EffectAcpSchema from "effect-acp/compat";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type KiroSettings, type OrchestrationV2ProviderFailure } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { makeProviderFailure } from "../../orchestration-v2/ProviderFailure.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

type KiroAcpRuntimeKiroSettings = Pick<KiroSettings, "binaryPath">;

interface KiroAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kiroSettings: KiroAcpRuntimeKiroSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

/** Kiro's own model id: the CLI picks a model per task. */
export const KIRO_DEFAULT_MODEL_ID = "auto";

/**
 * Kiro asks for every tool it does not already trust; T3's ACP policy answers
 * according to the thread's permission mode. No trust flags are passed, so the
 * agent's own trusted-tool list stays in force.
 */
export function buildKiroAcpSpawnInput(
  kiroSettings: KiroAcpRuntimeKiroSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: kiroSettings?.binaryPath || "kiro-cli",
    args: ["acp"],
    cwd,
    ...(environment === undefined ? {} : { env: environment }),
  };
}

/**
 * `kiro-cli` is a launcher that runs `kiro-cli-chat acp` as a child, so the
 * runtime owns the whole process group; killing the launcher alone would leave
 * the agent running.
 */
export function kiroAcpRuntimeProcessOwnership(
  processGroupPlatform: NodeJS.Platform,
): Pick<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "ownDescendantProcessGroups" | "ownDetachedProcessGroup" | "processGroupPlatform"
> {
  return {
    ownDescendantProcessGroups: processGroupPlatform === "linux",
    ownDetachedProcessGroup: true,
    processGroupPlatform,
  };
}

export const makeKiroAcpRuntime = (
  input: KiroAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const processGroupPlatform = yield* HostProcessPlatform.pipe(
      Effect.provide(NodeServices.layer),
    );
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildKiroAcpSpawnInput(input.kiroSettings, input.cwd, input.environment),
        ...kiroAcpRuntimeProcessOwnership(processGroupPlatform),
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

export function resolveKiroAcpModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : KIRO_DEFAULT_MODEL_ID;
}

export function currentKiroModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

/** Sends `session/set_model` only when the requested model differs from the session's. */
export function applyKiroAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | null | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string, E> {
  const requestedModelId = resolveKiroAcpModelId(input.requestedModelId);
  if (requestedModelId === input.currentModelId) {
    return Effect.succeed(requestedModelId);
  }
  return input.runtime
    .setSessionModel(requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(requestedModelId));
}

export interface KiroCliFailure {
  readonly kind: "chat-missing" | "not-logged-in";
  readonly message: string;
}

/**
 * Setup problems the CLI reports on stderr before anything works. The
 * Homebrew cask installs `kiro-cli` without its chat component until
 * `kiro-cli setup` has run, and a logged-out CLI exits before `initialize`.
 */
export function kiroCliFailure(stderr: string): KiroCliFailure | undefined {
  if (/failed to launch\b.*kiro-cli-chat/i.test(stderr)) {
    return {
      kind: "chat-missing",
      message: "Kiro CLI is installed but its chat component is missing. Run `kiro-cli setup`.",
    };
  }
  if (/not logged in/i.test(stderr)) {
    return {
      kind: "not-logged-in",
      message: "Kiro CLI is installed but not logged in. Run `kiro-cli login`.",
    };
  }
  return undefined;
}

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);
const isAcpProcessExitedError = Schema.is(EffectAcpErrors.AcpProcessExitedError);

/** The stderr excerpt attached to a process exit anywhere in the cause chain. */
function acpProcessStderr(cause: unknown): string | undefined {
  for (let depth = 0, current = cause; depth < 8 && current != null; depth += 1) {
    if (isAcpProcessExitedError(current)) return current.stderr;
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return undefined;
}

/** Turns a Kiro setup failure into the same actionable message the status probe shows. */
export function kiroPromptFailure(cause: unknown): OrchestrationV2ProviderFailure {
  const setupFailure = kiroCliFailure(acpProcessStderr(cause) ?? "");
  if (setupFailure !== undefined) {
    return makeProviderFailure({ cause, message: setupFailure.message, class: "provider_error" });
  }
  return makeProviderFailure({
    cause,
    ...(isAcpRequestError(cause)
      ? { message: cause.errorMessage, code: String(cause.code), class: "provider_error" }
      : { class: "provider_error" }),
  });
}
