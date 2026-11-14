import {
  type DeviceActionInput,
  type DeviceCloseInput,
  type DeviceConfigureInput,
  type DeviceDetail,
  type DeviceDetailInput,
  type DeviceError,
  DeviceHostId,
  DeviceId,
  DeviceHostUnavailableError,
  DeviceNotFoundError,
  DeviceOperationError,
  type DeviceOpenInput,
  type DevicePlatform,
  DevicePlatformUnavailableError,
  type DeviceServiceState,
  type DeviceSession,
  type DeviceShutdownInput,
  type DeviceSummary,
  type DeviceEasAccount,
  DeviceEasAccountError,
  type DeviceEasAccountInput,
  type DeviceSimlockIdentity,
  DeviceSimlockIdentityError,
  type DeviceSimlockIdentityInput,
  type DeviceHostConfig,
  type EasDeviceHostConfig,
  type SimlockDeviceHostConfig,
  type SshDeviceHostConfig,
  type DeviceHostSummary,
  LOCAL_DEVICE_HOST_ID,
  LOCAL_DEVICE_HOST_LABEL,
  type ThreadId,
} from "@t3tools/contracts";
import { SshCommandError } from "@t3tools/ssh/errors";
import * as FileSystem from "effect/FileSystem";
import { resolveNodeExecutable, nodeRuntimeUnavailableMessage } from "@t3tools/shared/nodeRuntime";
import * as Path from "effect/Path";
import { ensureAgentDevice, ensureDeviceHub } from "./DeviceToolchain.ts";
import {
  agentDeviceCloseOutcome,
  bindAgentDeviceLauncher,
  ensureAgentDeviceShim,
  pruneAgentDeviceLaunchers,
} from "./AgentDeviceShim.ts";
import * as ServerConfig from "../config.ts";
import {
  agentDeviceConfigPath,
  agentDeviceSession,
  writeAgentDeviceConfig,
} from "./AgentDeviceTarget.ts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as HttpClient from "effect/http/HttpClient";

import * as ServerSettings from "../serverSettings.ts";
import { isLocalSshDeviceHost, remoteSshDeviceHosts } from "./localSshDeviceHost.ts";

import { readDeviceDetail, runDeviceAction } from "./DeviceActions.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as SecretResolverLayer from "../secrets/SecretResolver.ts";
import * as DeviceHost from "./DeviceHost.ts";
import * as SshDeviceHost from "./SshDeviceHost.ts";
import * as EasDeviceHost from "./EasDeviceHost.ts";
import * as SimlockDeviceHost from "./SimlockDeviceHost.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { makeExpoApi } from "./ExpoApi.ts";
import * as Exit from "effect/Exit";
import * as LocalDeviceHost from "./LocalDeviceHost.ts";
import { make } from "./DeviceServiceParts.ts";

export const sshProbeFailureMessage = (error: DeviceHost.DeviceHostError): string => {
  const cause = error.cause;
  if (
    !(cause instanceof SshCommandError) ||
    cause.exitCode === null ||
    cause.exitCode < 1 ||
    cause.exitCode > 254
  )
    return "Could not connect to this host over SSH.";

  // Only the known bootstrap diagnostic is safe to expose as Node guidance.
  if (
    cause.exitCode === 1 &&
    cause.stderr
      .split(/\r?\n/u)
      .some((line) => line.trim() === "Node is missing from the non-interactive SSH PATH")
  )
    return "Connected over SSH, but Node is not on this host's PATH for non-interactive SSH commands.";

  return `Connected over SSH, but the device host check failed (exit code ${cause.exitCode}).`;
};

