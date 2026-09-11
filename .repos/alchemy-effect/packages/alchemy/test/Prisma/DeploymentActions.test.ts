import { PrismaApiError, type PrismaManagementClient } from "@/Prisma/Client";
import {
  startDeploymentIdempotent,
  stopDeploymentIdempotent,
} from "@/Prisma/Internal/DeploymentActions";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";

const conflict = (action: "start" | "stop") =>
  new PrismaApiError({
    method: "POST",
    path: `/v1/deployments/deployment-1/${action}`,
    status: 409,
    message: "state conflict",
  });

const version = (status: string) => ({
  id: "deployment-1",
  type: "deployment" as const,
  url: "https://api.prisma.test/v1/deployments/deployment-1",
  foundryVersionId: "foundry-1",
  status,
  previewDomain: null,
  createdAt: "2026-01-01T00:00:00Z",
});

describe("Prisma deployment actions", () => {
  it.effect("does not hide a start conflict for an unuploaded version", () => {
    const error = conflict("start");
    const client = {
      startDeployment: () => Effect.fail(error),
      getDeployment: () => Effect.succeed(version("new")),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const observed = yield* startDeploymentIdempotent(
        client,
        "deployment-1",
      ).pipe(Effect.flip);
      expect(observed).toBe(error);
    });
  });

  it.effect("accepts a start conflict only after observing progress", () => {
    const client = {
      startDeployment: () => Effect.fail(conflict("start")),
      getDeployment: () => Effect.succeed(version("provisioning")),
    } as unknown as PrismaManagementClient;

    return startDeploymentIdempotent(client, "deployment-1");
  });

  it.effect(
    "accepts a stop conflict while teardown is already progressing",
    () => {
      const client = {
        stopDeployment: () => Effect.fail(conflict("stop")),
        getDeployment: () => Effect.succeed(version("stopping")),
      } as unknown as PrismaManagementClient;

      return stopDeploymentIdempotent(client, "deployment-1");
    },
  );
});
