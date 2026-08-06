import { type HermesSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const HERMES_HOME_ENV = "HERMES_HOME";
// Host-side marker honored by `hermes acp` (acp_adapter/entry.py): skip
// starting the globally configured MCP servers from config.yaml because the
// host passes session MCP servers explicitly through session/new.
const HERMES_ACP_SKIP_CONFIGURED_MCP_ENV = "HERMES_ACP_SKIP_CONFIGURED_MCP";
// Hermes' ACP server always advertises this terminal setup auth method
// (acp_adapter/auth.py). ACP reuses Hermes' own runtime credentials, so the
// authenticate response is a formality; T3 never renders the terminal.
const HERMES_AUTH_METHOD_TERMINAL_SETUP = "hermes-setup";

type HermesAcpRuntimeHermesSettings = Pick<
  HermesSettings,
  "binaryPath" | "homePath" | "profile" | "launchArgs"
>;

export interface HermesAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly hermesSettings: HermesAcpRuntimeHermesSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  /** Skip Hermes' globally configured MCP servers (host passes them per session). */
  readonly skipConfiguredMcp?: boolean;
}

/**
 * Build the `hermes acp` spawn input.
 *
 * `--profile` is a Hermes global option, so it precedes the `acp` subcommand
 * per the documented grammar `hermes [global-options] <command>`. The
 * profile flag is unverified on the ACP path (the docs only document it for
 * the CLI) — if Hermes rejects it, sessions still start under the default
 * profile. `launchArgs` are appended after `acp` so users can pass
 * subcommand flags.
 */
export function buildHermesAcpSpawnInput(
  hermesSettings: HermesAcpRuntimeHermesSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  options?: { readonly skipConfiguredMcp?: boolean },
): AcpSessionRuntime.AcpSpawnInput {
  const profile = hermesSettings?.profile?.trim();
  const homePath = hermesSettings?.homePath?.trim();
  const env: NodeJS.ProcessEnv = { ...environment };
  if (homePath) {
    env[HERMES_HOME_ENV] = homePath;
  }
  if (options?.skipConfiguredMcp) {
    env[HERMES_ACP_SKIP_CONFIGURED_MCP_ENV] = "1";
  }
  return {
    command: hermesSettings?.binaryPath || "hermes",
    args: [
      ...(profile ? (["--profile", profile] as const) : []),
      "acp",
      ...tokenizeCliArgs(hermesSettings?.launchArgs),
    ],
    cwd,
    env,
  };
}

export const makeHermesAcpRuntime = (
  input: HermesAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildHermesAcpSpawnInput(
          input.hermesSettings,
          input.cwd,
          input.environment,
          input.skipConfiguredMcp ? { skipConfiguredMcp: true } : undefined,
        ),
        authMethodId: HERMES_AUTH_METHOD_TERMINAL_SETUP,
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
 * Read the current Hermes ACP model id from session setup.
 *
 * Hermes encodes model ids as `provider:model` (e.g.
 * `openrouter:anthropic/claude-sonnet-4.6`), while T3 slugs use
 * `provider/model`. The encoding is verified against Hermes' ACP server
 * (`_build_model_state` in acp_adapter/server.py).
 */
export function currentHermesModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

/**
 * Apply a T3 model selection to a Hermes ACP session.
 *
 * Hermes resolves `session/set_model` through `parse_model_input`, which
 * accepts both `provider/model` and bare model ids, so the T3 slug is passed
 * through unchanged. Because the session's `currentModelId` is always
 * `provider:model` encoded, an exact match only no-ops when the user picked
 * the current Hermes model verbatim; otherwise the switch is issued and
 * Hermes no-ops internally when nothing changed.
 */
export function applyHermesAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const shouldSwitchModel =
    input.requestedModelId !== undefined && input.requestedModelId !== input.currentModelId;
  if (!shouldSwitchModel) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(input.requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(input.requestedModelId));
}
