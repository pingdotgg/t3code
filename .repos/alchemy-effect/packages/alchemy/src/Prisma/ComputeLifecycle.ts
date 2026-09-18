import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Category from "@distilled.cloud/core/category";
import {
  type GetServicesResponse,
  deleteService,
  deleteDeployment,
  deleteProject,
  getServices,
} from "@distilled.cloud/prisma/management";
import { stopDeploymentIdempotent } from "./Internal/DeploymentActions.ts";
import { observeDeployment } from "./Internal/DeploymentObserve.ts";
import type { ObservedDeployment } from "./Internal/Observed.ts";
import { PrismaPaginationError } from "./Internal/Pagination.ts";
export { isConflict } from "./Client.ts";

/**
 * A wait exceeded its `timeoutSeconds` budget before the deployment reached
 * the requested status.
 */
export class PrismaDeploymentWaitTimeout extends Data.TaggedError(
  "PrismaDeploymentWaitTimeout",
)<{
  message: string;
}> {}

/** `waitForDeploymentStatus` was called with a non-positive timeout or poll interval. */
export class PrismaDeploymentWaitInvalidOptions extends Data.TaggedError(
  "PrismaDeploymentWaitInvalidOptions",
)<{
  message: string;
}> {}

/** The deployment reached the terminal `failed` status while being waited on. */
export class PrismaDeploymentFailed extends Data.TaggedError(
  "PrismaDeploymentFailed",
)<{
  message: string;
}> {}

export interface WaitForDeploymentStatusOptions {
  /**
   * Maximum time to wait for a deployment to reach the requested status.
   */
  timeoutSeconds?: number;
  /**
   * Poll interval used while waiting for Prisma deployment status changes.
   */
  pollIntervalMs?: number;
}

/**
 * Result returned after attempting to stop and delete a Prisma deployment.
 */
export interface DestroyDeploymentResult {
  /**
   * Prisma deployment ID that was targeted.
   */
  deploymentId: string;
  /**
   * Status observed before cleanup started, or undefined if the deployment was gone.
   */
  previousStatus: string | undefined;
  /**
   * True when Alchemy requested a stop before deletion.
   */
  stopped: boolean;
  /**
   * True when the delete call completed or the deployment vanished during cleanup.
   */
  deleted: boolean;
}

/** Result returned after deleting a Prisma App. */
export interface DestroyAppResult {
  /** Prisma App ID that was targeted. */
  appId: string;
  /** True when App deletion completed or the app was already gone. */
  appDeleted: boolean;
}

/**
 * Result returned after deleting Apps under a Prisma project.
 */
export interface DestroyProjectAppsResult {
  /**
   * Prisma project ID that was targeted.
   */
  projectId: string;
  /**
   * App IDs deleted by this cleanup pass.
   */
  deletedAppIds: string[];
  /**
   * True when the project delete call completed or the project vanished.
   */
  projectDeleted: boolean;
}

const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DELETE_CONFLICT_RETRY_ATTEMPTS = 5;

const deleteRetryDelay = (attempt: number) =>
  Effect.sleep(Duration.millis(250 * 2 ** attempt));

const ensureError = (error: unknown): Error =>
  error instanceof Error
    ? error
    : new Error("Prisma deployment lifecycle operation failed.", {
        cause: error,
      });

const deploymentDeleteFailed = (
  deploymentId: string,
  statusAtDelete: string | undefined,
  error: unknown,
) => {
  const format = (error: unknown) =>
    error instanceof Error ? error.message : String(error);
  const detail = format(error);
  const isKnownStoppedDeleteFailure =
    statusAtDelete === "stopped" && Category.hasCategory(error, "ServerError");
  return new Error(
    [
      `Failed to delete Prisma deployment '${deploymentId}' while it was in status '${statusAtDelete ?? "unknown"}'.`,
      detail,
      isKnownStoppedDeleteFailure
        ? "Stopped Prisma deployments are expected to be deletable; the Management API returned a server error."
        : undefined,
      "The deployment may need platform cleanup before the App or project can be deleted.",
      `Manual check: GET /v1/deployments/${deploymentId}; manual retry: DELETE /v1/deployments/${deploymentId}.`,
    ]
      .filter((line): line is string => line !== undefined)
      .join(" "),
    { cause: error },
  );
};

const deploymentWaitTimedOut = (
  deploymentId: string,
  targetStatus: "running" | "stopped",
  lastStatus: string | undefined,
) =>
  new PrismaDeploymentWaitTimeout({
    message: `Timed out waiting for Prisma deployment '${deploymentId}' to reach '${targetStatus}' (last status: '${lastStatus ?? "unknown"}')`,
  });

export const waitForDeploymentStatus = Effect.fn(function* (
  deploymentId: string,
  targetStatus: "running" | "stopped",
  options: WaitForDeploymentStatusOptions = {},
) {
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return yield* Effect.fail(
      new PrismaDeploymentWaitInvalidOptions({
        message: "timeoutSeconds must be a positive finite number.",
      }),
    );
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return yield* Effect.fail(
      new PrismaDeploymentWaitInvalidOptions({
        message: "pollIntervalMs must be a positive finite number.",
      }),
    );
  }
  const timeoutMs = timeoutSeconds * 1_000;
  const startedAt = yield* Effect.sync(() => Date.now());
  const deadline = startedAt + timeoutMs;
  let lastStatus: string | undefined;

  while (true) {
    const remainingBeforeObservation = yield* Effect.sync(
      () => deadline - Date.now(),
    );
    if (remainingBeforeObservation <= 0) {
      return yield* Effect.fail(
        deploymentWaitTimedOut(deploymentId, targetStatus, lastStatus),
      );
    }
    const deploymentOption = yield* observeDeployment(deploymentId).pipe(
      Effect.timeoutOption(Duration.millis(remainingBeforeObservation)),
    );
    if (Option.isNone(deploymentOption)) {
      return yield* Effect.fail(
        deploymentWaitTimedOut(deploymentId, targetStatus, lastStatus),
      );
    }
    const deployment = deploymentOption.value;
    lastStatus = deployment.status;
    if (deployment.status === targetStatus) {
      return deployment satisfies ObservedDeployment;
    }
    if (deployment.status === "failed") {
      return yield* Effect.fail(
        new PrismaDeploymentFailed({
          message: `Prisma deployment '${deploymentId}' failed`,
        }),
      );
    }

    const elapsed = yield* Effect.sync(() => Date.now() - startedAt);
    if (elapsed >= timeoutMs) {
      return yield* Effect.fail(
        deploymentWaitTimedOut(deploymentId, targetStatus, lastStatus),
      );
    }

    yield* Effect.sleep(
      Duration.millis(Math.min(intervalMs, timeoutMs - elapsed)),
    );
  }
});

/**
 * Stops a running or provisioning deployment, then deletes it.
 *
 * Uses the canonical deployment lifecycle routes. Errors include the observed
 * status and exact manual route for cleanup.
 */
export const destroyDeployment = Effect.fn(function* (
  deploymentId: string,
  options: WaitForDeploymentStatusOptions = {},
) {
  const deployment = yield* observeDeployment(deploymentId).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );
  if (!deployment) {
    return {
      deploymentId,
      previousStatus: undefined,
      stopped: false,
      // The postcondition is already satisfied. Report this consistently
      // with delete calls whose 404 is observed after cleanup starts.
      deleted: true,
    } satisfies DestroyDeploymentResult;
  }

  const previousStatus = deployment.status;
  let statusAtDelete = previousStatus;
  let stopped = false;
  if (deployment.status === "running" || deployment.status === "provisioning") {
    yield* stopDeploymentIdempotent(deploymentId).pipe(
      Effect.catchTag("NotFound", () => Effect.void),
      Effect.mapError(ensureError),
    );
    const stoppedVersion = yield* waitForDeploymentStatus(
      deploymentId,
      "stopped",
      options,
    ).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    statusAtDelete = stoppedVersion?.status ?? "stopped";
    stopped = true;
  }

  yield* deleteDeployment({ deploymentId }).pipe(
    Effect.catchTag("NotFound", () => Effect.void),
    Effect.catch((error) =>
      Effect.fail(deploymentDeleteFailed(deploymentId, statusAtDelete, error)),
    ),
  );

  return {
    deploymentId,
    previousStatus,
    stopped,
    deleted: true,
  } satisfies DestroyDeploymentResult;
});

/**
 * Deletes an App. The canonical App delete endpoint cascades its deployments.
 */
export const destroyApp = Effect.fn(function* (
  appId: string,
  options: WaitForDeploymentStatusOptions & {
    keepApp?: boolean;
  } = {},
) {
  let appDeleted = false;
  if (!options.keepApp) {
    for (let attempt = 0; attempt < DELETE_CONFLICT_RETRY_ATTEMPTS; attempt++) {
      const deleted = yield* deleteService({ serviceId: appId }).pipe(
        Effect.as(true),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
        Effect.catchTag("Conflict", (error) =>
          attempt + 1 < DELETE_CONFLICT_RETRY_ATTEMPTS
            ? deleteRetryDelay(attempt).pipe(Effect.as(false))
            : Effect.fail(error),
        ),
      );
      if (deleted) {
        appDeleted = true;
        break;
      }
    }
  }

  return {
    appId,
    appDeleted,
  } satisfies DestroyAppResult;
});

/**
 * Deletes every App under a project, then deletes the project.
 *
 * Callers can start from the project ID and let Alchemy discover the App IDs.
 */
export const destroyProjectApps = Effect.fn(function* (
  projectId: string,
  options: WaitForDeploymentStatusOptions & {
    keepProject?: boolean;
    keepApp?: boolean;
  } = {},
) {
  const deletedAppIds = new Set<string>();

  const cleanupApps = Effect.fn(function* () {
    // Distilled emits the cursor-paginated list operations as plain ops, so
    // callers walk `pagination` themselves (see `src/Neon/Project.ts`). A 404
    // from the project-filtered listing means the project is already gone.
    const apps = yield* Effect.gen(function* () {
      const items: GetServicesResponse["data"][number][] = [];
      let cursor: string | undefined;
      while (true) {
        const page = yield* getServices(
          cursor === undefined
            ? { projectId, limit: 100 }
            : { projectId, limit: 100, cursor },
        );
        items.push(...page.data);
        const nextCursor = page.pagination.nextCursor;
        if (!page.pagination.hasMore) break;
        if (nextCursor === null) {
          return yield* Effect.fail(
            new PrismaPaginationError({
              message:
                "Invalid Prisma Management API pagination response from getServices: hasMore was true without a non-empty nextCursor",
            }),
          );
        }
        cursor = nextCursor;
      }
      return items;
    }).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    if (!apps) return false;
    for (const app of apps) {
      const result = yield* destroyApp(app.id, options);
      if (result.appDeleted) deletedAppIds.add(app.id);
    }
    return true;
  });

  yield* cleanupApps();

  let projectDeleted = false;
  if (!options.keepProject) {
    for (let attempt = 0; attempt < DELETE_CONFLICT_RETRY_ATTEMPTS; attempt++) {
      // A 409, or the API's 400 on a still-populated project, means the
      // delete is blocked on remaining member resources: re-clean and retry.
      const deleted = yield* deleteProject({ id: projectId }).pipe(
        Effect.as(true),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
        Effect.catchTag("Conflict", (error) =>
          Effect.gen(function* () {
            if (attempt + 1 >= DELETE_CONFLICT_RETRY_ATTEMPTS) {
              return yield* Effect.fail(error);
            }
            yield* cleanupApps();
            yield* deleteRetryDelay(attempt);
            return false;
          }),
        ),
        Effect.catchTag("BadRequest", (error) =>
          Effect.gen(function* () {
            if (attempt + 1 >= DELETE_CONFLICT_RETRY_ATTEMPTS) {
              return yield* Effect.fail(error);
            }
            yield* cleanupApps();
            yield* deleteRetryDelay(attempt);
            return false;
          }),
        ),
      );
      if (deleted) {
        projectDeleted = true;
        break;
      }
    }
  }

  return {
    projectId,
    deletedAppIds: Array.from(deletedAppIds),
    projectDeleted,
  } satisfies DestroyProjectAppsResult;
});

export const toDeploymentUrl = (domain: string | null | undefined) =>
  domain
    ? domain.startsWith("http://") || domain.startsWith("https://")
      ? domain
      : `https://${domain}`
    : undefined;
