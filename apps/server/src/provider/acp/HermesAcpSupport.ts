import * as NodeServices from "@effect/platform-node/NodeServices";
import { type HermesAcpSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const HERMES_SKIP_CONFIGURED_MCP_ENV = "HERMES_ACP_SKIP_CONFIGURED_MCP";

type HermesAcpRuntimeSettings = Pick<HermesAcpSettings, "binaryPath">;

interface HermesAcpRuntimeInput extends Omit<AcpSessionRuntime.AcpSessionRuntimeOptions, "spawn"> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly hermesSettings: HermesAcpRuntimeSettings;
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * Hermes Agent's ACP entrypoint is a JSON-RPC stdio server. It is deliberately
 * separate from `hermes serve`, whose websocket protocol powers Hermes Work.
 */
export function buildHermesAcpSpawnInput(
  settings: HermesAcpRuntimeSettings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings.binaryPath || "hermes",
    args: ["acp"],
    cwd,
    env: {
      ...environment,
      // T3 supplies its scoped MCP endpoint in session/new and session/load.
      // Avoid also importing the user's global Hermes MCP configuration into
      // this separately supervised provider process.
      [HERMES_SKIP_CONFIGURED_MCP_ENV]: "1",
    },
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
    const processGroupPlatform = yield* HostProcessPlatform.pipe(
      Effect.provide(NodeServices.layer),
    );
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildHermesAcpSpawnInput(input.hermesSettings, input.cwd, input.environment),
        // Hermes tools may create child processes. Keep the ACP process and its
        // process tree inside the runtime's owned teardown boundary.
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
