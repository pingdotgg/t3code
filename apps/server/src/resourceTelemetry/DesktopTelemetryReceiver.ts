// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";

import * as NodeStream from "@effect/platform-node/NodeStream";
import {
  DesktopHostTelemetryMessage,
  type DesktopHostTelemetryMessage as DesktopHostTelemetryMessageValue,
  type DesktopHostTelemetrySnapshot,
  type DesktopShellEnvironmentSnapshot,
  DesktopTelemetryControlMessage,
  type DesktopUpdateChannel,
  type DesktopUpdateStatusReport,
  type ResourceTelemetrySourceStatus,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { applyShellEnvironment } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/encoding/Ndjson";

import { eventVersion as messageVersion } from "./NativeTelemetryClient.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { subscribeBeforeSnapshotWithoutMutex } from "../utils/subscribeBeforeSnapshot.ts";
import { make } from "./DesktopTelemetryReceiverParts.ts";

export const INITIAL_SAMPLE_DEADLINE_MS = 90_000;
const MIN_SNAPSHOT_STALE_AFTER_MS = 90_000;
const STALE_GRACE_MS = 30_000;
export const DEFAULT_HOST_POWER_ACTIVE_INTERVAL_MS = 30_000;
export const DEFAULT_HOST_POWER_IDLE_INTERVAL_MS = 120_000;
export const STALE_CHECK_INTERVAL = Duration.seconds(30);

export class DesktopTelemetryDescriptorUnavailable extends Schema.TaggedError<DesktopTelemetryDescriptorUnavailable>()(
  "DesktopTelemetryDescriptorUnavailable",
  {
    mode: Schema.String,
  },
) {
  override get message(): string {
    return `Desktop telemetry descriptor is unavailable in '${this.mode}' mode.`;
  }
}

export class DesktopTelemetryProtocolMismatch extends Schema.TaggedError<DesktopTelemetryProtocolMismatch>()(
  "DesktopTelemetryProtocolMismatch",
  {
    expectedVersion: Schema.Number,
    receivedVersion: Schema.Number,
  },
) {
  override get message(): string {
    return `Desktop telemetry protocol ${this.receivedVersion} is incompatible with expected protocol ${this.expectedVersion}.`;
  }
}

export class DesktopTelemetryDecodeFailed extends Schema.TaggedError<DesktopTelemetryDecodeFailed>()(
  "DesktopTelemetryDecodeFailed",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to decode desktop telemetry.";
  }
}

export class DesktopTelemetryStreamFailed extends Schema.TaggedError<DesktopTelemetryStreamFailed>()(
  "DesktopTelemetryStreamFailed",
  {
    fd: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop telemetry stream on fd ${this.fd} failed.`;
  }
}

export class DesktopTelemetryStreamClosed extends Schema.TaggedError<DesktopTelemetryStreamClosed>()(
  "DesktopTelemetryStreamClosed",
  {
    fd: Schema.Number,
  },
) {
  override get message(): string {
    return `Desktop telemetry stream on fd ${this.fd} closed.`;
  }
}

export class DesktopTelemetryStale extends Schema.TaggedError<DesktopTelemetryStale>()(
  "DesktopTelemetryStale",
  {
    fd: Schema.Number,
    staleAfterMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Desktop telemetry on fd ${this.fd} has not updated for ${this.staleAfterMs}ms.`;
  }
}

export type DesktopTelemetryReceiverError =
  | DesktopTelemetryDescriptorUnavailable
  | DesktopTelemetryProtocolMismatch
  | DesktopTelemetryDecodeFailed
  | DesktopTelemetryStreamFailed
  | DesktopTelemetryStreamClosed;

export class DesktopTelemetryControlFailed extends Schema.TaggedError<DesktopTelemetryControlFailed>()(
  "DesktopTelemetryControlFailed",
  {
    fd: Schema.Number,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop telemetry control '${this.operation}' failed on fd ${this.fd}.`;
  }
}

export class DesktopTelemetryControlStalled extends Schema.TaggedError<DesktopTelemetryControlStalled>()(
  "DesktopTelemetryControlStalled",
  {
    fd: Schema.Number,
    remainingBytes: Schema.Number,
  },
) {
  override get message(): string {
    return `Desktop telemetry control stalled on fd ${this.fd} with ${this.remainingBytes} bytes remaining.`;
  }
}

export type DesktopTelemetryControlError =
  | DesktopTelemetryControlFailed
  | DesktopTelemetryControlStalled;

export interface DesktopTelemetryReceiverHealth {
  readonly status: ResourceTelemetrySourceStatus;
  readonly lastSampleAt: Option.Option<DateTime.Utc>;
  readonly lastError: Option.Option<string>;
}

/** Moves the desktop app to `channel` and installs only `targetVersion`. */
export interface DesktopTrackSwitch {
  readonly channel: DesktopUpdateChannel;
  readonly targetVersion: string;
}

export class DesktopTelemetryReceiver extends Context.Service<
  DesktopTelemetryReceiver,
  {
    readonly latest: Effect.Effect<Option.Option<DesktopHostTelemetrySnapshot>>;
    readonly changes: Stream.Stream<DesktopHostTelemetrySnapshot>;
    readonly subscribe: Effect.Effect<
      {
        readonly latest: Option.Option<DesktopHostTelemetrySnapshot>;
        readonly changes: Stream.Stream<DesktopHostTelemetrySnapshot>;
      },
      never,
      Scope.Scope
    >;
    readonly health: Effect.Effect<DesktopTelemetryReceiverHealth>;
    readonly subscribeHealth: Effect.Effect<
      {
        readonly latest: DesktopTelemetryReceiverHealth;
        readonly changes: Stream.Stream<DesktopTelemetryReceiverHealth>;
      },
      never,
      Scope.Scope
    >;
    readonly setDiagnosticsDemand: (
      enabled: boolean,
    ) => Effect.Effect<void, DesktopTelemetryControlError>;
    readonly requestDesktopUpdate: (
      requestId: string,
      trackSwitch?: DesktopTrackSwitch,
    ) => Effect.Effect<void, DesktopTelemetryControlError>;
    readonly commitDesktopUpdate: (
      requestId: string,
    ) => Effect.Effect<void, DesktopTelemetryControlError>;
    readonly cancelDesktopUpdate: (
      requestId: string,
    ) => Effect.Effect<void, DesktopTelemetryControlError>;
    readonly desktopUpdates: Effect.Effect<
      {
        readonly latest: Option.Option<DesktopUpdateStatusReport>;
        readonly changes: Stream.Stream<DesktopUpdateStatusReport>;
      },
      never,
      Scope.Scope
    >;
  }
>()("t3/resourceTelemetry/DesktopTelemetryReceiver") {}

class DesktopShellCertificatesUpdateFailed extends Schema.TaggedError<DesktopShellCertificatesUpdateFailed>()(
  "DesktopShellCertificatesUpdateFailed",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to update desktop shell TLS certificates.";
  }
}

export function makeApplyDesktopShellEnvironmentSnapshot(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
) {
  let baseCertificates: Array<string> | undefined;
  return Effect.fn("resourceTelemetry.desktopTelemetryReceiver.applyShellEnvironment")(function* (
    message: DesktopShellEnvironmentSnapshot,
  ) {
    if (message.platform !== platform) return;
    // Node's first default-CA enumeration consults process.env, so capture it before the patch.
    if (message.environment.NODE_EXTRA_CA_CERTS !== undefined && baseCertificates === undefined) {
      // Remove only the startup extras, preserving duplicates from bundled or system trust.
      const extras = [...NodeTls.getCACertificates("extra")];
      baseCertificates = NodeTls.getCACertificates("default").filter((certificate) => {
        const index = extras.indexOf(certificate);
        if (index === -1) return true;
        extras.splice(index, 1);
        return false;
      });
    }
    applyShellEnvironment(environment, message.environment, platform);
    if (message.environment.NODE_EXTRA_CA_CERTS !== undefined) {
      yield* Effect.gen(function* () {
        const certificates = baseCertificates;
        // --use-openssl-ca roots are not enumerable; replacing the list would discard them.
        if (certificates === undefined || certificates.length === 0) {
          yield* Effect.logWarning(
            "Preserving non-enumerable TLS trust. Restart to apply updated desktop shell certificates.",
          );
          return;
        }
        const fs = yield* FileSystem.FileSystem;
        const file = message.environment.NODE_EXTRA_CA_CERTS;
        const bundle = file ? yield* fs.readFileString(file) : undefined;
        yield* Effect.try({
          try: () => {
            const extras =
              bundle?.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
            if (bundle?.trim() && extras.length === 0) {
              throw new Error("No PEM certificates found.");
            }
            NodeTls.setDefaultCACertificates([...certificates, ...extras]);
          },
          catch: (cause) => new DesktopShellCertificatesUpdateFailed({ cause }),
        });
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to update desktop shell TLS certificates.", Cause.fail(cause)),
        ),
      );
    }
    if (message.discovered) delete environment.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING;
  });
}

export const decodeMessage = Schema.decodeUnknownEffect(DesktopHostTelemetryMessage);
export const encodeControlMessage = Schema.encodeEffect(
  Schema.fromJsonString(DesktopTelemetryControlMessage),
);
const isDescriptorUnavailable = Schema.is(DesktopTelemetryDescriptorUnavailable);
const isProtocolMismatch = Schema.is(DesktopTelemetryProtocolMismatch);
const isDecodeFailed = Schema.is(DesktopTelemetryDecodeFailed);
const isStreamFailed = Schema.is(DesktopTelemetryStreamFailed);

export function isDesktopTelemetryContactStale(
  lastContactAtMs: Option.Option<number>,
  nowMs: number,
): boolean {
  return Option.exists(
    lastContactAtMs,
    (lastContact) => nowMs - lastContact >= INITIAL_SAMPLE_DEADLINE_MS,
  );
}

export function resolveDesktopTelemetrySnapshotStaleAfterMs(
  activeIntervalMs: number,
  idleIntervalMs: number,
): number {
  return Math.max(
    MIN_SNAPSHOT_STALE_AFTER_MS,
    Math.max(activeIntervalMs, idleIntervalMs) + STALE_GRACE_MS,
  );
}

export function initialDesktopTelemetryContactAt(
  desktopTelemetryFd: number | undefined,
  nowMs: number,
): Option.Option<number> {
  return desktopTelemetryFd === undefined ? Option.none() : Option.some(nowMs);
}

export const recordDesktopTelemetrySampleHealth = Effect.fn(
  "resourceTelemetry.desktopTelemetryReceiver.recordSampleHealth",
)(function* (
  health: Ref.Ref<DesktopTelemetryReceiverHealth>,
  healthChanges: PubSub.PubSub<DesktopTelemetryReceiverHealth>,
  sampledAt: DateTime.Utc,
) {
  const next: DesktopTelemetryReceiverHealth = {
    status: "healthy",
    lastSampleAt: Option.some(sampledAt),
    lastError: Option.none(),
  };
  yield* Ref.set(health, next);
  yield* PubSub.publish(healthChanges, next);
});

export function normalizeReceiverError(error: unknown): DesktopTelemetryReceiverError {
  if (
    isDescriptorUnavailable(error) ||
    isProtocolMismatch(error) ||
    isDecodeFailed(error) ||
    isStreamFailed(error)
  ) {
    return error;
  }
  return new DesktopTelemetryDecodeFailed({ cause: error });
}

export const writeAllToFileDescriptor = Effect.fn(
  "resourceTelemetry.desktopTelemetryReceiver.writeAllToFileDescriptor",
)(function* (fd: number, payload: Buffer) {
  let offset = 0;
  while (offset < payload.byteLength) {
    const written = yield* Effect.callback<number, DesktopTelemetryControlFailed>(
      (resume, signal) => {
        if (signal.aborted) return;
        try {
          NodeFS.write(
            fd,
            payload,
            offset,
            payload.byteLength - offset,
            null,
            (error, bytesWritten) => {
              if (error) {
                resume(
                  Effect.fail(
                    new DesktopTelemetryControlFailed({
                      fd,
                      operation: "write",
                      cause: error,
                    }),
                  ),
                );
                return;
              }
              resume(Effect.succeed(bytesWritten));
            },
          );
        } catch (cause) {
          resume(
            Effect.fail(
              new DesktopTelemetryControlFailed({
                fd,
                operation: "write",
                cause,
              }),
            ),
          );
        }
      },
    );
    yield* requireDesktopTelemetryWriteProgress(fd, payload.byteLength - offset, written);
    offset += written;
  }
});

export function requireDesktopTelemetryWriteProgress(
  fd: number,
  remainingBytes: number,
  written: number,
): Effect.Effect<void, DesktopTelemetryControlStalled> {
  return written > 0
    ? Effect.void
    : Effect.fail(new DesktopTelemetryControlStalled({ fd, remainingBytes }));
}

/** @public */
export const layer = Layer.effect(DesktopTelemetryReceiver, make());

export const layerTest = (
  overrides: Partial<DesktopTelemetryReceiver["Service"]> = {},
): Layer.Layer<DesktopTelemetryReceiver> => {
  const latest = overrides.latest ?? Effect.succeedNone;
  const changes = overrides.changes ?? Stream.empty;
  const health =
    overrides.health ??
    Effect.succeed({
      status: "unavailable" as const,
      lastSampleAt: Option.none<DateTime.Utc>(),
      lastError: Option.some("Desktop telemetry test implementation is unavailable."),
    });
  return Layer.succeed(
    DesktopTelemetryReceiver,
    DesktopTelemetryReceiver.of({
      latest,
      changes,
      subscribe:
        overrides.subscribe ??
        latest.pipe(
          Effect.map((initial) => ({
            latest: initial,
            changes,
          })),
        ),
      health,
      subscribeHealth:
        overrides.subscribeHealth ??
        health.pipe(
          Effect.map((initial) => ({
            latest: initial,
            changes: Stream.empty,
          })),
        ),
      setDiagnosticsDemand: Effect.fn("DesktopTelemetryReceiver.setDiagnosticsDemand")(function () {
        return Effect.void;
      }),
      requestDesktopUpdate: Effect.fn("DesktopTelemetryReceiver.requestDesktopUpdate")(function () {
        return Effect.void;
      }),
      commitDesktopUpdate: Effect.fn("DesktopTelemetryReceiver.commitDesktopUpdate")(function () {
        return Effect.void;
      }),
      cancelDesktopUpdate: Effect.fn("DesktopTelemetryReceiver.cancelDesktopUpdate")(function () {
        return Effect.void;
      }),
      desktopUpdates:
        overrides.desktopUpdates ??
        Effect.succeed({
          latest: Option.none<DesktopUpdateStatusReport>(),
          changes: Stream.empty,
        }),
      ...overrides,
    }),
  );
};
export * from "./DesktopTelemetryReceiverParts.ts";
