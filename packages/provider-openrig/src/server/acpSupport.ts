import type { OpenRigSettings } from "../settings.ts";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { ProviderDriverKind } from "@t3tools/contracts";

export const OPENRIG_DRIVER_KIND = ProviderDriverKind.make("openrig");

const OPENRIG_ACP_BASE_ARGS = ["acp", "serve"] as const;

type OpenRigAcpRuntimeSettings = Pick<OpenRigSettings, "binaryPath" | "targetMember">;

/** Literal argv for `rig acp serve`, including optional `--to <member@rig>`. */
export function openRigAcpServeArgs(
  settings: Pick<OpenRigSettings, "targetMember"> | null | undefined,
): ReadonlyArray<string> {
  const target = settings?.targetMember?.trim() ?? "";
  return target.length === 0
    ? [...OPENRIG_ACP_BASE_ARGS]
    : [...OPENRIG_ACP_BASE_ARGS, "--to", target];
}

export function buildOpenRigAcpSpawnInput(
  settings: OpenRigAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings?.binaryPath || "rig",
    args: openRigAcpServeArgs(settings),
    cwd,
    ...(environment === undefined ? {} : { env: environment }),
  };
}

interface OpenRigAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly settings: OpenRigAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export const makeOpenRigAcpRuntime = Effect.fn("OpenRigAcpSupport.makeOpenRigAcpRuntime")(
  function* (
    input: OpenRigAcpRuntimeInput,
  ): Effect.fn.Return<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | Scope.Scope
  > {
    const { settings, environment, ...runtimeOptions } = input;
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...runtimeOptions,
        spawn: buildOpenRigAcpSpawnInput(settings, input.cwd, environment),
      }),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
  },
);
