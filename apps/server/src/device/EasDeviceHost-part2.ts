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

export const POLL_INTERVAL = Duration.seconds(5);
// How stale a running session's status may get before listing rechecks it.
export const STATUS_TTL_MS = 15_000;
// Expo's own CLI waits this long once a worker picks the session up.
export const START_TIMEOUT = Duration.minutes(15);
export const PREVIEW_TIMEOUT = Duration.seconds(20);
export const decodeServeSimApi = Schema.decodeUnknownEffect(
  Schema.Struct({ device: Schema.NonEmptyString }),
);
export const decodeServeEmuApi = Schema.decodeUnknownEffect(
  Schema.Struct({ serial: Schema.NonEmptyString }),
);
/**
 * Each session's preview host serves serve-sim at its root and serve-emu under
 * its vendor prefix, and names its device by an id of its own that agent-device
 * also selects it by.
 */
export const PLATFORMS = {
  ios: {
    name: "iPhone (EAS Simulator)",
    hubPrefix: "/vendor/serve-sim",
    previewPrefix: "",
    protocol: "serve-sim",
    remoteDeviceId: (api: unknown) => decodeServeSimApi(api).pipe(Effect.map((api) => api.device)),
  },
  android: {
    name: "Android (EAS Simulator)",
    hubPrefix: "/vendor/serve-emu",
    previewPrefix: "/vendor/serve-emu",
    protocol: "serve-emu",
    remoteDeviceId: (api: unknown) => decodeServeEmuApi(api).pipe(Effect.map((api) => api.serial)),
  },
} as const;

/** EAS picks the simulator model; one entry starts a session. */
export const CATALOG: ReadonlyArray<DeviceHost.HostDevice> = [
  {
    id: "eas-ios",
    platform: "ios",
    name: PLATFORMS.ios.name,
    version: "Cloud",
    booted: false,
    physical: false,
  },
  {
    id: "eas-android",
    platform: "android",
    name: PLATFORMS.android.name,
    version: "Cloud",
    booted: false,
    physical: false,
  },
];

export interface RunningSession {
  readonly sessionId: string;
  readonly name: string;
  readonly platform: DevicePlatform;
  readonly remoteDeviceId: string;
  readonly preview: { readonly origin: string; readonly token: Redacted.Redacted<string> };
  readonly agent: DeviceHost.AgentDaemonEndpoint;
  /** Set once a stop has been asked for but Expo has not confirmed it. */
  stopping: boolean;
}

/**
 * Every session this host may have started, recorded by its unique name before
 * Expo is asked to create it, so a server that crashes at any point can still
 * find and stop the session on its next start.
 */
export const LedgerEntry = Schema.Struct({
  name: Schema.String,
  appId: Schema.String,
  recordedAt: Schema.Number,
  /** Expo refused the create: nothing should run, but the reaper still looks. */
  refused: Schema.optional(Schema.Boolean),
});
export type LedgerEntry = typeof LedgerEntry.Type;
export const Ledger = Schema.fromJsonString(Schema.Array(LedgerEntry));
export const decodeLedger = Schema.decodeUnknownEffect(Ledger);
export const encodeLedger = Schema.encodeSync(Ledger);
// How often listing looks for recorded sessions this host no longer tracks.
export const REAP_INTERVAL_MS = 60_000;
// Expo's ready queue is unbounded despite its 115-minute session limit and five-minute cleanup.
// Unlisted sessions stop counting after this lifetime; forget their records only once
// confirmed not running or after a day unconfirmed.
export const RECORD_LIFETIME_MS = 180 * 60_000;
export const RECORD_MAX_AGE_MS = 24 * 60 * 60_000;
// Expo lists a session it made within seconds; a create with an unknown
// outcome stops counting against the limit once it has had this long.
export const UNCERTAIN_CREATE_MS = 5 * 60_000;
// One failed request to Expo during a minutes-long start does not end the start.
export const TRANSIENT_RETRY = { times: 3, schedule: Schedule.spaced("2 seconds") } as const;

/** A malformed escape names no device, so the proxy answers 404 instead of failing. */
export const decodePathSegment = (segment: string): string | null => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

/**
 * The Expo credential a host's setting holds or names. Every session bills the account behind
 * it, so a named secret that cannot be read fails rather than falling back to another login.
 */
export const resolveSavedExpoCredential = (
  secrets: SecretResolver.SecretResolver["Service"],
  saved: SettingsSecretValue,
) => requireSettingsSecret(secrets, saved).pipe(Effect.flatMap(resolveExpoCredential));

