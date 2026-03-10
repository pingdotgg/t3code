import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { DaytonaClient, type CreateDaytonaClientError } from "../../client";
import {
  VolumeDeleteError,
  VolumeEnsureError,
  VolumeListError,
  VolumeNotReadyError,
  VolumeLookupError,
} from "./volume.errors";
import { type DaytonaVolume, VolumeService, type VolumeServiceShape } from "./volume.service";

interface VolumeClient {
  readonly volume: {
    readonly list: () => Promise<ReadonlyArray<DaytonaVolume>>;
    readonly get: (name: string, create?: boolean) => Promise<DaytonaVolume>;
    readonly delete: (volume: DaytonaVolume) => Promise<void>;
  };
}

export interface VolumeServiceOptions {
  readonly client: VolumeClient;
  readonly readyPollIntervalMs?: number;
  readonly readyPollAttempts?: number;
}

function normalizeVolumeName(name: string): string {
  return name.trim();
}

function getVolumeByName(
  client: VolumeClient,
  name: string,
): Effect.Effect<DaytonaVolume, VolumeLookupError> {
  const volumeName = normalizeVolumeName(name);

  return Effect.tryPromise({
    try: () => client.volume.get(volumeName),
    catch: (cause) =>
      new VolumeLookupError({
        message: `Failed to find Daytona volume "${volumeName}".`,
        volumeName,
        cause,
      }),
  });
}

function waitForReadyVolume(
  client: VolumeClient,
  name: string,
  attemptsLeft: number,
  pollIntervalMs: number,
): Effect.Effect<DaytonaVolume, VolumeLookupError | VolumeNotReadyError> {
  return Effect.gen(function* () {
    const volume = yield* getVolumeByName(client, name);

    if (volume.state === "ready") {
      return volume;
    }

    if (volume.state === "error") {
      return yield* Effect.fail(
        new VolumeNotReadyError({
          message: `Daytona volume "${name}" entered the error state.`,
          volumeName: name,
          currentState: volume.state,
          cause: volume.errorReason ?? undefined,
        }),
      );
    }

    if (attemptsLeft <= 1) {
      return yield* Effect.fail(
        new VolumeNotReadyError({
          message: `Timed out waiting for Daytona volume "${name}" to become ready. Current state: ${volume.state}.`,
          volumeName: name,
          currentState: volume.state,
        }),
      );
    }

    yield* Effect.sleep(`${pollIntervalMs} millis`);
    return yield* waitForReadyVolume(client, name, attemptsLeft - 1, pollIntervalMs);
  });
}

export function makeVolumeService(options: VolumeServiceOptions): VolumeServiceShape {
  const readyPollIntervalMs = options.readyPollIntervalMs ?? 1000;
  const readyPollAttempts = options.readyPollAttempts ?? 120;

  return {
    listVolumes() {
      return Effect.tryPromise({
        try: () => options.client.volume.list(),
        catch: (cause) =>
          new VolumeListError({
            message: "Failed to list Daytona volumes.",
            cause,
          }),
      });
    },
    getVolume(name) {
      return getVolumeByName(options.client, name);
    },
    ensureVolume(name) {
      const volumeName = normalizeVolumeName(name);

      // Daytona can return a newly-created volume while it is still
      // `pending_create`. Mounting it into a sandbox before it reaches `ready`
      // fails at sandbox creation time.
      return Effect.tryPromise({
        try: () => options.client.volume.get(volumeName, true),
        catch: (cause) =>
          new VolumeEnsureError({
            message: `Failed to create or fetch Daytona volume "${volumeName}".`,
            volumeName,
            cause,
          }),
      }).pipe(
        Effect.flatMap(() =>
          waitForReadyVolume(options.client, volumeName, readyPollAttempts, readyPollIntervalMs),
        ),
      );
    },
    deleteVolume(name) {
      const volumeName = normalizeVolumeName(name);

      return Effect.gen(function* () {
        const volume = yield* getVolumeByName(options.client, volumeName);

        return yield* Effect.tryPromise({
          try: () => options.client.volume.delete(volume),
          catch: (cause) =>
            new VolumeDeleteError({
              message: `Failed to delete Daytona volume "${volumeName}".`,
              volumeName,
              cause,
            }),
        });
      });
    },
  } satisfies VolumeServiceShape;
}

export function makeVolumeServiceLayer(): Layer.Layer<
  VolumeService,
  CreateDaytonaClientError,
  DaytonaClient
> {
  return Layer.effect(
    VolumeService,
    Effect.gen(function* () {
      const daytonaClient = yield* DaytonaClient;
      return makeVolumeService({
        client: daytonaClient.client,
      });
    }),
  );
}

export const VolumeServiceLive = makeVolumeServiceLayer;
