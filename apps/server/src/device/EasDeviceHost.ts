import type { LedgerEntry, RunningSession } from "./EasDeviceHost-part2.ts";
import { CATALOG, PLATFORMS, POLL_INTERVAL, PREVIEW_TIMEOUT, REAP_INTERVAL_MS, RECORD_LIFETIME_MS, RECORD_MAX_AGE_MS, START_TIMEOUT, STATUS_TTL_MS, TRANSIENT_RETRY, UNCERTAIN_CREATE_MS, decodeLedger, decodePathSegment, encodeLedger, resolveSavedExpoCredential } from "./EasDeviceHost-part2.ts";
/**
 * Cloud simulators from EAS Simulator. A device exists only while a session
 * runs, and every session bills the Expo account until it stops, so this host
 * bounds each one, stops all of them when it stops, and stops sessions a
 * previous server left behind. It never touches sessions it did not start.
 */
import {
  DeviceBootError,
  type DeviceHostSummary,
  DeviceHostUnavailableError,
  DeviceOperationError,
  type DevicePlatform,
  type EasDeviceHostConfig,
  type SettingsSecretValue,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import { releaseAgentDeviceSession } from "./AgentDeviceTarget.ts";
import * as DeviceHost from "./DeviceHost.ts";
import { findEasProjectId } from "./easProjectId.ts";
import { type ExpoApi, makeExpoApi, resolveExpoCredential } from "./ExpoApi.ts";

import { makeEasDeviceHostShape } from "./EasDeviceHostParts.ts";

export const make = Effect.fn("EasDeviceHost.make")(function* (config: EasDeviceHostConfig) {
  return DeviceHost.DeviceHost.of(yield* makeEasDeviceHostShape(config));
});
export * from "./EasDeviceHost-part2.ts";
export * from "./EasDeviceHostParts.ts";
