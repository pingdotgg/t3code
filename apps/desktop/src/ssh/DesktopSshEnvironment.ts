import type {
  DesktopDiscoveredSshHost,
  DesktopSshEnvironmentBootstrap,
  DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as SshAuth from "@t3tools/ssh/auth";
import { discoverSshHosts } from "@t3tools/ssh/config";
import {
  type SshCommandError,
  type SshHostDiscoveryError,
  type SshInvalidTargetError,
  type SshLaunchError,
  type SshPairingError,
  SshPasswordPromptCancelledError,
  SshPasswordPromptError,
  SshPasswordPromptSecureRandomnessError,
  SshPasswordPromptServiceStoppedError,
  SshPasswordPromptTimedOutError,
  SshPasswordPromptWindowClosedError,
  SshPasswordPromptWindowUnavailableError,
  type SshReadinessError,
} from "@t3tools/ssh/errors";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";

const isSshPasswordPromptError = Schema.is(SshPasswordPromptError);

export type DesktopSshEnvironmentRuntimeServices =
  | ChildProcessSpawner.ChildProcessSpawner
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

export type DesktopSshEnvironmentError =
  | DesktopSshEnvironmentDiscoverError
  | DesktopSshEnvironmentOperationError;

export class DesktopSshEnvironment extends Context.Service<
  DesktopSshEnvironment,
  {
    readonly discoverHosts: (input?: {
      readonly homeDir?: string;
    }) => Effect.Effect<readonly DesktopDiscoveredSshHost[], DesktopSshEnvironmentDiscoverError>;
    readonly ensureEnvironment: (
      target: DesktopSshEnvironmentTarget,
      options?: { readonly issuePairingToken?: boolean },
    ) => Effect.Effect<DesktopSshEnvironmentBootstrap, DesktopSshEnvironmentOperationError>;
    readonly disconnectEnvironment: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<void, DesktopSshEnvironmentOperationError>;
  }
>()("@t3tools/desktop/ssh/DesktopSshEnvironment") {}

export interface DesktopSshEnvironmentLayerOptions {
  readonly resolveCliPackageSpec?: () => string;
  readonly resolveCliRunner?: Effect.Effect<SshTunnel.RemoteT3RunnerOptions>;
}

type DesktopSshPasswordPromptCancellationError = SshPasswordPromptError & {
  readonly cause: DesktopSshPasswordPrompts.DesktopSshPasswordPromptCancellation;
};

function discoverDesktopSshHostsEffect(input?: { readonly homeDir?: string }) {
  return discoverSshHosts(input ?? {});
}

export function isDesktopSshPasswordPromptCancellation(
  error: unknown,
): error is DesktopSshPasswordPromptCancellationError {
  return (
    isSshPasswordPromptError(error) &&
    "cause" in error &&
    DesktopSshPasswordPrompts.isDesktopSshPasswordPromptCancellation(error.cause)
  );
}

function unexpectedPasswordPromptError(error: never): never {
  throw new Error(`Unhandled desktop SSH password prompt error: ${String(error)}`);
}

export function toSshPasswordPromptError(
  cause: DesktopSshPasswordPrompts.DesktopSshPasswordPromptRequestError,
): SshPasswordPromptError {
  switch (cause._tag) {
    case "DesktopSshPromptRequestIdGenerationError":
      return new SshPasswordPromptSecureRandomnessError({
        destination: cause.destination,
        cause,
      });
    case "DesktopSshPromptWindowUnavailableError":
    case "DesktopSshPromptPresentationError":
      return new SshPasswordPromptWindowUnavailableError({
        destination: cause.destination,
        cause,
      });
    case "DesktopSshPromptTimedOutError":
      return new SshPasswordPromptTimedOutError({
        destination: cause.destination,
        cause,
      });
    case "DesktopSshPromptCancelledError":
      return new SshPasswordPromptCancelledError({
        destination: cause.destination,
        cause,
      });
    case "DesktopSshPromptWindowClosedError":
      return new SshPasswordPromptWindowClosedError({
        destination: cause.destination,
        cause,
      });
    case "DesktopSshPromptServiceStoppedError":
      return new SshPasswordPromptServiceStoppedError({
        destination: cause.destination,
        cause,
      });
    default:
      return unexpectedPasswordPromptError(cause);
  }
}

const makePasswordPrompt = (
  prompts: DesktopSshPasswordPrompts.DesktopSshPasswordPrompts["Service"],
): SshAuth.SshPasswordPrompt["Service"] => ({
  isAvailable: true,
  request: (request: SshAuth.SshPasswordRequest) =>
    prompts.request(request).pipe(Effect.mapError(toSshPasswordPromptError)),
});

export const make = Effect.gen(function* () {
  const manager = yield* SshTunnel.SshEnvironmentManager;
  const prompts = yield* DesktopSshPasswordPrompts.DesktopSshPasswordPrompts;
  const runtimeContext = yield* Effect.context<DesktopSshEnvironmentRuntimeServices>();
  const passwordPrompt = SshAuth.make(makePasswordPrompt(prompts));

  return DesktopSshEnvironment.of({
    discoverHosts: (input) =>
      discoverDesktopSshHostsEffect(input).pipe(
        Effect.provide(runtimeContext),
        Effect.withSpan("desktop.ssh.discoverHosts"),
      ),
    ensureEnvironment: (target, ensureOptions) =>
      manager
        .ensureEnvironment(target, ensureOptions)
        .pipe(
          Effect.provideService(SshAuth.SshPasswordPrompt, passwordPrompt),
          Effect.provide(runtimeContext),
          Effect.withSpan("desktop.ssh.ensureEnvironment"),
        ),
    disconnectEnvironment: (target) =>
      manager
        .disconnectEnvironment(target)
        .pipe(
          Effect.provideService(SshAuth.SshPasswordPrompt, passwordPrompt),
          Effect.provide(runtimeContext),
          Effect.withSpan("desktop.ssh.disconnectEnvironment"),
        ),
  });
});

export const layer = (options: DesktopSshEnvironmentLayerOptions = {}) =>
  Layer.effect(DesktopSshEnvironment, make).pipe(
    Layer.provide(
      SshTunnel.layer({
        ...(options.resolveCliPackageSpec === undefined
          ? {}
          : { resolveCliPackageSpec: options.resolveCliPackageSpec }),
        ...(options.resolveCliRunner === undefined
          ? {}
          : { resolveCliRunner: options.resolveCliRunner }),
      }),
    ),
  );
