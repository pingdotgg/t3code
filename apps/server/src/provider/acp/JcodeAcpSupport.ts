import { type JcodeSettings, type RuntimeMode } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

/**
 * Jcode runs an ACP adapter as a child process of its background daemon
 * (`jcode acp`). Spawning the daemon itself would pull a TUI in, so the ACP
 * entry point is always the subprocess command.
 */
export function jcodeAcpSpawnArgs(): ReadonlyArray<string> {
  return ["acp"];
}

export function buildJcodeAcpSpawnInput(
  jcodeSettings: Pick<JcodeSettings, "binaryPath"> | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: jcodeSettings?.binaryPath || "jcode",
    args: [...jcodeAcpSpawnArgs()],
    cwd,
    ...(environment !== undefined ? { env: environment } : {}),
  };
}

/** Jcode manages its own auth against the daemon; there is no ACP login flow. */
const JCODE_AUTH_METHOD_CACHED_TOKEN = "cached_token";

export const makeJcodeAcpRuntime = (
  input: Omit<
    AcpSessionRuntime.AcpSessionRuntimeOptions,
    "authMethodId" | "clientCapabilities" | "spawn"
  > & {
    readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly jcodeSettings: JcodeAcpRuntimeJcodeSettings | null | undefined;
    readonly environment?: NodeJS.ProcessEnv;
    readonly runtimeMode?: RuntimeMode;
  },
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildJcodeAcpSpawnInput(input.jcodeSettings, input.cwd, input.environment),
        authMethodId: JCODE_AUTH_METHOD_CACHED_TOKEN,
        sendsAuthenticate: false,
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

type JcodeAcpRuntimeJcodeSettings = Pick<JcodeSettings, "binaryPath">;

export const JCODE_DEFAULT_MODEL_SLUG = "jcode-auto";

export function resolveJcodeAcpBaseModelId(model: string | null | undefined): string {
  // The product default ("auto" in DEFAULT_MODEL_BY_PROVIDER) and any unset
  // selection mean "the daemon's own choice": normalize both onto the ACP
  // default slug so callers can compare against one canonical value.
  const trimmed = model?.trim();
  if (!trimmed || trimmed === "auto") return JCODE_DEFAULT_MODEL_SLUG;
  return trimmed;
}
