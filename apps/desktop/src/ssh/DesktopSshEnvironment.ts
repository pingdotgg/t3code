import type {
  DesktopDiscoveredSshHost,
  DesktopSshEnvironmentBootstrap,
  DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import {
  SshPasswordPrompt,
  type SshPasswordPromptShape,
  type SshPasswordRequest,
} from "@t3tools/ssh/auth";
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
import { SshEnvironmentManager, type RemoteT3RunnerOptions } from "@t3tools/ssh/tunnel";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";

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

export interface DesktopSshEnvironmentShape {
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

export class DesktopSshEnvironment extends Context.Service<
  DesktopSshEnvironment,
  DesktopSshEnvironmentShape
>()("t3/desktop/SshEnvironment") {}

export interface DesktopSshEnvironmentLayerOptions {
  readonly resolveCliPackageSpec?: () => string;
  readonly resolveCliRunner?: Effect.Effect<RemoteT3RunnerOptions>;
}

function discoverDesktopSshHostsEffect(input?: { readonly homeDir?: string }) {
  return discoverSshHosts(input ?? {});
}

export function isDesktopSshPasswordPromptCancellation(
  error: unknown,
): error is SshPasswordPromptError {
  return (
    error instanceof SshPasswordPromptError &&
    DesktopSshPasswordPrompts.isDesktopSshPasswordPromptCancellation(error.cause)
  );
}

const makePasswordPrompt = (
  prompts: DesktopSshPasswordPrompts.DesktopSshPasswordPromptsShape,
): SshPasswordPromptShape => ({
  isAvailable: true,
  request: (request: SshPasswordRequest) =>
    prompts.request(request).pipe(
      Effect.mapError(
        (cause) =>
          new SshPasswordPromptError({
            message: cause.message,
            cause,
          }),
      ),
    ),
});

const make = Effect.gen(function* () {
  const manager = yield* SshEnvironmentManager;
  const prompts = yield* DesktopSshPasswordPrompts.DesktopSshPasswordPrompts;
  const runtimeContext = yield* Effect.context<DesktopSshEnvironmentRuntimeServices>();
  const passwordPrompt = SshPasswordPrompt.of(makePasswordPrompt(prompts));

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
          Effect.provideService(SshPasswordPrompt, passwordPrompt),
          Effect.provide(runtimeContext),
          Effect.withSpan("desktop.ssh.ensureEnvironment"),
        ),
    disconnectEnvironment: (target) =>
      manager
        .disconnectEnvironment(target)
        .pipe(
          Effect.provideService(SshPasswordPrompt, passwordPrompt),
          Effect.provide(runtimeContext),
          Effect.withSpan("desktop.ssh.disconnectEnvironment"),
        ),
  });
});

export const layer = (options: DesktopSshEnvironmentLayerOptions = {}) =>
  Layer.effect(DesktopSshEnvironment, make).pipe(
    Layer.provide(
      SshEnvironmentManager.layer({
        ...(options.resolveCliPackageSpec === undefined
          ? {}
          : { resolveCliPackageSpec: options.resolveCliPackageSpec }),
        ...(options.resolveCliRunner === undefined
          ? {}
          : { resolveCliRunner: options.resolveCliRunner }),
      }),
    ),
  );
