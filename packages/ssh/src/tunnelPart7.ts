export {
  SshInvalidArchiveVersionError,
  SshMissingRunnerError,
  buildRemoteNodeEnvScript,
  buildRemoteT3RunnerScript,
} from "./tunnelPart4.ts";
export {
  issueRemotePairingToken,
  launchOrReuseRemoteServer,
  resolveLoopbackSshHttpBaseUrl,
} from "./tunnelPart5.ts";
import * as NetService from "@t3tools/shared/Net";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as SshAuth from "./auth.ts";
import {
  SshCommandError,
  SshInvalidTargetError,
  SshLaunchError,
  SshPairingError,
  SshPasswordPromptError,
  SshReadinessError,
} from "./errors.ts";

export interface RemoteT3RunnerOptions {
  readonly nodeScriptPath?: string | null;
  readonly nodeEngineRange?: string | null;
  readonly archiveVersion?: string | null;
  readonly releaseBaseUrl?: string | null;
}

export interface SshEnvironmentManagerOptions {
  readonly resolveCliRunner?: Effect.Effect<RemoteT3RunnerOptions>;
}

export type SshEnvironmentEffectContext =
  | ChildProcessSpawner.ChildProcessSpawner
  | Digest.Digest
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService
  | SshAuth.SshPasswordPrompt;

export type SshEnvironmentEffectError =
  | SshCommandError
  | SshInvalidTargetError
  | SshLaunchError
  | SshPairingError
  | SshReadinessError
  | SshPasswordPromptError
  | NetService.NetError;
