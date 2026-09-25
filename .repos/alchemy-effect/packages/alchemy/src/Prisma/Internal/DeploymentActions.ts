import * as Effect from "effect/Effect";
import type { Conflict } from "@distilled.cloud/prisma";
import {
  createDeploymentStart,
  createDeploymentStop,
} from "@distilled.cloud/prisma/management";
import { observeDeployment } from "./DeploymentObserve.ts";

const startConflictIsIdempotent = (deploymentId: string, error: Conflict) =>
  observeDeployment(deploymentId).pipe(
    Effect.flatMap((deployment) =>
      deployment.status === "running" || deployment.status === "provisioning"
        ? Effect.succeed(undefined)
        : Effect.fail(error),
    ),
    Effect.catchTag("NotFound", () => Effect.fail(error)),
  );

const stopConflictIsIdempotent = (deploymentId: string, error: Conflict) =>
  observeDeployment(deploymentId).pipe(
    Effect.flatMap((deployment) =>
      deployment.status === "stopped" || deployment.status === "stopping"
        ? Effect.void
        : Effect.fail(error),
    ),
    Effect.catchTag("NotFound", () => Effect.fail(error)),
  );

export const startDeploymentIdempotent = (deploymentId: string) =>
  createDeploymentStart({ deploymentId }).pipe(
    Effect.map((response) => response.data),
    Effect.catchTag("Conflict", (error) =>
      startConflictIsIdempotent(deploymentId, error),
    ),
  );

export const stopDeploymentIdempotent = (deploymentId: string) =>
  createDeploymentStop({ deploymentId }).pipe(
    Effect.asVoid,
    Effect.catchTag("Conflict", (error) =>
      stopConflictIsIdempotent(deploymentId, error),
    ),
  );
