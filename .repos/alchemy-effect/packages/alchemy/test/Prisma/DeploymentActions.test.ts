import { PrismaApiError, type PrismaManagementClient } from "@/Prisma/Client";
import {
  startDeploymentIdempotent,
  stopDeploymentIdempotent,
} from "@/Prisma/Internal/DeploymentActions";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  type Captured,
  dispatchTo,
  makeFakeManagementApi,
  unhandled,
} from "./fixtures/FakeManagementApi.ts";

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
  serviceId: "service-1",
  url: "https://api.prisma.test/v1/deployments/deployment-1",
  foundryVersionId: "foundry-1",
  status,
  previewDomain: null,
  createdAt: "2026-01-01T00:00:00Z",
});

/**
 * Serve the Management API from the same hermetic client-shaped handlers
 * these tests declare, for the deployment routes the actions now reach
 * through distilled operations. An injected `PrismaApiError` becomes its
 * real status, `undefined` becomes a 404, everything else a `{ data }`
 * envelope.
 */
const clientBackedApi = (client: any) =>
  makeFakeManagementApi((request: Captured) => {
    // segments[0] is the "v1" prefix.
    const [head, id, tail] = request.pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .slice(1);
    const { call, callVoid } = dispatchTo(request);

    if (head === "deployments" && id !== undefined) {
      if (tail === "start") return call(client.startDeployment, [id]);
      if (tail === "stop") return callVoid(client.stopDeployment, [id]);
      if (request.method === "GET") return call(client.getDeployment, [id]);
    }
    return unhandled(request);
  });

describe(
  "Prisma deployment actions",
  { tags: ["unit", "provider:prisma", "provider:prisma:deployment", "local"] },
  () => {
    it.effect(
      "does not hide a start conflict for an unuploaded version",
      () => {
        const error = conflict("start");
        const client = {
          startDeployment: () => Effect.fail(error),
          getDeployment: () => Effect.succeed(version("new")),
        } as unknown as PrismaManagementClient;

        return Effect.gen(function* () {
          const observed = yield* startDeploymentIdempotent(
            "deployment-1",
          ).pipe(Effect.flip);
          // Over the wire the injected conflict decodes into the typed error.
          expect(observed._tag).toBe("Conflict");
          expect(observed.message).toBe("state conflict");
        }).pipe(Effect.provide(clientBackedApi(client).layer));
      },
    );

    it.effect("accepts a start conflict only after observing progress", () => {
      const client = {
        startDeployment: () => Effect.fail(conflict("start")),
        getDeployment: () => Effect.succeed(version("provisioning")),
      } as unknown as PrismaManagementClient;

      return startDeploymentIdempotent("deployment-1").pipe(
        Effect.provide(clientBackedApi(client).layer),
      );
    });

    it.effect(
      "accepts a stop conflict while teardown is already progressing",
      () => {
        const client = {
          stopDeployment: () => Effect.fail(conflict("stop")),
          getDeployment: () => Effect.succeed(version("stopping")),
        } as unknown as PrismaManagementClient;

        return stopDeploymentIdempotent("deployment-1").pipe(
          Effect.provide(clientBackedApi(client).layer),
        );
      },
    );
  },
);
