import { PrismaApiError, type PrismaManagementClient } from "@/Prisma/Client";
import {
  destroyApp,
  destroyDeployment,
  destroyProjectApps,
  waitForDeploymentStatus,
} from "@/Prisma/ComputeLifecycle";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";

const apiError = (
  method: "GET" | "POST" | "DELETE",
  path: string,
  status: number,
) => new PrismaApiError({ method, path, status, message: `HTTP ${status}` });

const deployment = (id: string, status: string) => ({
  id,
  type: "deployment" as const,
  url: `https://api.prisma.test/v1/deployments/${id}`,
  foundryVersionId: `foundry-${id}`,
  status,
  previewDomain: `${id}.preview.prisma.build`,
  createdAt: "2026-01-01T00:00:00Z",
});

describe("Prisma canonical Compute lifecycle", () => {
  it.live("waits for a deployment to reach its target status", () => {
    let observed = 0;
    const client = {
      getDeployment: (id: string) =>
        Effect.sync(() =>
          deployment(id, observed++ === 0 ? "provisioning" : "running"),
        ),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const result = yield* waitForDeploymentStatus(
        client,
        "deployment-1",
        "running",
        { pollIntervalMs: 1, timeoutSeconds: 1 },
      );
      expect(result.status).toBe("running");
      expect(observed).toBe(2);
    });
  });

  it.effect("fails immediately for a failed deployment", () => {
    const client = {
      getDeployment: (id: string) => Effect.succeed(deployment(id, "failed")),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const error = yield* waitForDeploymentStatus(
        client,
        "deployment-1",
        "running",
      ).pipe(Effect.flip);
      expect((error as Error).message).toContain("deployment-1");
      expect((error as Error).message).toContain("failed");
    });
  });

  it.live("times out with the last observed deployment status", () => {
    const client = {
      getDeployment: (id: string) =>
        Effect.succeed(deployment(id, "provisioning")),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const error = yield* waitForDeploymentStatus(
        client,
        "deployment-1",
        "running",
        { timeoutSeconds: 0.01, pollIntervalMs: 1 },
      ).pipe(Effect.flip);
      expect((error as Error).message).toContain("Timed out");
      expect((error as Error).message).toContain("provisioning");
    });
  });

  it.live("caps a hung deployment observation at the polling deadline", () => {
    const client = {
      getDeployment: () => Effect.never,
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const startedAt = Date.now();
      const error = yield* waitForDeploymentStatus(
        client,
        "deployment-hung",
        "running",
        { timeoutSeconds: 0.05, pollIntervalMs: 1 },
      ).pipe(Effect.flip);
      const elapsed = Date.now() - startedAt;

      expect((error as Error).message).toContain("Timed out");
      expect((error as Error).message).toContain("last status: 'unknown'");
      expect(elapsed).toBeLessThan(500);
    });
  });

  it.effect("rejects invalid deployment polling timings", () => {
    const client = {
      getDeployment: () => Effect.die("invalid options must fail first"),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const timeoutError = yield* waitForDeploymentStatus(
        client,
        "deployment-1",
        "running",
        { timeoutSeconds: 0 },
      ).pipe(Effect.flip);
      const intervalError = yield* waitForDeploymentStatus(
        client,
        "deployment-1",
        "running",
        { pollIntervalMs: Number.NaN },
      ).pipe(Effect.flip);

      expect((timeoutError as Error).message).toContain("timeoutSeconds");
      expect((intervalError as Error).message).toContain("pollIntervalMs");
    });
  });

  it.effect("preserves a not-found observation while waiting", () => {
    const notFound = apiError("GET", "/v1/deployments/deployment-1", 404);
    const client = {
      getDeployment: () => Effect.fail(notFound),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const error = yield* waitForDeploymentStatus(
        client,
        "deployment-1",
        "running",
      ).pipe(Effect.flip);
      expect(error).toBe(notFound);
    });
  });

  it.effect("treats an already deleted deployment as deleted", () => {
    const client = {
      getDeployment: (id: string) =>
        Effect.fail(apiError("GET", `/v1/deployments/${id}`, 404)),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const result = yield* destroyDeployment(client, "deployment-missing");
      expect(result).toEqual({
        deploymentId: "deployment-missing",
        previousStatus: undefined,
        stopped: false,
        deleted: true,
      });
    });
  });

  it.effect("stops a running deployment before deleting it", () => {
    const calls: string[] = [];
    let status = "running";
    const client = {
      getDeployment: (id: string) =>
        Effect.sync(() => {
          calls.push(`get:${id}`);
          return deployment(id, status);
        }),
      stopDeployment: (id: string) =>
        Effect.sync(() => {
          calls.push(`stop:${id}`);
          status = "stopped";
        }),
      deleteDeployment: (id: string) =>
        Effect.sync(() => {
          calls.push(`delete:${id}`);
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const result = yield* destroyDeployment(client, "deployment-1");
      expect(result).toMatchObject({
        deploymentId: "deployment-1",
        previousStatus: "running",
        stopped: true,
        deleted: true,
      });
      expect(calls).toEqual([
        "get:deployment-1",
        "stop:deployment-1",
        "get:deployment-1",
        "delete:deployment-1",
      ]);
    });
  });

  it.effect("reports only the canonical deployment cleanup route", () => {
    const client = {
      getDeployment: () =>
        Effect.succeed(deployment("deployment-1", "stopped")),
      deleteDeployment: (id: string) =>
        Effect.fail(apiError("DELETE", `/v1/deployments/${id}`, 500)),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const error = yield* destroyDeployment(client, "deployment-1").pipe(
        Effect.flip,
      );
      expect((error as Error).message).toContain(
        "DELETE /v1/deployments/deployment-1",
      );
    });
  });

  it.effect(
    "uses the App delete cascade without enumerating deployments",
    () => {
      const calls: string[] = [];
      const client = {
        listAppDeployments: () => Effect.die("must not enumerate deployments"),
        deleteApp: (id: string) =>
          Effect.sync(() => {
            calls.push(`delete-app:${id}`);
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const result = yield* destroyApp(client, "app-1");
        expect(result).toEqual({ appId: "app-1", appDeleted: true });
        expect(calls).toEqual(["delete-app:app-1"]);
      });
    },
  );

  it.live("retries a bounded App deletion conflict", () => {
    let attempts = 0;
    const client = {
      deleteApp: (id: string) =>
        Effect.suspend(() => {
          attempts += 1;
          return attempts < 3
            ? Effect.fail(apiError("DELETE", `/v1/apps/${id}`, 409))
            : Effect.void;
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const result = yield* destroyApp(client, "app-1");
      expect(result.appDeleted).toBe(true);
      expect(attempts).toBe(3);
    });
  });

  it.effect("treats an already deleted App as deleted", () => {
    const client = {
      deleteApp: (id: string) =>
        Effect.fail(apiError("DELETE", `/v1/apps/${id}`, 404)),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      expect(yield* destroyApp(client, "app-missing")).toEqual({
        appId: "app-missing",
        appDeleted: true,
      });
    });
  });

  it.live("surfaces the final App deletion conflict", () => {
    let attempts = 0;
    const conflict = apiError("DELETE", "/v1/apps/app-1", 409);
    const client = {
      deleteApp: () =>
        Effect.sync(() => {
          attempts += 1;
        }).pipe(Effect.flatMap(() => Effect.fail(conflict))),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const error = yield* destroyApp(client, "app-1").pipe(Effect.flip);
      expect(error).toBe(conflict);
      expect(attempts).toBe(5);
    });
  });

  it.effect("deletes project Apps before deleting the project", () => {
    const calls: string[] = [];
    const client = {
      listApps: (query: unknown) =>
        Effect.sync(() => {
          calls.push(`list:${JSON.stringify(query)}`);
          return [{ id: "app-1" }, { id: "app-2" }];
        }),
      deleteApp: (id: string) =>
        Effect.sync(() => {
          calls.push(`delete-app:${id}`);
        }),
      deleteProject: (id: string) =>
        Effect.sync(() => {
          calls.push(`delete-project:${id}`);
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const result = yield* destroyProjectApps(client, "project-1");
      expect(result).toEqual({
        projectId: "project-1",
        deletedAppIds: ["app-1", "app-2"],
        projectDeleted: true,
      });
      expect(calls).toEqual([
        'list:{"projectId":"project-1","limit":100}',
        "delete-app:app-1",
        "delete-app:app-2",
        "delete-project:project-1",
      ]);
    });
  });

  it.effect("treats an already deleted project as deleted", () => {
    const client = {
      listApps: () =>
        Effect.fail(apiError("GET", "/v1/apps?projectId=project-1", 404)),
      deleteProject: (id: string) =>
        Effect.fail(apiError("DELETE", `/v1/projects/${id}`, 404)),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      expect(yield* destroyProjectApps(client, "project-1")).toEqual({
        projectId: "project-1",
        deletedAppIds: [],
        projectDeleted: true,
      });
    });
  });

  it.live("re-cleans Apps after a blocked project deletion", () => {
    const calls: string[] = [];
    let lists = 0;
    let deletes = 0;
    const client = {
      listApps: () =>
        Effect.sync(() => {
          lists += 1;
          calls.push(`list:${lists}`);
          return lists === 1 ? [{ id: "app-1" }] : [];
        }),
      deleteApp: (id: string) =>
        Effect.sync(() => calls.push(`delete-app:${id}`)),
      deleteProject: (id: string) =>
        Effect.suspend(() => {
          deletes += 1;
          calls.push(`delete-project:${id}:${deletes}`);
          return deletes === 1
            ? Effect.fail(apiError("DELETE", `/v1/projects/${id}`, 409))
            : Effect.void;
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const result = yield* destroyProjectApps(client, "project-1");
      expect(result).toEqual({
        projectId: "project-1",
        deletedAppIds: ["app-1"],
        projectDeleted: true,
      });
      expect(calls).toEqual([
        "list:1",
        "delete-app:app-1",
        "delete-project:project-1:1",
        "list:2",
        "delete-project:project-1:2",
      ]);
    });
  });

  it.effect("supports keeping the project after deleting its Apps", () => {
    const calls: string[] = [];
    const client = {
      listApps: () => Effect.succeed([{ id: "app-1" }]),
      deleteApp: (id: string) =>
        Effect.sync(() => calls.push(`delete-app:${id}`)),
      deleteProject: () => Effect.die("must not delete project"),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const result = yield* destroyProjectApps(client, "project-1", {
        keepProject: true,
      });
      expect(result.projectDeleted).toBe(false);
      expect(result.deletedAppIds).toEqual(["app-1"]);
      expect(calls).toEqual(["delete-app:app-1"]);
    });
  });

  it.effect("cleans every App returned across canonical pagination", () => {
    const apps = Array.from({ length: 101 }, (_, index) => ({
      id: `app-${index}`,
    }));
    const deleted: string[] = [];
    const client = {
      // PrismaManagementClient.listApps follows every cursor before returning.
      listApps: () => Effect.succeed(apps),
      deleteApp: (id: string) =>
        Effect.sync(() => {
          deleted.push(id);
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const result = yield* destroyProjectApps(client, "project-1", {
        keepProject: true,
      });
      expect(result.deletedAppIds).toHaveLength(101);
      expect(deleted).toHaveLength(101);
    });
  });

  it.effect("supports keeping Apps during project-scoped inspection", () => {
    const client = {
      listApps: () => Effect.succeed([{ id: "app-1" }]),
      deleteApp: () => Effect.die("must not delete App"),
      deleteProject: () => Effect.die("must not delete project"),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const result = yield* destroyProjectApps(client, "project-1", {
        keepApp: true,
        keepProject: true,
      });
      expect(result).toEqual({
        projectId: "project-1",
        deletedAppIds: [],
        projectDeleted: false,
      });
    });
  });
});
