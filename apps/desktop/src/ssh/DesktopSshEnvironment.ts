import type {
  DesktopDiscoveredSshHost,
  DesktopSshEnvironmentBootstrap,
  DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as SshAuth from "@t3tools/ssh/auth";
import { resolveSshTarget } from "@t3tools/ssh/command";
import { discoverSshHosts } from "@t3tools/ssh/config";
import {
  SshCommandError,
  SshHostDiscoveryError,
  SshInvalidTargetError,
  SshLaunchError,
  SshPairingError,
  SshPasswordPromptError,
  SshReadinessError,
} from "@t3tools/ssh/errors";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import * as Context from "effect/Context";
import type * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";

export type DesktopSshEnvironmentRuntimeServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | Digest.Digest
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService;

export type DesktopSshEnvironmentOperationError =
  | SshCommandError
  | SshInvalidTargetError
  | SshLaunchError
  | SshPairingError
  | SshReadinessError
  | SshPasswordPromptError
  | NetService.NetError;

export type DesktopSshEnvironmentDiscoverError = SshHostDiscoveryError;

export class DesktopSshEnvironment extends Context.Service<
  DesktopSshEnvironment,
  {
    readonly discoverHosts: (input?: {
      readonly homeDir?: string;
    }) => Effect.Effect<readonly DesktopDiscoveredSshHost[], DesktopSshEnvironmentDiscoverError>;
    readonly resolveHost: (
      alias: string,
    ) => Effect.Effect<DesktopSshEnvironmentTarget, SshCommandError | SshInvalidTargetError>;
    readonly ensureEnvironment: (
      target: DesktopSshEnvironmentTarget,
      options?: { readonly issuePairingToken?: boolean },
    ) => Effect.Effect<DesktopSshEnvironmentBootstrap, DesktopSshEnvironmentOperationError>;
    readonly disconnectEnvironment: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<void, DesktopSshEnvironmentOperationError>;
    readonly closeAllTunnels: Effect.Effect<void>;
  }
>()("@t3tools/desktop/ssh/DesktopSshEnvironment") {}

export interface DesktopSshEnvironmentLayerOptions {
  readonly resolveCliRunner?: Effect.Effect<SshTunnel.RemoteT3RunnerOptions>;
  readonly resolveLauncherId?: Effect.Effect<string | null>;
}

// Remote servers record this ID as their owner, so it has to outlive restarts,
// updates and edits to a saved connection. Without a stored one there is none.
export const readOrCreateLauncherId = Effect.fn("desktop.ssh.readOrCreateLauncherId")(
  function* (filePath: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const random = yield* SecureRandom.SecureRandom;
    // Any other read failure may hide a stored ID, which a new one would overwrite.
    const stored = yield* fileSystem.readFileString(filePath).pipe(
      Effect.catchIf(
        (cause) => cause.reason._tag === "NotFound",
        () => Effect.succeed(""),
      ),
    );
    if (/^[0-9a-f]{32}$/u.test(stored.trim())) return stored.trim();
    const launcherId = (yield* random.uuidV4()).replace(/-/g, "");
    yield* fileSystem.writeFileString(filePath, `${launcherId}\n`);
    return launcherId;
  },
  Effect.orElseSucceed(() => null),
);

function discoverDesktopSshHostsEffect(input?: { readonly homeDir?: string }) {
  return discoverSshHosts(input ?? {});
}

const isSshPasswordPromptError = Schema.is(SshPasswordPromptError);

export function isDesktopSshPasswordPromptCancellation(
  error: unknown,
): error is SshPasswordPromptError {
  return (
    isSshPasswordPromptError(error) &&
    DesktopSshPasswordPrompts.isDesktopSshPasswordPromptCancellation(error.cause)
  );
}

function unexpectedPasswordPromptError(error: never): never {
  throw new Error(`Unhandled desktop SSH password prompt error: ${String(error)}`);
}

function toSshPasswordPromptError(
  cause: DesktopSshPasswordPrompts.DesktopSshPasswordPromptRequestError,
): SshPasswordPromptError {
  let message: string;
  switch (cause._tag) {
    case "DesktopSshPromptRequestIdGenerationError":
      message = "Secure randomness is unavailable.";
      break;
    case "DesktopSshPromptWindowUnavailableError":
    case "DesktopSshPromptPresentationError":
      message = "T3 Code window is not available for SSH authentication.";
      break;
    case "DesktopSshPromptTimedOutError":
      message = `SSH authentication timed out for ${cause.destination}.`;
      break;
    case "DesktopSshPromptCancelledError":
      message = `SSH authentication cancelled for ${cause.destination}.`;
      break;
    case "DesktopSshPromptWindowClosedError":
      message = "SSH authentication was cancelled because the app window closed.";
      break;
    case "DesktopSshPromptServiceStoppedError":
      message = "SSH password prompt service stopped.";
      break;
    default:
      return unexpectedPasswordPromptError(cause);
  }
  return new SshPasswordPromptError({ message, cause });
}

const makePasswordPrompt = (
  prompts: DesktopSshPasswordPrompts.DesktopSshPasswordPrompts["Service"],
): SshAuth.SshPasswordPrompt["Service"] => ({
  isAvailable: true,
  request: (request: SshAuth.SshPasswordRequest) =>
    prompts.request(request).pipe(Effect.mapError(toSshPasswordPromptError)),
});

/** @public */
export const make = Effect.gen(function* () {
  const manager = yield* SshTunnel.SshEnvironmentManager;
  const prompts = yield* DesktopSshPasswordPrompts.DesktopSshPasswordPrompts;
  const runtimeContext = yield* Effect.context<DesktopSshEnvironmentRuntimeServices>();
  const passwordPrompt = SshAuth.SshPasswordPrompt.of(makePasswordPrompt(prompts));

  return DesktopSshEnvironment.of({
    discoverHosts: Effect.fn("desktop.ssh.discoverHosts")(function* (input) {
      return yield* discoverDesktopSshHostsEffect(input);
    }, Effect.provide(runtimeContext)),
    resolveHost: Effect.fn("desktop.ssh.resolveHost")(function* (alias) {
      return yield* resolveSshTarget(alias.trim());
    }, Effect.provide(runtimeContext)),
    ensureEnvironment: Effect.fn("desktop.ssh.ensureEnvironment")(
      function* (target, ensureOptions) {
        return yield* manager.ensureEnvironment(target, ensureOptions);
      },
      Effect.provideService(SshAuth.SshPasswordPrompt, passwordPrompt),
      Effect.provide(runtimeContext),
    ),
    disconnectEnvironment: Effect.fn("desktop.ssh.disconnectEnvironment")(
      function* (target) {
        return yield* manager.disconnectEnvironment(target);
      },
      Effect.provideService(SshAuth.SshPasswordPrompt, passwordPrompt),
      Effect.provide(runtimeContext),
    ),
    closeAllTunnels: manager.closeAllTunnels,
  });
});

export const layer = (options: DesktopSshEnvironmentLayerOptions = {}) =>
  Layer.effect(DesktopSshEnvironment, make).pipe(
    Layer.provide(
      SshTunnel.SshEnvironmentManager.layer({
        ...(options.resolveCliRunner === undefined
          ? {}
          : { resolveCliRunner: options.resolveCliRunner }),
        ...(options.resolveLauncherId === undefined
          ? {}
          : { resolveLauncherId: options.resolveLauncherId }),
      }),
    ),
  );
