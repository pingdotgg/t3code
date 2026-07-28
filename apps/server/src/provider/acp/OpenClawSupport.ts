import * as NodeServices from "@effect/platform-node/NodeServices";
import { type OpenClawSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

type OpenClawRuntimeSettings = Pick<
  OpenClawSettings,
  "binaryPath" | "passwordFile" | "resetSession" | "session" | "tokenFile" | "url"
>;

interface OpenClawRuntimeInput extends Omit<AcpSessionRuntime.AcpSessionRuntimeOptions, "spawn"> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly openClawSettings: OpenClawRuntimeSettings;
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * Builds the official OpenClaw ACP stdio entrypoint. Authentication remains in
 * OpenClaw config/environment unless the user supplies a credential file path;
 * credential values are never copied into argv.
 */
export function buildOpenClawSpawnInput(
  settings: OpenClawRuntimeSettings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  const args = ["acp"];
  if (settings.url) args.push("--url", settings.url);
  if (settings.tokenFile) args.push("--token-file", settings.tokenFile);
  if (settings.passwordFile) args.push("--password-file", settings.passwordFile);
  if (settings.session) args.push("--session", settings.session);
  if (settings.resetSession) args.push("--reset-session");

  return {
    command: settings.binaryPath || "openclaw",
    args,
    cwd,
    ...(environment === undefined ? {} : { env: environment }),
  };
}

export const makeOpenClawRuntime = (
  input: OpenClawRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const processGroupPlatform = yield* HostProcessPlatform.pipe(
      Effect.provide(NodeServices.layer),
    );
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildOpenClawSpawnInput(input.openClawSettings, input.cwd, input.environment),
        ownDetachedProcessGroup: true,
        ownDescendantProcessGroups: processGroupPlatform === "linux",
        processGroupPlatform,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
  });
