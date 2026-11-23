import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as SshAuth from "@t3tools/ssh/auth";
import {
  remoteServerOverrides,
  withRemoteServerOverrides,
} from "@t3tools/ssh/remoteServerOverrides";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Digest from "effect/crypto/Digest";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import packageJson from "../../package.json" with { type: "json" };

export class SandboxTunnelError extends Schema.TaggedError<SandboxTunnelError>()(
  "SandboxTunnelError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export interface SandboxTunnel {
  readonly target: DesktopSshEnvironmentTarget;
  /** The Sandbox's T3 server, forwarded to this machine's loopback. */
  readonly httpBaseUrl: string;
  readonly pairingToken: string | null;
}

/**
 * Reaches each Sandbox's T3 server over SSH, starting it there when needed, and keeps the
 * forward open until `disconnect`. Sandboxes authenticate with agentctl's keys, so nothing
 * ever prompts for a password.
 */
export class AgentctlSandboxTunnels extends Context.Service<
  AgentctlSandboxTunnels,
  {
    readonly ensure: (
      target: DesktopSshEnvironmentTarget,
      options?: { readonly issuePairingToken?: boolean },
    ) => Effect.Effect<SandboxTunnel, SandboxTunnelError>;
    readonly disconnect: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<void, SandboxTunnelError>;
  }
>()("t3/agentctl/AgentctlSandboxTunnels") {}

const toTunnelError = (cause: { readonly message: string }) =>
  new SandboxTunnelError({ message: cause.message, cause });

// A Sandbox runs the release matching this server, or a dev server's own source checkout.
const sandboxServerRunner = Effect.gen(function* () {
  const devEntryPath = yield* Config.String("T3CODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH").pipe(
    Config.option,
  );
  const overrides = yield* remoteServerOverrides;
  const entryPath = Option.getOrUndefined(devEntryPath)?.trim();
  return withRemoteServerOverrides(
    entryPath
      ? { nodeScriptPath: entryPath, nodeEngineRange: packageJson.engines.node }
      : { archiveVersion: packageJson.version },
    overrides,
  );
}).pipe(Effect.orElseSucceed(() => ({ archiveVersion: packageJson.version })));

type SshServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | Digest.Digest
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService;

const make = Effect.gen(function* () {
  const manager = yield* SshTunnel.SshEnvironmentManager;
  const context = yield* Effect.context<SshServices>();
  const run = <A, E extends { readonly message: string }>(
    effect: Effect.Effect<A, E, SshServices | SshAuth.SshPasswordPrompt>,
  ) =>
    effect.pipe(
      Effect.provide(SshAuth.SshPasswordPrompt.disabledLayer),
      Effect.provide(context),
      Effect.mapError(toTunnelError),
    );
  return AgentctlSandboxTunnels.of({
    ensure: Effect.fn("AgentctlSandboxTunnels.ensure")(function* (target, options) {
      const bootstrap = yield* run(manager.ensureEnvironment(target, options));
      const httpBaseUrl = yield* run(
        SshTunnel.resolveLoopbackSshHttpBaseUrl(bootstrap.httpBaseUrl),
      );
      return { target: bootstrap.target, httpBaseUrl, pairingToken: bootstrap.pairingToken };
    }),
    disconnect: Effect.fn("AgentctlSandboxTunnels.disconnect")(function (target) {
      return run(manager.disconnectEnvironment(target));
    }),
  });
});

export const layer = Layer.effect(AgentctlSandboxTunnels, make).pipe(
  Layer.provide(
    Layer.unwrap(
      Effect.map(sandboxServerRunner, (runner) =>
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(runner) }),
      ),
    ),
  ),
  Layer.provide(NetService.layer),
);
