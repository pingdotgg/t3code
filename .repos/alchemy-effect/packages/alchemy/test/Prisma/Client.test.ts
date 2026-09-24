import {
  extractConnectionSecrets,
  PrismaApiDecodeError,
  PrismaApiError,
  PrismaClient,
  PrismaClientLive,
  type PrismaManagementClient,
} from "@/Prisma/Client";
import { PrismaEnvironment } from "@/Prisma/PrismaEnvironment";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { TestClock } from "effect/testing";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { productionManagementApiRoutes } from "./fixtures/ManagementApiContract.ts";

interface Captured {
  url: string;
  method: string;
  pathname: string;
  search: string;
  authorization: string | undefined;
  bodyJson: unknown;
}

const page = <T>(
  data: T[],
  hasMore = false,
  nextCursor: string | null = null,
) => json({ data, pagination: { hasMore, nextCursor } });

const data = <T>(value: T) => json({ data: value });

const json = (value: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

const empty = () => new Response(null, { status: 204 });

const expectedManagementApiRoutes = [...productionManagementApiRoutes].sort();

const routeTemplateFor = (method: string, pathname: string): string => {
  const concreteSegments = pathname.split("/");
  const route = productionManagementApiRoutes.find((candidate) => {
    const separator = candidate.indexOf(" ");
    const candidateMethod = candidate.slice(0, separator);
    const templatePath = candidate.slice(separator + 1);
    const templateSegments = templatePath.split("/");
    return (
      candidateMethod === method &&
      templateSegments.length === concreteSegments.length &&
      templateSegments.every(
        (segment, index) =>
          (/^\{[^}]+\}$/.test(segment) &&
            concreteSegments[index]?.length !== 0) ||
          segment === concreteSegments[index],
      )
    );
  });
  if (!route) {
    throw new Error(
      `Missing route inventory mapping for ${method} ${pathname}`,
    );
  }
  return route;
};
const routeInventoryFrom = (captured: Captured[]) => {
  const routes = new Set<string>();
  for (const request of captured) {
    routes.add(routeTemplateFor(request.method, request.pathname));
  }
  routes.add("GET /v1/deployments/{deploymentId}/logs");
  routes.add("GET /v1/builds/{buildId}/logs");
  return [...routes].sort();
};

const fixtureResponse = (request: Captured) => {
  if (request.pathname === "/v1/projects" && request.method === "GET") {
    return request.search.includes("cursor=cursor-2")
      ? page([{ id: "project-2", type: "project", name: "Two" }])
      : page(
          [{ id: "project-1", type: "project", name: "One" }],
          true,
          "cursor-2",
        );
  }

  if (
    request.pathname === "/v1/projects/project-1/databases" &&
    request.method === "POST"
  ) {
    return data({ id: "database-1", type: "database", name: "main" });
  }

  if (
    request.pathname === "/v1/databases/database-1/backups" &&
    request.method === "GET"
  ) {
    return json({
      data: [
        {
          id: "backup-1",
          type: "backup",
          backupType: "full",
          createdAt: "2026-01-01T00:00:00Z",
          status: "completed",
        },
      ],
      meta: {
        backupRetentionDays: 7,
      },
      pagination: {
        hasMore: false,
        limit: 1,
      },
    });
  }

  if (
    request.pathname === "/v1/workspaces/workspace-1/integrations" &&
    request.method === "GET"
  ) {
    return page([{ id: "integration-1", url: "https://example.test" }]);
  }

  if (request.pathname === "/v1/domains/domain-1" && request.method === "GET") {
    return data({
      id: "domain-1",
      type: "custom-domain",
      url: "https://api.prisma.test/v1/domains/domain-1",
      hostname: "api.example.com",
      appId: "app-1",
      status: "pending_dns",
      foundryStatus: "pending",
      failureReason: null,
      failureCategory: null,
      certExpiresAt: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      dnsRecords: [],
    });
  }

  if (request.pathname.startsWith("/v1/regions") && request.method === "GET") {
    return json({
      data: [
        {
          id: "us-east-1",
          type: "region",
          name: "US East",
          product: "postgres",
          status: "available",
        },
      ],
    });
  }

  return json(
    {
      error: {
        message: `Unhandled fixture request ${request.method} ${request.pathname}${request.search}`,
      },
    },
    { status: 500 },
  );
};

const layerForHttp = (
  client: HttpClient.HttpClient,
  baseUrl = "https://api.prisma.test",
) =>
  PrismaClientLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, client),
        Layer.succeed(PrismaEnvironment, {
          type: "serviceToken" as const,
          serviceToken: Redacted.make("test-token"),
          source: { type: "stored" as const },
          baseUrl,
        }),
      ),
    ),
  );

const harness = (baseUrl = "https://api.prisma.test") => {
  const captured: Captured[] = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      const body = request.body as HttpBody.HttpBody;
      const bodyText =
        body._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : "";
      const entry: Captured = {
        url: request.url,
        method: request.method,
        pathname: url.pathname,
        search: url.search,
        authorization: request.headers.authorization,
        bodyJson: bodyText ? JSON.parse(bodyText) : undefined,
      };
      captured.push(entry);
      return HttpClientResponse.fromWeb(request, fixtureResponse(entry));
    }),
  );
  const layer = layerForHttp(client, baseUrl);
  return { layer, captured };
};

const withClient = <A>(
  f: (client: PrismaManagementClient) => Effect.Effect<A, any, any>,
) =>
  Effect.gen(function* () {
    const client = yield* PrismaClient;
    return yield* f(client);
  });

const routeCoverageHarness = () => {
  const captured: Captured[] = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      const body = request.body as HttpBody.HttpBody;
      const bodyText =
        body._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : "";
      const entry: Captured = {
        url: request.url,
        method: request.method,
        pathname: url.pathname,
        search: url.search,
        authorization: request.headers.authorization,
        bodyJson: bodyText ? JSON.parse(bodyText) : undefined,
      };
      captured.push(entry);

      if (entry.pathname.endsWith("/usage")) {
        return HttpClientResponse.fromWeb(
          request,
          json({
            period: { start: "2026-01-01", end: "2026-01-02" },
            metrics: {
              operations: { used: 0, unit: "ops" },
              storage: { used: 0, unit: "GiB" },
            },
            generatedAt: "2026-01-02T00:00:00Z",
          }),
        );
      }

      if (entry.pathname.startsWith("/v1/regions") && entry.method === "GET") {
        return HttpClientResponse.fromWeb(request, json({ data: [] }));
      }

      if (entry.method === "GET") {
        return HttpClientResponse.fromWeb(request, page([]));
      }

      if (
        entry.method === "DELETE" ||
        entry.pathname.endsWith("/stop") ||
        entry.pathname.endsWith("/transfer")
      ) {
        return HttpClientResponse.fromWeb(request, empty());
      }

      return HttpClientResponse.fromWeb(
        request,
        data({
          id: "resource-1",
          type: "resource",
          foundryVersionId: "foundry-1",
          uploadUrl: "https://upload.example.test/artifact.tar.gz",
          previewDomain: "version-1.example.test",
          appEndpointDomain: "app-1.example.test",
        }),
      );
    }),
  );
  const layer = PrismaClientLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, client),
        Layer.succeed(PrismaEnvironment, {
          type: "serviceToken" as const,
          serviceToken: Redacted.make("test-token"),
          source: { type: "stored" as const },
          baseUrl: "https://api.prisma.test",
        }),
      ),
    ),
  );
  return { layer, captured };
};

describe("PrismaClient", () => {
  it("extracts canonical endpoint secrets and parses direct credentials", () => {
    const secrets = extractConnectionSecrets({
      id: "connection-1",
      type: "connection",
      url: "https://api.prisma.test/v1/connections/connection-1",
      name: "api",
      createdAt: "2026-01-01T00:00:00Z",
      kind: "postgres",
      endpoints: {
        direct: {
          host: "direct.prisma.test",
          port: 5432,
          connectionString:
            "postgres://api:p%40ss@direct.prisma.test:5432/postgres?sslmode=require",
        },
        pooled: {
          host: "pooled.prisma.test",
          port: 5432,
          connectionString: "postgres://pooled",
        },
      },
      database: {
        id: "database-1",
        url: "https://api.prisma.test/v1/databases/database-1",
        name: "main",
      },
    } as unknown as Parameters<typeof extractConnectionSecrets>[0]);

    expect(Redacted.value(secrets.directConnectionString!)).toContain(
      "direct.prisma.test",
    );
    expect(Redacted.value(secrets.pooledConnectionString!)).toBe(
      "postgres://pooled",
    );
    expect(secrets.host).toBe("direct.prisma.test");
    expect(secrets.user).toBe("api");
    expect(Redacted.value(secrets.password!)).toBe("p@ss");
  });

  it.effect("paginates list endpoints and sends bearer auth", () => {
    const { layer, captured } = harness();

    return withClient((client) =>
      Effect.gen(function* () {
        const projects = yield* client.listProjects({ limit: 1 });

        expect(projects.map((project: { id: string }) => project.id)).toEqual([
          "project-1",
          "project-2",
        ]);
        expect(captured.map((request) => request.pathname)).toEqual([
          "/v1/projects",
          "/v1/projects",
        ]);
        expect(captured[0]?.search).toBe("?limit=1");
        expect(captured[1]?.search).toBe("?limit=1&cursor=cursor-2");
        expect(
          captured.every(
            (request) => request.authorization === "Bearer test-token",
          ),
        ).toBe(true);
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect("starts pagination from an explicit cursor", () => {
    const { layer, captured } = harness();

    return withClient((client) =>
      Effect.gen(function* () {
        const projects = yield* client.listProjects({
          limit: 1,
          cursor: "cursor-2",
        });

        expect(projects.map((project: { id: string }) => project.id)).toEqual([
          "project-2",
        ]);
        expect(captured.map((request) => request.pathname)).toEqual([
          "/v1/projects",
        ]);
        expect(captured[0]?.search).toBe("?limit=1&cursor=cursor-2");
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect("rejects pagination that omits a required next cursor", () => {
    const http = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, page([], true, null))),
    );

    return withClient((client) => client.listProjects()).pipe(
      Effect.provide(layerForHttp(http)),
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(PrismaApiDecodeError);
        expect(error.message).toContain(
          "hasMore was true without a non-empty nextCursor",
        );
      }),
    );
  });

  it.effect("rejects pagination that repeats a cursor", () => {
    let attempts = 0;
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        attempts += 1;
        return HttpClientResponse.fromWeb(
          request,
          page([], true, "repeated-cursor"),
        );
      }),
    );

    return withClient((client) => client.listProjects()).pipe(
      Effect.provide(layerForHttp(http)),
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(PrismaApiDecodeError);
        expect(error.message).toContain("nextCursor repeated");
        expect(attempts).toBe(2);
      }),
    );
  });

  it.effect("bounds aggregate pagination response bytes", () => {
    let attempts = 0;
    const payload = "x".repeat(4 * 1024 * 1024 - 1_024);
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        attempts += 1;
        return HttpClientResponse.fromWeb(
          request,
          page(
            [{ id: `project-${attempts}`, payload }],
            true,
            `cursor-${attempts}`,
          ),
        );
      }),
    );

    return withClient((client) => client.listProjects()).pipe(
      Effect.provide(layerForHttp(http)),
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(PrismaApiDecodeError);
        expect(error.message).toContain(
          "67108864 aggregate response byte safety limit",
        );
        if (error instanceof PrismaApiDecodeError) {
          expect(error.bodyLength).toBeGreaterThan(64 * 1024 * 1024);
        }
        expect(attempts).toBe(17);
      }),
    );
  });

  it.effect("uses the configured Prisma API base URL", () => {
    const { layer, captured } = harness("https://control-plane.prisma.test");

    return withClient((client) =>
      Effect.gen(function* () {
        yield* client.listProjects({ limit: 1 });

        expect(captured[0]?.url).toBe(
          "https://control-plane.prisma.test/v1/projects?limit=1",
        );
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect("preserves current custom-domain wire fields", () => {
    const { layer } = harness();

    return withClient((client) =>
      Effect.gen(function* () {
        const domain = yield* client.getCustomDomain("domain-1");
        expect(domain.appId).toBe("app-1");
        expect(domain.foundryStatus).toBe("pending");
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect("preserves 200 versus 201 custom-domain create outcomes", () => {
    const statuses = [200, 201] as const;
    let requestIndex = 0;
    const domain = {
      id: "domain-1",
      type: "custom-domain" as const,
      url: "https://api.prisma.test/v1/domains/domain-1",
      hostname: "api.example.com",
      appId: "app-1",
      status: "pending_dns" as const,
      foundryStatus: "pending",
      failureReason: null,
      failureCategory: null,
      certExpiresAt: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      dnsRecords: [],
    };
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        const status = statuses[requestIndex++];
        return HttpClientResponse.fromWeb(
          request,
          json({ data: domain }, { status }),
        );
      }),
    );

    return withClient((client) =>
      Effect.gen(function* () {
        const existing = yield* client.createAppDomain("app-1", {
          hostname: domain.hostname,
        });
        const created = yield* client.createAppDomain("app-1", {
          hostname: domain.hostname,
        });

        expect(existing).toEqual({ status: 200, domain });
        expect(created).toEqual({ status: 201, domain });
      }),
    ).pipe(Effect.provide(layerForHttp(http)));
  });

  it.effect("accepts the full flat database-create response contract", () => {
    const database = {
      id: "database-1",
      type: "database" as const,
      url: "https://api.prisma.test/v1/databases/database-1",
      name: "main",
      status: "failure" as const,
      createdAt: "2026-01-01T00:00:00Z",
      isDefault: false,
      defaultConnectionId: null,
      connections: [],
      project: {
        id: "project-1",
        url: "https://api.prisma.test/v1/projects/project-1",
        name: "app",
      },
      region: null,
      source: null,
      branchId: null,
    };
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          json({ data: database }, { status: 201 }),
        ),
      ),
    );

    return withClient((client) =>
      Effect.gen(function* () {
        const result = yield* client.createDatabase({
          projectId: "project-1",
        });
        expect(result.status).toBe("failure");
        expect(result.region).toBeNull();
      }),
    ).pipe(Effect.provide(layerForHttp(http)));
  });

  it.effect("does not retain secret-bearing malformed response bodies", () => {
    const secret = "postgres://admin:super-secret@db.prisma.test/postgres";
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(`{"data":{"connectionString":"${secret}"}`, {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );
    const layer = PrismaClientLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, http),
          Layer.succeed(PrismaEnvironment, {
            type: "serviceToken" as const,
            serviceToken: Redacted.make("test-token"),
            source: { type: "stored" as const },
            baseUrl: "https://api.prisma.test",
          }),
        ),
      ),
    );

    return withClient((client) =>
      Effect.gen(function* () {
        const error = yield* client
          .createConnection({ databaseId: "database-1", name: "api" })
          .pipe(Effect.flip);
        expect(error).toBeInstanceOf(PrismaApiDecodeError);
        expect(JSON.stringify(error)).not.toContain(secret);
        if (error instanceof PrismaApiDecodeError) {
          expect(error.bodyLength).toBeGreaterThan(0);
          expect("body" in error).toBe(false);
          expect("cause" in error).toBe(false);
        }
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect("rejects a missing data response envelope", () => {
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, json({ project: {} })),
      ),
    );

    return withClient((client) => client.getProject("project-1")).pipe(
      Effect.provide(layerForHttp(http)),
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(PrismaApiDecodeError);
        expect(error.message).toContain("did not contain a data envelope");
      }),
    );
  });

  it.effect("rejects path-confusing resource IDs before sending auth", () => {
    const { layer, captured } = harness();

    return withClient((client) =>
      Effect.gen(function* () {
        const traversal = yield* client
          .getProject("../workspaces")
          .pipe(Effect.flip);
        const embeddedRoute = yield* client
          .getProject("project-1/databases")
          .pipe(Effect.flip);
        const deploymentLog = yield* client
          .getDeploymentLogsRequest("deployment-1/../../projects")
          .pipe(Effect.flip);
        const buildLog = yield* client
          .getBuildLogsRequest("build-1?token=leak")
          .pipe(Effect.flip);

        for (const error of [
          traversal,
          embeddedRoute,
          deploymentLog,
          buildLog,
        ]) {
          expect(error).toBeInstanceOf(PrismaApiError);
          expect(error.message).toContain("invalid Prisma Management API");
        }
        expect(captured).toEqual([]);
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect("times out an unresponsive management API request", () => {
    const http = HttpClient.make(() => Effect.never);
    const layer = layerForHttp(http);

    return Effect.gen(function* () {
      const fiber = yield* withClient((client) =>
        client.getProject("project-1"),
      ).pipe(
        Effect.provide(layer),
        Effect.flip,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("11 seconds");
      const error = yield* Fiber.join(fiber);

      expect(error).toBeInstanceOf(PrismaApiError);
      if (error instanceof PrismaApiError) {
        expect(error.status).toBe(0);
        expect(error.message).toContain("timed out after 10 seconds");
      }
    }).pipe(Effect.provide(TestClock.layer()));
  });

  it.effect("times out while reading a streaming response body", () => {
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"data":'));
              },
            }),
            {
              status: 201,
              headers: { "content-type": "application/json" },
            },
          ),
        ),
      ),
    );
    const layer = layerForHttp(http);

    return Effect.gen(function* () {
      const fiber = yield* withClient((client) =>
        client.getProject("project-1"),
      ).pipe(
        Effect.provide(layer),
        Effect.flip,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("11 seconds");
      const error = yield* Fiber.join(fiber);

      expect(error).toBeInstanceOf(PrismaApiError);
      if (error instanceof PrismaApiError) {
        expect(error.status).toBe(0);
        expect(error.message).toContain("timed out after 10 seconds");
      }
    }).pipe(Effect.provide(TestClock.layer()));
  });

  it.effect("rejects oversized successful response bodies", () => {
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response("x".repeat(4 * 1024 * 1024 + 1), {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );

    return withClient((client) => client.createProject({ name: "api" })).pipe(
      Effect.provide(layerForHttp(http)),
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(PrismaApiDecodeError);
        expect(error.message).toContain("4194304 byte safety limit");
      }),
    );
  });

  it.effect("bounds and redacts oversized API error bodies", () => {
    const secret = "do-not-retain-this-error-body";
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(secret.repeat(3_000), {
            status: 400,
            headers: { "content-type": "text/plain" },
          }),
        ),
      ),
    );

    return withClient((client) => client.createProject({ name: "api" })).pipe(
      Effect.provide(layerForHttp(http)),
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(PrismaApiError);
        expect(error.message).toContain("65536 byte safety limit");
        expect(JSON.stringify(error)).not.toContain(secret);
        if (error instanceof PrismaApiError) {
          expect(error.status).toBe(400);
          expect(error.body).toBeUndefined();
        }
      }),
    );
  });

  it.effect("does not expose plain-text API error bodies in messages", () => {
    const secret = "postgres://admin:plain-text-secret@db.example.test/main";
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(secret, {
            status: 400,
            headers: { "content-type": "text/plain" },
          }),
        ),
      ),
    );

    return withClient((client) => client.createProject({ name: "api" })).pipe(
      Effect.provide(layerForHttp(http)),
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(PrismaApiError);
        expect(error.message).toBe("HTTP 400");
        expect(String(error)).not.toContain(secret);
        expect(JSON.stringify(error)).not.toContain(secret);
        if (error instanceof PrismaApiError) {
          expect(Redacted.value(error.body!)).toBe(secret);
        }
      }),
    );
  });

  it.effect("exposes only safe codes from structured API errors", () => {
    const secret = "postgres://admin:structured-secret@db.example.test/main";
    const responseBody = {
      error: {
        code: "state:not_found",
        message: secret,
        hint: secret,
      },
    };
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          json(responseBody, { status: 404 }),
        ),
      ),
    );

    return withClient((client) => client.createProject({ name: "api" })).pipe(
      Effect.provide(layerForHttp(http)),
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(PrismaApiError);
        expect(error.message).toBe(
          "Prisma Management API request failed (state:not_found)",
        );
        expect(String(error)).not.toContain(secret);
        expect(JSON.stringify(error)).not.toContain(secret);
      }),
    );
  });

  it.effect("uses canonical app and deployment management routes", () => {
    const { layer, captured } = routeCoverageHarness();

    return withClient((client) =>
      Effect.gen(function* () {
        yield* client.createProjectDatabase("project-1", {
          name: "main",
          region: "us-east-1",
        });
        yield* client.createApp({
          projectId: "project-1",
          displayName: "api",
          regionId: "us-east-1",
        });
        yield* client.createAppDeployment("app-1", {
          portMapping: { http: 3000 },
        });
        yield* client.getDeployment("deployment-1");
        yield* client.startDeployment("deployment-1");
        yield* client.stopDeployment("deployment-1");
        yield* client.deleteDeployment("deployment-1");
        yield* client.listWorkspaceIntegrations("workspace-1", { limit: 10 });

        expect(
          captured.map((request) => [
            request.method,
            `${request.pathname}${request.search}`,
          ]),
        ).toEqual([
          ["POST", "/v1/projects/project-1/databases"],
          ["POST", "/v1/apps"],
          ["POST", "/v1/apps/app-1/deployments"],
          ["GET", "/v1/deployments/deployment-1"],
          ["POST", "/v1/deployments/deployment-1/start"],
          ["POST", "/v1/deployments/deployment-1/stop"],
          ["DELETE", "/v1/deployments/deployment-1"],
          ["GET", "/v1/workspaces/workspace-1/integrations?limit=10"],
        ]);
        expect(captured[0]?.bodyJson).toEqual({
          name: "main",
          region: "us-east-1",
        });
        expect(captured[2]?.bodyJson).toEqual({
          portMapping: { http: 3000 },
        });
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect("retries transient API failures for destructive requests", () => {
    const captured: Captured[] = [];
    let attempts = 0;
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        attempts += 1;
        const url = new URL(request.url);
        captured.push({
          url: request.url,
          method: request.method,
          pathname: url.pathname,
          search: url.search,
          authorization: request.headers.authorization,
          bodyJson: undefined,
        });
        return HttpClientResponse.fromWeb(
          request,
          attempts < 3
            ? json(
                {
                  error: {
                    message: "transient platform failure",
                  },
                },
                { status: 500 },
              )
            : empty(),
        );
      }),
    );
    const layer = PrismaClientLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, http),
          Layer.succeed(PrismaEnvironment, {
            type: "serviceToken" as const,
            serviceToken: Redacted.make("test-token"),
            source: { type: "stored" as const },
            baseUrl: "https://api.prisma.test",
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const fiber = yield* withClient((client) =>
        client.deleteDeployment("deployment-1"),
      ).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);

      expect(attempts).toBe(3);
      expect(captured.map((request) => request.method)).toEqual([
        "DELETE",
        "DELETE",
        "DELETE",
      ]);
      expect(captured.map((request) => request.pathname)).toEqual([
        "/v1/deployments/deployment-1",
        "/v1/deployments/deployment-1",
        "/v1/deployments/deployment-1",
      ]);
    }).pipe(Effect.provide(TestClock.layer()));
  });

  it.effect("retries transient API failures for safe lifecycle posts", () => {
    const captured: Captured[] = [];
    let attempts = 0;
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        attempts += 1;
        const url = new URL(request.url);
        captured.push({
          url: request.url,
          method: request.method,
          pathname: url.pathname,
          search: url.search,
          authorization: request.headers.authorization,
          bodyJson: undefined,
        });
        return HttpClientResponse.fromWeb(
          request,
          attempts < 3
            ? json(
                {
                  error: {
                    message: "transient platform failure",
                  },
                },
                { status: 500 },
              )
            : data({
                id: "deployment-1",
                type: "deployment",
                url: "https://api.prisma.test/v1/deployments/deployment-1",
                foundryVersionId: "foundry-1",
                status: "running",
                previewDomain: "version-1.prisma.test",
              }),
        );
      }),
    );
    const layer = PrismaClientLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, http),
          Layer.succeed(PrismaEnvironment, {
            type: "serviceToken" as const,
            serviceToken: Redacted.make("test-token"),
            source: { type: "stored" as const },
            baseUrl: "https://api.prisma.test",
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const fiber = yield* withClient((client) =>
        client.startDeployment("deployment-1"),
      ).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("1 second");
      const version = yield* Fiber.join(fiber);

      expect(attempts).toBe(3);
      expect(version.previewDomain).toBe("version-1.prisma.test");
      expect(captured.map((request) => request.method)).toEqual([
        "POST",
        "POST",
        "POST",
      ]);
      expect(captured.map((request) => request.pathname)).toEqual([
        "/v1/deployments/deployment-1/start",
        "/v1/deployments/deployment-1/start",
        "/v1/deployments/deployment-1/start",
      ]);
    }).pipe(Effect.provide(TestClock.layer()));
  });

  it.effect("does not retry transient API failures for create requests", () => {
    const captured: Captured[] = [];
    let attempts = 0;
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        attempts += 1;
        const url = new URL(request.url);
        captured.push({
          url: request.url,
          method: request.method,
          pathname: url.pathname,
          search: url.search,
          authorization: request.headers.authorization,
          bodyJson: undefined,
        });
        return HttpClientResponse.fromWeb(
          request,
          json(
            {
              error: {
                message: "transient platform failure",
              },
            },
            { status: 500 },
          ),
        );
      }),
    );
    const layer = PrismaClientLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, http),
          Layer.succeed(PrismaEnvironment, {
            type: "serviceToken" as const,
            serviceToken: Redacted.make("test-token"),
            source: { type: "stored" as const },
            baseUrl: "https://api.prisma.test",
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const error = yield* withClient((client) =>
        client.createAppDeployment("app-1", {
          portMapping: { http: 3000 },
        }),
      ).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(PrismaApiError);
      expect(attempts).toBe(1);
      expect(captured.map((request) => request.method)).toEqual(["POST"]);
      expect(captured.map((request) => request.pathname)).toEqual([
        "/v1/apps/app-1/deployments",
      ]);
    });
  });

  it.effect(
    "does not retry transient API failures for transfer requests",
    () => {
      const captured: Captured[] = [];
      let attempts = 0;
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          attempts += 1;
          const url = new URL(request.url);
          captured.push({
            url: request.url,
            method: request.method,
            pathname: url.pathname,
            search: url.search,
            authorization: request.headers.authorization,
            bodyJson: undefined,
          });
          return HttpClientResponse.fromWeb(
            request,
            json(
              {
                error: {
                  message: "transient platform failure",
                },
              },
              { status: 500 },
            ),
          );
        }),
      );
      const layer = PrismaClientLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HttpClient.HttpClient, http),
            Layer.succeed(PrismaEnvironment, {
              type: "serviceToken" as const,
              serviceToken: Redacted.make("test-token"),
              source: { type: "stored" as const },
              baseUrl: "https://api.prisma.test",
            }),
          ),
        ),
      );

      return Effect.gen(function* () {
        const error = yield* withClient((client) =>
          client.transferProject("project-1", {
            recipientAccessToken: "recipient-token",
          }),
        ).pipe(Effect.provide(layer), Effect.flip);

        expect(error).toBeInstanceOf(PrismaApiError);
        expect(attempts).toBe(1);
        expect(captured.map((request) => request.method)).toEqual(["POST"]);
        expect(captured.map((request) => request.pathname)).toEqual([
          "/v1/projects/project-1/transfer",
        ]);
      });
    },
  );

  it.effect("retries transient transport failures", () => {
    let attempts = 0;
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        attempts += 1;
        return attempts < 3
          ? new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause: new Error("connection reset"),
                description: "test transport failure",
              }),
            })
          : undefined;
      }).pipe(
        Effect.flatMap((error) =>
          error
            ? Effect.fail(error)
            : Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  page([{ id: "project-1" }]),
                ),
              ),
        ),
      ),
    );
    const layer = PrismaClientLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, http),
          Layer.succeed(PrismaEnvironment, {
            type: "serviceToken" as const,
            serviceToken: Redacted.make("test-token"),
            source: { type: "stored" as const },
            baseUrl: "https://api.prisma.test",
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const fiber = yield* withClient((client) => client.listProjects()).pipe(
        Effect.provide(layer),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("1 second");
      const projects = yield* Fiber.join(fiber);

      expect(attempts).toBe(3);
      expect(projects.map((project) => project.id)).toEqual(["project-1"]);
    }).pipe(Effect.provide(TestClock.layer()));
  });

  it.effect("preserves backup list metadata", () => {
    const { layer, captured } = harness();

    return withClient((client) =>
      Effect.gen(function* () {
        const backups = yield* client.listBackups("database-1", { limit: 1 });

        expect(backups).toEqual({
          data: [
            {
              id: "backup-1",
              type: "backup",
              backupType: "full",
              createdAt: "2026-01-01T00:00:00Z",
              status: "completed",
            },
          ],
          meta: {
            backupRetentionDays: 7,
          },
          pagination: {
            hasMore: false,
            limit: 1,
          },
        });
        expect(captured.map((request) => request.pathname)).toEqual([
          "/v1/databases/database-1/backups",
        ]);
        expect(captured[0]?.search).toBe("?limit=1");
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect("reads non-paginated region endpoints", () => {
    const { layer } = harness();

    return withClient((client) =>
      Effect.gen(function* () {
        const regions = yield* client.listRegions({ product: "postgres" });
        const postgresRegions = yield* client.listPostgresRegions();
        const accelerateRegions = yield* client.listAccelerateRegions();

        expect(regions.map((region) => region.id)).toEqual(["us-east-1"]);
        expect(postgresRegions.map((region) => region.id)).toEqual([
          "us-east-1",
        ]);
        expect(accelerateRegions.map((region) => region.id)).toEqual([
          "us-east-1",
        ]);
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect("builds authenticated deployment log stream requests", () => {
    const { layer, captured } = harness("https://api.prisma.test");

    return withClient((client) =>
      Effect.gen(function* () {
        const request = yield* client.getDeploymentLogsRequest("deployment-1", {
          tail: 100,
          fromStart: true,
          cursor: "byte-42",
        });
        expect(request.url).toBe(
          "wss://api.prisma.test/v1/deployments/deployment-1/logs?tail=100&cursor=byte-42&from_start=true",
        );
        expect(Redacted.value(request.headers.Authorization)).toBe(
          "Bearer test-token",
        );
        expect(captured).toEqual([]);
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect(
    "maps every supported Management API operation to its route",
    () => {
      const { layer, captured } = routeCoverageHarness();

      return withClient((client) =>
        Effect.gen(function* () {
          yield* client.listWorkspaces({ limit: 1 });
          yield* client.getWorkspace("workspace-1");
          yield* client.getCurrentPrincipal();
          yield* client.listRegions({ product: "postgres" });
          yield* client.listPostgresRegions();
          yield* client.listAccelerateRegions();

          yield* client.listProjects({ limit: 1 });
          yield* client.getProject("project-1");
          yield* client.createProject({ name: "app", region: "us-east-1" });
          yield* client.updateProject("project-1", { name: "renamed" });
          yield* client.deleteProject("project-1");
          yield* client.transferProject("project-1", {
            recipientAccessToken: "recipient-token",
          });

          yield* client.listDatabases({
            projectId: "project-1",
            branchGitName: "main",
          });
          yield* client.listProjectDatabases("project-1", { limit: 1 });
          yield* client.getDatabase("database-1");
          yield* client.createDatabase({
            projectId: "project-1",
            name: "main",
          });
          yield* client.createProjectDatabase("project-1", {
            name: "main",
            source: {
              type: "backup",
              databaseId: "database-source",
              backupId: "backup-1",
            },
          });
          yield* client.updateDatabase("database-1", { name: "main-2" });
          yield* client.deleteDatabase("database-1");
          yield* client.listBackups("database-1", { limit: 1 });
          yield* client.restoreDatabase("database-1", {
            source: {
              type: "backup",
              databaseId: "database-source",
              backupId: "backup-1",
            },
          });
          yield* client.getDatabaseUsage("database-1", {
            startDate: "2026-01-01",
          });

          yield* client.listConnections({ databaseId: "database-1" });
          yield* client.listDatabaseConnections("database-1", { limit: 1 });
          yield* client.getConnection("connection-1");
          yield* client.createConnection({
            databaseId: "database-1",
            name: "direct",
          });
          yield* client.createDatabaseConnection("database-1", {
            name: "direct",
          });
          yield* client.deleteConnection("connection-1");
          yield* client.rotateConnection("connection-1");

          yield* client.listBranches("project-1", { gitName: "main" });
          yield* client.getBranch("branch-1");
          yield* client.createBranch("project-1", { gitName: "main" });
          yield* client.updateBranch("branch-1", { isDefault: true });
          yield* client.deleteBranch("branch-1");

          yield* client.listBuckets({ projectId: "project-1" });
          yield* client.getBucket("bucket-1");
          yield* client.createBucket({
            projectId: "project-1",
            name: "uploads",
          });
          yield* client.deleteBucket("bucket-1");
          yield* client.listBucketKeys("bucket-1", { limit: 1 });
          yield* client.createBucketKey("bucket-1", { role: "read_write" });
          yield* client.deleteBucketKey("bucket-1", "key-1");

          yield* client.getCustomDomain("domain-1");
          yield* client.deleteCustomDomain("domain-1");
          yield* client.retryCustomDomain("domain-1");

          yield* client.listEnvironmentVariables({
            projectId: "project-1",
            class: "production",
            key: "TOKEN",
          });
          yield* client.getEnvironmentVariable("env-1");
          yield* client.createEnvironmentVariable({
            projectId: "project-1",
            class: "production",
            key: "TOKEN",
            value: "secret",
          });
          yield* client.updateEnvironmentVariable("env-1", {
            value: "secret-2",
          });
          yield* client.deleteEnvironmentVariable("env-1");

          yield* client.listIntegrations({ workspaceId: "workspace-1" });
          yield* client.listWorkspaceIntegrations("workspace-1", { limit: 1 });
          yield* client.getIntegration("integration-1");
          yield* client.deleteIntegration("integration-1");
          yield* client.revokeWorkspaceIntegration("workspace-1", "client-1");

          yield* client.listScmInstallations({ workspaceId: "workspace-1" });
          yield* client.createScmInstallIntent({
            provider: "github",
            workspaceId: "workspace-1",
          });
          yield* client.listScmInstallationRepositories("scminstall-1", {
            limit: 10,
          });

          yield* client.listSourceRepositories({ projectId: "project-1" });
          yield* client.getSourceRepository("repo-1");
          yield* client.createSourceRepository({
            projectId: "project-1",
            provider: "github",
            providerRepositoryId: 123,
            installationId: "scminstall-1",
          });
          yield* client.deleteSourceRepository("repo-1");

          yield* client.listApps({
            projectId: "project-1",
            branchGitName: "main",
          });
          yield* client.getApp("app-1");
          yield* client.createApp({
            projectId: "project-1",
            displayName: "web",
          });
          yield* client.updateApp("app-1", { displayName: "web-2" });
          yield* client.deleteApp("app-1");
          yield* client.promoteApp("app-1", { deploymentId: "deployment-1" });
          yield* client.rollbackApp("app-1", { deploymentId: "deployment-1" });
          yield* client.listAppDomains("app-1");
          yield* client.createAppDomain("app-1", {
            hostname: "web.example.com",
          });
          yield* client.listAppDeployments("app-1", { limit: 1 });
          yield* client.createAppDeployment("app-1", {
            skipCodeUpload: true,
          });
          yield* client.getDeployment("deployment-1");
          yield* client.deleteDeployment("deployment-1");
          yield* client.startDeployment("deployment-1");
          yield* client.stopDeployment("deployment-1");
          const deploymentLogsRequest = yield* client.getDeploymentLogsRequest(
            "deployment-1",
            { tail: 10 },
          );
          expect(deploymentLogsRequest.url).toBe(
            "wss://api.prisma.test/v1/deployments/deployment-1/logs?tail=10",
          );
          expect(
            Redacted.value(deploymentLogsRequest.headers.Authorization),
          ).toBe("Bearer test-token");
          const buildLogsRequest = yield* client.getBuildLogsRequest(
            "build-1",
            { follow: true, cursor: "cursor-1" },
          );
          expect(buildLogsRequest.url).toBe(
            "https://api.prisma.test/v1/builds/build-1/logs?follow=true&cursor=cursor-1",
          );
          expect(Redacted.value(buildLogsRequest.headers.Authorization)).toBe(
            "Bearer test-token",
          );
          expect(buildLogsRequest.headers.Accept).toBe("application/x-ndjson");

          expect(
            captured.map((request) => [
              request.method,
              `${request.pathname}${request.search}`,
            ]),
          ).toEqual([
            ["GET", "/v1/workspaces?limit=1"],
            ["GET", "/v1/workspaces/workspace-1"],
            ["GET", "/v1/me"],
            ["GET", "/v1/regions?product=postgres"],
            ["GET", "/v1/regions/postgres"],
            ["GET", "/v1/regions/accelerate"],
            ["GET", "/v1/projects?limit=1"],
            ["GET", "/v1/projects/project-1"],
            ["POST", "/v1/projects"],
            ["PATCH", "/v1/projects/project-1"],
            ["DELETE", "/v1/projects/project-1"],
            ["POST", "/v1/projects/project-1/transfer"],
            ["GET", "/v1/databases?projectId=project-1&branchGitName=main"],
            ["GET", "/v1/projects/project-1/databases?limit=1"],
            ["GET", "/v1/databases/database-1"],
            ["POST", "/v1/databases"],
            ["POST", "/v1/projects/project-1/databases"],
            ["PATCH", "/v1/databases/database-1"],
            ["DELETE", "/v1/databases/database-1"],
            ["GET", "/v1/databases/database-1/backups?limit=1"],
            ["POST", "/v1/databases/database-1/restore"],
            ["GET", "/v1/databases/database-1/usage?startDate=2026-01-01"],
            ["GET", "/v1/connections?databaseId=database-1"],
            ["GET", "/v1/databases/database-1/connections?limit=1"],
            ["GET", "/v1/connections/connection-1"],
            ["POST", "/v1/connections"],
            ["POST", "/v1/databases/database-1/connections"],
            ["DELETE", "/v1/connections/connection-1"],
            ["POST", "/v1/connections/connection-1/rotate"],
            ["GET", "/v1/projects/project-1/branches?gitName=main"],
            ["GET", "/v1/branches/branch-1"],
            ["POST", "/v1/projects/project-1/branches"],
            ["PATCH", "/v1/branches/branch-1"],
            ["DELETE", "/v1/branches/branch-1"],
            ["GET", "/v1/buckets?projectId=project-1"],
            ["GET", "/v1/buckets/bucket-1"],
            ["POST", "/v1/buckets"],
            ["DELETE", "/v1/buckets/bucket-1"],
            ["GET", "/v1/buckets/bucket-1/keys?limit=1"],
            ["POST", "/v1/buckets/bucket-1/keys"],
            ["DELETE", "/v1/buckets/bucket-1/keys/key-1"],
            ["GET", "/v1/domains/domain-1"],
            ["DELETE", "/v1/domains/domain-1"],
            ["POST", "/v1/domains/domain-1/retry"],
            [
              "GET",
              "/v1/environment-variables?projectId=project-1&class=production&key=TOKEN",
            ],
            ["GET", "/v1/environment-variables/env-1"],
            ["POST", "/v1/environment-variables"],
            ["PATCH", "/v1/environment-variables/env-1"],
            ["DELETE", "/v1/environment-variables/env-1"],
            ["GET", "/v1/integrations?workspaceId=workspace-1"],
            ["GET", "/v1/workspaces/workspace-1/integrations?limit=1"],
            ["GET", "/v1/integrations/integration-1"],
            ["DELETE", "/v1/integrations/integration-1"],
            ["DELETE", "/v1/workspaces/workspace-1/integrations/client-1"],
            ["GET", "/v1/scm-installations?workspaceId=workspace-1"],
            ["POST", "/v1/scm-installations/install-intents"],
            ["GET", "/v1/scm-installations/scminstall-1/repositories?limit=10"],
            ["GET", "/v1/source-repositories?projectId=project-1"],
            ["GET", "/v1/source-repositories/repo-1"],
            ["POST", "/v1/source-repositories"],
            ["DELETE", "/v1/source-repositories/repo-1"],
            ["GET", "/v1/apps?projectId=project-1&branchGitName=main"],
            ["GET", "/v1/apps/app-1"],
            ["POST", "/v1/apps"],
            ["PATCH", "/v1/apps/app-1"],
            ["DELETE", "/v1/apps/app-1"],
            ["POST", "/v1/apps/app-1/promote"],
            ["POST", "/v1/apps/app-1/rollback"],
            ["GET", "/v1/apps/app-1/domains"],
            ["POST", "/v1/apps/app-1/domains"],
            ["GET", "/v1/apps/app-1/deployments?limit=1"],
            ["POST", "/v1/apps/app-1/deployments"],
            ["GET", "/v1/deployments/deployment-1"],
            ["DELETE", "/v1/deployments/deployment-1"],
            ["POST", "/v1/deployments/deployment-1/start"],
            ["POST", "/v1/deployments/deployment-1/stop"],
          ]);
          expect(routeInventoryFrom(captured)).toEqual(
            expectedManagementApiRoutes,
          );
          expect(expectedManagementApiRoutes).toHaveLength(78);
          expect(captured[11]?.bodyJson).toEqual({
            recipientAccessToken: "recipient-token",
          });
          const restoreRequest = captured.find(
            (request) =>
              request.method === "POST" &&
              request.pathname === "/v1/databases/database-1/restore",
          );
          expect(restoreRequest?.bodyJson).toEqual({
            source: {
              type: "backup",
              databaseId: "database-source",
              backupId: "backup-1",
            },
          });
          const projectDatabaseRequest = captured.find(
            (request) =>
              request.method === "POST" &&
              request.pathname === "/v1/projects/project-1/databases",
          );
          expect(projectDatabaseRequest?.bodyJson).toEqual({
            name: "main",
            source: {
              type: "backup",
              databaseId: "database-source",
              backupId: "backup-1",
            },
          });

          const createEnvRequest = captured.find(
            (request) =>
              request.method === "POST" &&
              request.pathname === "/v1/environment-variables",
          );
          expect(createEnvRequest?.bodyJson).toEqual({
            projectId: "project-1",
            class: "production",
            key: "TOKEN",
            value: "secret",
          });

          const updateEnvRequest = captured.find(
            (request) =>
              request.method === "PATCH" &&
              request.pathname === "/v1/environment-variables/env-1",
          );
          expect(updateEnvRequest?.bodyJson).toEqual({
            value: "secret-2",
          });

          const sourceRepositoryRequest = captured.find(
            (request) =>
              request.method === "POST" &&
              request.pathname === "/v1/source-repositories",
          );
          expect(sourceRepositoryRequest?.bodyJson).toEqual({
            projectId: "project-1",
            provider: "github",
            providerRepositoryId: 123,
            installationId: "scminstall-1",
          });

          const installIntentRequest = captured.find(
            (request) =>
              request.method === "POST" &&
              request.pathname === "/v1/scm-installations/install-intents",
          );
          expect(installIntentRequest?.bodyJson).toEqual({
            provider: "github",
            workspaceId: "workspace-1",
          });
        }),
      ).pipe(Effect.provide(layer));
    },
  );

  it("matches the pinned Management API route contract", () => {
    expect(expectedManagementApiRoutes).toEqual(
      [...productionManagementApiRoutes].sort(),
    );
  });
});
