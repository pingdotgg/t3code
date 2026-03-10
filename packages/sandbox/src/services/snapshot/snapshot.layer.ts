import type { Daytona } from "@daytonaio/sdk";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { DaytonaClient, type CreateDaytonaClientError } from "../../client";
import {
  SnapshotActivationError,
  SnapshotCreationError,
  SnapshotDeletionError,
  SnapshotListError,
} from "./snapshot.errors";
import { JEVIN_AI_SNAPSHOT_NAME, createJevinAiSnapshotImage } from "./snapshot.image";
import type {
  DaytonaSnapshot,
  EnsureSnapshotOptions,
  SnapshotServiceShape,
} from "./snapshot.service";
import { SnapshotService } from "./snapshot.service";

function formatSnapshotPermissionHint(cause: unknown): string {
  if (cause instanceof Error && cause.message.includes("Forbidden resource")) {
    return " Daytona denied snapshot access. Make sure the API key includes the `write:snapshots` scope.";
  }

  return "";
}

function findSnapshotByName(
  client: Daytona,
  name: string,
): Effect.Effect<DaytonaSnapshot | undefined, SnapshotListError> {
  return Effect.tryPromise({
    try: () => client.snapshot.list(1, 200),
    catch: (cause) =>
      new SnapshotListError({
        message: `Failed to list Daytona snapshots while looking for "${name}".`,
        cause,
      }),
  }).pipe(Effect.map((result) => result.items.find((snapshot) => snapshot.name === name)));
}

function activateSnapshot(
  client: Daytona,
  snapshot: DaytonaSnapshot,
): Effect.Effect<DaytonaSnapshot, SnapshotActivationError> {
  return Effect.tryPromise({
    try: () => client.snapshot.activate(snapshot),
    catch: (cause) => cause,
  }).pipe(
    Effect.catchIf(
      (cause): cause is Error => cause instanceof Error && cause.message.includes("already active"),
      () => Effect.succeed(snapshot),
    ),
    Effect.mapError(
      (cause) =>
        new SnapshotActivationError({
          message: `Failed to activate Daytona snapshot "${snapshot.name}".`,
          snapshotName: snapshot.name,
          cause,
        }),
    ),
  );
}

function deleteSnapshot(
  client: Daytona,
  snapshot: DaytonaSnapshot,
): Effect.Effect<void, SnapshotDeletionError> {
  return Effect.tryPromise({
    try: () => client.snapshot.delete(snapshot),
    catch: (cause) =>
      new SnapshotDeletionError({
        message: `Failed to delete Daytona snapshot "${snapshot.name}".`,
        snapshotName: snapshot.name,
        cause,
      }),
  });
}

function waitForSnapshotDeletion(
  client: Daytona,
  snapshotName: string,
  attemptsLeft = 15,
): Effect.Effect<void, SnapshotListError> {
  return Effect.gen(function* () {
    const snapshot = yield* findSnapshotByName(client, snapshotName);

    if (!snapshot) {
      return;
    }

    if (attemptsLeft <= 1) {
      return yield* Effect.fail(
        new SnapshotListError({
          message: `Timed out waiting for Daytona snapshot "${snapshotName}" to be deleted.`,
          cause: undefined,
        }),
      );
    }

    yield* Effect.sleep("1 second");
    yield* waitForSnapshotDeletion(client, snapshotName, attemptsLeft - 1);
  });
}

function createSnapshot(
  client: Daytona,
  options: Required<Pick<EnsureSnapshotOptions, "name" | "activate">> &
    Pick<EnsureSnapshotOptions, "onLogs" | "timeoutSeconds">,
): Effect.Effect<DaytonaSnapshot, SnapshotActivationError | SnapshotCreationError> {
  return Effect.tryPromise({
    try: () =>
      client.snapshot.create(
        {
          name: options.name,
          image: createJevinAiSnapshotImage(),
        },
        {
          ...(options.onLogs ? { onLogs: options.onLogs } : {}),
          ...(typeof options.timeoutSeconds === "number"
            ? { timeout: options.timeoutSeconds }
            : {}),
        },
      ),
    catch: (cause) =>
      new SnapshotCreationError({
        message: `Failed to create Daytona snapshot "${options.name}".${formatSnapshotPermissionHint(cause)}`,
        snapshotName: options.name,
        cause,
      }),
  }).pipe(
    Effect.flatMap((snapshot) =>
      options.activate ? activateSnapshot(client, snapshot) : Effect.succeed(snapshot),
    ),
  );
}

function makeSnapshotService(client: Daytona): SnapshotServiceShape {
  return {
    ensureSnapshot(options: EnsureSnapshotOptions = {}) {
      const snapshotName = options.name ?? JEVIN_AI_SNAPSHOT_NAME;
      const shouldReplace = options.replace ?? false;
      const shouldActivate = options.activate ?? true;

      return Effect.gen(function* () {
        const existingSnapshot = yield* findSnapshotByName(client, snapshotName);

        if (existingSnapshot && !shouldReplace) {
          if (shouldActivate) {
            return yield* activateSnapshot(client, existingSnapshot);
          }

          return existingSnapshot;
        }

        if (existingSnapshot) {
          yield* deleteSnapshot(client, existingSnapshot);
          yield* waitForSnapshotDeletion(client, snapshotName);
        }

        return yield* createSnapshot(client, {
          name: snapshotName,
          activate: shouldActivate,
          onLogs: options.onLogs,
          timeoutSeconds: options.timeoutSeconds,
        });
      });
    },
  } satisfies SnapshotServiceShape;
}

export function makeSnapshotServiceLayer(): Layer.Layer<
  SnapshotService,
  CreateDaytonaClientError,
  DaytonaClient
> {
  return Layer.effect(
    SnapshotService,
    Effect.gen(function* () {
      const daytonaClient = yield* DaytonaClient;
      return makeSnapshotService(daytonaClient.client);
    }),
  );
}

export const SnapshotServiceLive = makeSnapshotServiceLayer;
