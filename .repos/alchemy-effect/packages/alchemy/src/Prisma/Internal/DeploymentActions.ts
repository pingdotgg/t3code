import * as Effect from "effect/Effect";
import {
  isConflict,
  isNotFound,
  type PrismaManagementClient,
} from "../Client.ts";
import { observeDeployment } from "./DeploymentObserve.ts";

const startConflictIsIdempotent = (
  client: PrismaManagementClient,
  deploymentId: string,
  error: unknown,
) =>
  observeDeployment(client, deploymentId).pipe(
    Effect.flatMap((deployment) =>
      deployment.status === "running" || deployment.status === "provisioning"
        ? Effect.succeed(undefined)
        : Effect.fail(error),
    ),
    Effect.catchIf(isNotFound, () => Effect.fail(error)),
  );

const stopConflictIsIdempotent = (
  client: PrismaManagementClient,
  deploymentId: string,
  error: unknown,
) =>
  observeDeployment(client, deploymentId).pipe(
    Effect.flatMap((deployment) =>
      deployment.status === "stopped" || deployment.status === "stopping"
        ? Effect.void
        : Effect.fail(error),
    ),
    Effect.catchIf(isNotFound, () => Effect.fail(error)),
  );

export const startDeploymentIdempotent = (
  client: PrismaManagementClient,
  deploymentId: string,
) =>
  client
    .startDeployment(deploymentId)
    .pipe(
      Effect.catchIf(isConflict, (error) =>
        startConflictIsIdempotent(client, deploymentId, error),
      ),
    );

export const stopDeploymentIdempotent = (
  client: PrismaManagementClient,
  deploymentId: string,
) =>
  client
    .stopDeployment(deploymentId)
    .pipe(
      Effect.catchIf(isConflict, (error) =>
        stopConflictIsIdempotent(client, deploymentId, error),
      ),
    );
