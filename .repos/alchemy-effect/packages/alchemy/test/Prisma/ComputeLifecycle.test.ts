import { PrismaApiError, type PrismaManagementClient } from "@/Prisma/Client";
import {
  destroyApp,
  destroyDeployment,
  destroyProjectApps,
  waitForDeploymentStatus,
} from "@/Prisma/ComputeLifecycle";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { Retry, fromApiToken } from "@distilled.cloud/prisma";
import {
  type Captured,
  data,
  dispatchTo,
  FAKE_API_BASE_URL,
  makeFakeManagementApi,
  page,
  unhandled,
} from "./fixtures/FakeManagementApi.ts";
import { PrismaPaginationError } from "@/Prisma/Internal/Pagination";

const apiError = (
  method: "GET" | "POST" | "DELETE",
  path: string,
  status: number,
) => new PrismaApiError({ method, path, status, message: `HTTP ${status}` });

const deployment = (id: string, status: string) => ({
  id,
  type: "deployment" as const,
  serviceId: "app-1",
  url: `https://api.prisma.test/v1/deployments/${id}`,
  foundryVersionId: `foundry-${id}`,
  status,
  previewDomain: `${id}.preview.prisma.build`,
  createdAt: "2026-01-01T00:00:00Z",
});

const appItem = (id: string) => ({
  id,
  type: "app" as const,
  url: `https://api.prisma.test/v1/services/${id}`,
  name: id,
  region: { id: "us-east-1", name: "US East" },
  projectId: "project-1",
  branchId: null,
  latestDeploymentId: null,
  appEndpointDomain: `${id}.prisma.build`,
  createdAt: "2026-01-01T00:00:00Z",
});

/**
 * Serve the Management API from the same hermetic client-shaped handlers
 * these tests declare, for the lifecycle routes now reached through distilled
 * operations. `dispatchTo` maps each handler's result onto the wire (see the
 * fixture).
 */
const clientBackedApi = (client: any) =>
  makeFakeManagementApi((request: Captured) => {
    // segments[0] is the "v1" prefix.
    const [head, id, tail] = request.pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .slice(1);
    const query = Object.fromEntries(new URLSearchParams(request.search));
    const { call, callVoid, list } = dispatchTo(request);

    if (head === "deployments" && id !== undefined) {
      if (tail === "stop") return callVoid(client.stopDeployment, [id]);
      if (request.method === "GET") return call(client.getDeployment, [id]);
      if (request.method === "DELETE") {
        return callVoid(client.deleteDeployment, [id]);
      }
    }
    if (head === "services") {
      if (id === undefined && request.method === "GET") {
        return call(client.listApps, [query], list);
      }
      if (id !== undefined && tail === "deployments") {
        return call(client.listAppDeployments, [id, query], list);
      }
      if (id !== undefined && request.method === "DELETE") {
        return callVoid(client.deleteApp, [id]);
      }
    }
    if (
      head === "projects" &&
      id !== undefined &&
      request.method === "DELETE"
    ) {
      return callVoid(client.deleteProject, [id]);
    }
    return unhandled(request);
  });

const provide = (client: unknown) =>
  Effect.provide(clientBackedApi(client).layer);

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
      const result = yield* waitForDeploymentStatus("deployment-1", "running", {
        pollIntervalMs: 1,
        timeoutSeconds: 10,
      });
      expect(result.status).toBe("running");
      expect(observed).toBe(2);
    }).pipe(provide(client));
  });

  it.effect("fails immediately for a failed deployment", () => {
    const client = {
      getDeployment: (id: string) => Effect.succeed(deployment(id, "failed")),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const error = yield* waitForDeploymentStatus(
        "deployment-1",
        "running",
      ).pipe(Effect.flip);
      expect(error.message).toContain("deployment-1");
      expect(error.message).toContain("failed");
    }).pipe(provide(client));
  });

  it.live("times out with the last observed deployment status", () => {
    const client = {
      getDeployment: (id: string) =>
        Effect.succeed(deployment(id, "provisioning")),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const error = yield* waitForDeploymentStatus("deployment-1", "running", {
        timeoutSeconds: 0.01,
        pollIntervalMs: 1,
      }).pipe(Effect.flip);
      expect(error.message).toContain("Timed out");
      expect(error.message).toContain("provisioning");
    }).pipe(provide(client));
  });

  it.live("caps a hung deployment observation at the polling deadline", () => {
    // A handler cannot hang inside the synchronous dispatch fake, so the hang
    // is modeled at the transport: an HTTP client that never answers.
    const hungTransport = Layer.mergeAll(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.never),
      ),
      fromApiToken({
        apiToken: "fake-service-token",
        apiBaseUrl: FAKE_API_BASE_URL,
      }),
    );

    return Effect.gen(function* () {
      const startedAt = Date.now();
      const error = yield* waitForDeploymentStatus(
        "deployment-hung",
        "running",
        { timeoutSeconds: 0.05, pollIntervalMs: 1 },
      ).pipe(Effect.flip);
      const elapsed = Date.now() - startedAt;

      expect(error.message).toContain("Timed out");
      expect(error.message).toContain("last status: 'unknown'");
      expect(elapsed).toBeLessThan(500);
    }).pipe(Effect.provide(hungTransport));
  });

  it.effect("rejects invalid deployment polling timings", () => {
    const client = {
      getDeployment: () => Effect.die("invalid options must fail first"),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const timeoutError = yield* waitForDeploymentStatus(
        "deployment-1",
        "running",
        { timeoutSeconds: 0 },
      ).pipe(Effect.flip);
      const intervalError = yield* waitForDeploymentStatus(
        "deployment-1",
        "running",
        { pollIntervalMs: Number.NaN },
      ).pipe(Effect.flip);

      expect(timeoutError.message).toContain("timeoutSeconds");
      expect(intervalError.message).toContain("pollIntervalMs");
    }).pipe(provide(client));
  });

  it.effect("preserves a not-found observation while waiting", () => {
    const client = {
      getDeployment: () =>
        Effect.fail(apiError("GET", "/v1/deployments/deployment-1", 404)),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const error = yield* waitForDeploymentStatus(
        "deployment-1",
        "running",
      ).pipe(Effect.flip);
      // Over the wire the injected 404 decodes into the typed error.
      expect(error._tag).toBe("NotFound");
      expect(error.message).toBe("HTTP 404");
    }).pipe(provide(client));
  });

  it.effect("treats an already deleted deployment as deleted", () => {
    const client = {
      getDeployment: (id: string) =>
        Effect.fail(apiError("GET", `/v1/deployments/${id}`, 404)),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const result = yield* destroyDeployment("deployment-missing");
      expect(result).toEqual({
        deploymentId: "deployment-missing",
        previousStatus: undefined,
        stopped: false,
        deleted: true,
      });
    }).pipe(provide(client));
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
      const result = yield* destroyDeployment("deployment-1");
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
    }).pipe(provide(client));
  });

  it.effect("reports only the canonical deployment cleanup route", () => {
    const client = {
      getDeployment: () =>
        Effect.succeed(deployment("deployment-1", "stopped")),
      deleteDeployment: (id: string) =>
        Effect.fail(apiError("DELETE", `/v1/deployments/${id}`, 400)),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const error = yield* destroyDeployment("deployment-1").pipe(Effect.flip);
      expect(error.message).toContain("DELETE /v1/deployments/deployment-1");
    }).pipe(provide(client));
  });

  it.effect(
    "explains a stopped deployment whose delete fails with a server error",
    () => {
      const client = {
        getDeployment: () =>
          Effect.succeed(deployment("deployment-1", "stopped")),
        deleteDeployment: (id: string) =>
          // An unmapped status decodes into the catch-all error, which
          // carries the ServerError category the diagnostic branch reads.
          Effect.fail(apiError("DELETE", `/v1/deployments/${id}`, 507)),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const error = yield* destroyDeployment("deployment-1").pipe(
          Effect.flip,
        );
        expect(error.message).toContain(
          "Stopped Prisma deployments are expected to be deletable",
        );
        expect(error.message).toContain("DELETE /v1/deployments/deployment-1");
      }).pipe(
        provide(client),
        // Server-category errors are replayed by the default policy; this
        // test examines the terminal diagnostic, so retries are disabled.
        Effect.provide(Layer.succeed(Retry.Retry, { while: () => false })),
      );
    },
  );

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
        const result = yield* destroyApp("app-1");
        expect(result).toEqual({ appId: "app-1", appDeleted: true });
        expect(calls).toEqual(["delete-app:app-1"]);
      }).pipe(provide(client));
    },
  );

  it.live("retries a bounded App deletion conflict", () => {
    let attempts = 0;
    const client = {
      deleteApp: (id: string) =>
        Effect.suspend(() => {
          attempts += 1;
          return attempts < 3
            ? Effect.fail(apiError("DELETE", `/v1/services/${id}`, 409))
            : Effect.void;
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const result = yield* destroyApp("app-1");
      expect(result.appDeleted).toBe(true);
      expect(attempts).toBe(3);
    }).pipe(provide(client));
  });

  it.effect("treats an already deleted App as deleted", () => {
    const client = {
      deleteApp: (id: string) =>
        Effect.fail(apiError("DELETE", `/v1/services/${id}`, 404)),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      expect(yield* destroyApp("app-missing")).toEqual({
        appId: "app-missing",
        appDeleted: true,
      });
    }).pipe(provide(client));
  });

  it.live("surfaces the final App deletion conflict", () => {
    let attempts = 0;
    const conflict = apiError("DELETE", "/v1/services/app-1", 409);
    const client = {
      deleteApp: () =>
        Effect.sync(() => {
          attempts += 1;
        }).pipe(Effect.flatMap(() => Effect.fail(conflict))),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const error = yield* destroyApp("app-1").pipe(Effect.flip);
      // Over the wire the injected 409 decodes into the typed error.
      expect(error._tag).toBe("Conflict");
      expect(error.message).toBe("HTTP 409");
      expect(attempts).toBe(5);
    }).pipe(provide(client));
  });

  it.effect("deletes project Apps before deleting the project", () => {
    const calls: string[] = [];
    const client = {
      listApps: (query: unknown) =>
        Effect.sync(() => {
          calls.push(`list:${JSON.stringify(query)}`);
          return [appItem("app-1"), appItem("app-2")];
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
      const result = yield* destroyProjectApps("project-1");
      expect(result).toEqual({
        projectId: "project-1",
        deletedAppIds: ["app-1", "app-2"],
        projectDeleted: true,
      });
      expect(calls).toEqual([
        // Over the wire, query params arrive as strings.
        'list:{"limit":"100","projectId":"project-1"}',
        "delete-app:app-1",
        "delete-app:app-2",
        "delete-project:project-1",
      ]);
    }).pipe(provide(client));
  });

  it.effect("treats an already deleted project as deleted", () => {
    const client = {
      listApps: () =>
        Effect.fail(apiError("GET", "/v1/services?projectId=project-1", 404)),
      deleteProject: (id: string) =>
        Effect.fail(apiError("DELETE", `/v1/projects/${id}`, 404)),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      expect(yield* destroyProjectApps("project-1")).toEqual({
        projectId: "project-1",
        deletedAppIds: [],
        projectDeleted: true,
      });
    }).pipe(provide(client));
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
          return lists === 1 ? [appItem("app-1")] : [];
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
      const result = yield* destroyProjectApps("project-1");
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
    }).pipe(provide(client));
  });

  it.effect("supports keeping the project after deleting its Apps", () => {
    const calls: string[] = [];
    const client = {
      listApps: () => Effect.succeed([appItem("app-1")]),
      deleteApp: (id: string) =>
        Effect.sync(() => calls.push(`delete-app:${id}`)),
      deleteProject: () => Effect.die("must not delete project"),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const result = yield* destroyProjectApps("project-1", {
        keepProject: true,
      });
      expect(result.projectDeleted).toBe(false);
      expect(result.deletedAppIds).toEqual(["app-1"]);
      expect(calls).toEqual(["delete-app:app-1"]);
    }).pipe(provide(client));
  });

  it.effect("cleans every App returned across canonical pagination", () => {
    const apps = Array.from({ length: 101 }, (_, index) =>
      appItem(`app-${index}`),
    );
    const deleted: string[] = [];
    const client = {
      // The fake serves the full set in one page; the inline walk stops when
      // the pagination envelope reports no more pages.
      listApps: () => Effect.succeed(apps),
      deleteApp: (id: string) =>
        Effect.sync(() => {
          deleted.push(id);
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const result = yield* destroyProjectApps("project-1", {
        keepProject: true,
      });
      expect(result.deletedAppIds).toHaveLength(101);
      expect(deleted).toHaveLength(101);
    }).pipe(provide(client));
  });

  it.effect("supports keeping Apps during project-scoped inspection", () => {
    const client = {
      listApps: () => Effect.succeed([appItem("app-1")]),
      deleteApp: () => Effect.die("must not delete App"),
      deleteProject: () => Effect.die("must not delete project"),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const result = yield* destroyProjectApps("project-1", {
        keepApp: true,
        keepProject: true,
      });
      expect(result).toEqual({
        projectId: "project-1",
        deletedAppIds: [],
        projectDeleted: false,
      });
    }).pipe(provide(client));
  });

  it.effect(
    "refuses a truncated App listing that promises another page",
    () => {
      // `hasMore: true` with no cursor is a malformed page. Reading it as the
      // end of the list would let the cleanup miss live Apps, so the walk fails
      // loudly instead.
      const fake = makeFakeManagementApi((request: Captured) =>
        request.pathname === "/v1/services" && request.method === "GET"
          ? page([appItem("app-1")], true, null)
          : unhandled(request),
      );

      return Effect.gen(function* () {
        const error = yield* destroyProjectApps("project-1").pipe(Effect.flip);
        expect(error).toBeInstanceOf(PrismaPaginationError);
        expect(error.message).toContain(
          "hasMore was true without a non-empty nextCursor",
        );
      }).pipe(Effect.provide(fake.layer));
    },
  );
});
