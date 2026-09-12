import {
  Compute,
  ComputeDevProvider,
  ComputeProvider,
  syncComputeEnvironment,
  waitForDeploymentUrl,
  type ComputeProps,
} from "@/Prisma/Compute";
import { Unowned } from "@/AdoptPolicy";
import { AlchemyContext } from "@/AlchemyContext";
import {
  PrismaApiError,
  PrismaClient,
  type PrismaManagementClient,
} from "@/Prisma/Client";
import * as Output from "@/Output";
import type { ResourceBinding } from "@/Resource";
import { Stack } from "@/Stack";
import { PlatformServices } from "@/Util/PlatformServices";
import type { Branch as ApiBranch } from "@/Prisma/Types";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { gunzipSync } from "node:zlib";
import { WebSocketServer } from "ws";

const testBranch = (
  id: string,
  role: "production" | "preview" = "production",
): ApiBranch => ({
  id,
  type: "branch",
  url: `https://api.prisma.test/v1/branches/${id}`,
  gitName: id === "branch-main" ? "main" : id,
  isDefault: role === "production" && id === "branch-main",
  role,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  project: {
    id: "project-1",
    url: "https://api.prisma.test/v1/projects/project-1",
    name: "project",
  },
});

const withDefaultBranch = <T extends object>(
  client: T,
  role: "production" | "preview" = "production",
): PrismaManagementClient => {
  const mock = client as Record<string, (...args: any[]) => any>;
  return {
    ...client,
    getBranch: (id: string) =>
      mock.getBranch?.(id) ?? Effect.succeed(testBranch(id, role)),
    listBranches: (projectId: string, query?: { gitName?: string }) =>
      mock.listBranches?.(projectId, query) ??
      Effect.succeed([testBranch("branch-main", role)]),
    listApps: (query: { projectId?: string; limit?: number }) =>
      mock.listApps?.length >= 2
        ? mock.listApps(query.projectId, { limit: query.limit })
        : mock.listApps?.(query),
    createApp: (input: { projectId: string } & Record<string, unknown>) => {
      if (mock.createApp?.length < 2) return mock.createApp(input);
      const { projectId, ...body } = input;
      return mock.createApp(projectId, body);
    },
    createAppDeployment: (appId: string, input: unknown) =>
      mock.createAppDeployment?.(appId, input),
    getDeployment: (id: string) => mock.getDeployment?.(id),
    startDeployment: (id: string) => mock.startDeployment?.(id),
    stopDeployment: (id: string) => mock.stopDeployment?.(id),
    deleteDeployment: (id: string) => mock.deleteDeployment?.(id),
    listAppDeployments: (appId: string, query: unknown) =>
      mock.listAppDeployments?.(appId, query),
    promoteApp: (appId: string, target: { deploymentId: string }) =>
      mock.promoteApp(appId, target),
    rollbackApp: (appId: string, target: { deploymentId: string }) =>
      mock.rollbackApp?.(appId, target),
  } as unknown as PrismaManagementClient;
};

const fixtureArtifactPath = `${import.meta.dirname}/fixtures/artifact-archive.bin`;
const fixtureArtifactV1Path = `${import.meta.dirname}/fixtures/artifact-v1.bin`;
const fixtureArtifactV2Path = `${import.meta.dirname}/fixtures/artifact-v2.bin`;

const readHttpBodyBytes = Effect.fn(function* (body: HttpBody.HttpBody) {
  if (body._tag === "Uint8Array") return body.body;
  if (body._tag !== "Stream") return new Uint8Array();
  const chunks = yield* Stream.runCollect(body.stream).pipe(Effect.orDie);
  const output = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
});

const readTarString = (buffer: Uint8Array, start: number, length: number) => {
  const bytes = buffer.slice(start, start + length);
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end >= 0 ? bytes.slice(0, end) : bytes);
};

const readTarFile = (buffer: Uint8Array, expectedName: string) => {
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.slice(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(
      readTarString(header, 124, 12).trim() || "0",
      8,
    );
    const bodyStart = offset + 512;
    if (fullName === expectedName) {
      return new TextDecoder().decode(
        buffer.slice(bodyStart, bodyStart + size),
      );
    }
    offset = bodyStart + size + ((512 - (size % 512)) % 512);
  }
  throw new Error(`Missing tar entry '${expectedName}'.`);
};

const httpBodyContentType = (body: HttpBody.HttpBody) =>
  body._tag === "Uint8Array" || body._tag === "Stream"
    ? body.contentType
    : undefined;

const makeHealthLifecycleFixture = (options?: {
  latestDeploymentId?: string | null;
  previewStatus?: number;
  stableStatus?: number;
  rollbackFailures?: number;
  getAppFailureCalls?: readonly number[];
  promoteUpdatesLatest?: boolean;
  rollbackUpdatesLatest?: boolean;
}) => {
  const calls: Array<[string, unknown?]> = [];
  const deployments = new Map<
    string,
    "new" | "running" | "provisioning" | "stopped" | "failed"
  >([["version-old", "running"]]);
  let deploymentCounter = 0;
  let previewStatus = options?.previewStatus ?? 204;
  let stableStatus = options?.stableStatus ?? 204;
  let rollbackFailuresRemaining = options?.rollbackFailures ?? 0;
  let getAppCalls = 0;
  let latestDeploymentId =
    options?.latestDeploymentId === undefined
      ? "version-old"
      : options.latestDeploymentId;

  const app = () => ({
    id: "service-1",
    type: "app" as const,
    url: "https://api.prisma.test/v1/apps/service-1",
    name: "api",
    region: { id: "us-east-1", name: "US East" },
    projectId: "project-1",
    branchId: "branch-main",
    latestDeploymentId,
    appEndpointDomain: "api.prisma.build",
    createdAt: "2026-01-01T00:00:00Z",
  });
  const client = {
    getApp: (id: string) => {
      getAppCalls += 1;
      calls.push(["getApp", id]);
      if (options?.getAppFailureCalls?.includes(getAppCalls)) {
        return Effect.fail(
          new PrismaApiError({
            method: "GET",
            path: `/v1/apps/${id}`,
            status: 503,
            message: "app observation unavailable",
          }),
        );
      }
      return Effect.succeed(app());
    },
    createAppDeployment: (appId: string, input: unknown) => {
      calls.push(["createAppDeployment", { appId, input }]);
      deploymentCounter += 1;
      const deploymentId =
        deploymentCounter === 1
          ? "version-new"
          : `version-new-${deploymentCounter}`;
      deployments.set(deploymentId, "new");
      return Effect.succeed({
        id: deploymentId,
        type: "deployment" as const,
        url: `https://api.prisma.test/v1/deployments/${deploymentId}`,
        foundryVersionId: `foundry-${deploymentId}`,
        uploadUrl: `https://upload.prisma.test/${deploymentId}.tar.gz`,
      });
    },
    getDeployment: (id: string) => {
      calls.push(["getDeployment", id]);
      const status = deployments.get(id);
      return status
        ? Effect.succeed({
            id,
            type: "deployment" as const,
            url: `https://api.prisma.test/v1/deployments/${id}`,
            foundryVersionId: `foundry-${id}`,
            status,
            previewDomain: `${id}.preview.prisma.build`,
            createdAt: "2026-01-01T00:00:00Z",
          })
        : Effect.fail(
            new PrismaApiError({
              method: "GET",
              path: `/v1/deployments/${id}`,
              status: 404,
              message: "not found",
            }),
          );
    },
    startDeployment: (id: string) =>
      Effect.sync(() => {
        calls.push(["startDeployment", id]);
        deployments.set(id, "running");
        return { previewDomain: `${id}.preview.prisma.build` };
      }),
    promoteApp: (appId: string, target: { deploymentId: string }) =>
      Effect.sync(() => {
        calls.push(["promoteApp", { appId, ...target }]);
        if (options?.promoteUpdatesLatest !== false) {
          latestDeploymentId = target.deploymentId;
        }
        return { appEndpointDomain: "api.prisma.build" };
      }),
    rollbackApp: (appId: string, target: { deploymentId: string }) =>
      Effect.gen(function* () {
        calls.push(["rollbackApp", { appId, ...target }]);
        if (rollbackFailuresRemaining > 0) {
          rollbackFailuresRemaining -= 1;
          return yield* Effect.fail(
            new PrismaApiError({
              method: "POST",
              path: `/v1/apps/${appId}/rollback`,
              status: 503,
              message: "rollback unavailable",
            }),
          );
        }
        if (options?.rollbackUpdatesLatest !== false) {
          latestDeploymentId = target.deploymentId;
        }
        return { appEndpointDomain: "api.prisma.build" };
      }),
    stopDeployment: (id: string) =>
      Effect.sync(() => {
        calls.push(["stopDeployment", id]);
        deployments.set(id, "stopped");
      }),
    deleteDeployment: (id: string) =>
      Effect.sync(() => {
        calls.push(["deleteDeployment", id]);
        deployments.delete(id);
      }),
  } as unknown as PrismaManagementClient;
  const http = HttpClient.make((request) => {
    if (request.url.startsWith("https://upload.prisma.test/")) {
      calls.push(["upload", request.url]);
      return readHttpBodyBytes(request.body as HttpBody.HttpBody).pipe(
        Effect.as(HttpClientResponse.fromWeb(request, new Response(null))),
      );
    }
    calls.push(["healthRequest", request.url]);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(null, {
          status: new URL(request.url).hostname.endsWith(
            ".preview.prisma.build",
          )
            ? previewStatus
            : stableStatus,
        }),
      ),
    );
  });

  return {
    calls,
    client,
    http,
    hasDeployment: (id: string) => deployments.has(id),
    latestDeploymentId: () => latestDeploymentId,
    setPreviewStatus: (status: number) => {
      previewStatus = status;
    },
    setStableStatus: (status: number) => {
      stableStatus = status;
    },
    setDeploymentStatus: (
      id: string,
      status: "new" | "running" | "provisioning" | "stopped" | "failed",
    ) => {
      deployments.set(id, status);
    },
  };
};

const liveProviderContext = Layer.succeed(AlchemyContext, {
  dotAlchemy: ".alchemy-test",
  dev: false,
  adopt: false,
});

const computeProviderLive = () =>
  ComputeProvider().pipe(Layer.provide(liveProviderContext));

describe("Prisma Compute", () => {
  it.live("accepts a streaming 200 response without consuming its body", () => {
    const body = new ReadableStream<Uint8Array>({
      pull() {
        // Deliberately never enqueue or close. Reading this body would hang.
      },
    });
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(body, { status: 200 }),
        ),
      ),
    );

    return waitForDeploymentUrl("https://app.prisma.build", {
      project: "project-1",
      appName: "api",
      urlReadinessTimeoutSeconds: 0.05,
    }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, http)));
  });

  it.live("waits for the configured application health contract", () => {
    const requests: string[] = [];
    const http = HttpClient.make((request) => {
      requests.push(request.url);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(null, {
            status: requests.length === 1 ? 503 : 204,
          }),
        ),
      );
    });

    return Effect.gen(function* () {
      yield* waitForDeploymentUrl("https://app.prisma.build", {
        project: "project-1",
        appName: "api",
        healthCheck: { path: "/api/health" },
        pollIntervalMs: 1,
        // Wall-clock deadline (live clock). The mock succeeds on the second
        // poll, so the pass path never waits this long — it only needs to
        // not fire spuriously when a saturated event loop (full-suite run)
        // delays the second poll beyond a tight budget.
        urlReadinessTimeoutSeconds: 30,
      });

      expect(requests).toEqual([
        "https://app.prisma.build/api/health",
        "https://app.prisma.build/api/health",
      ]);
    }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, http)));
  });

  it.effect("rejects unsafe application health contracts", () =>
    Effect.gen(function* () {
      const pathError = yield* waitForDeploymentUrl(
        "https://app.prisma.build",
        {
          project: "project-1",
          appName: "api",
          healthCheck: { path: "//attacker.example/health" },
        },
      ).pipe(Effect.flip);
      const statusError = yield* waitForDeploymentUrl(
        "https://app.prisma.build",
        {
          project: "project-1",
          appName: "api",
          healthCheck: { path: "/health", statusCodes: [] },
        },
      ).pipe(Effect.flip);

      expect((pathError as Error).message).toContain("healthCheck.path");
      expect((statusError as Error).message).toContain(
        "healthCheck.statusCodes",
      );
    }),
  );

  it.effect("fails closed when an application health probe cannot run", () =>
    Effect.gen(function* () {
      const props = {
        project: "project-1",
        appName: "api",
        healthCheck: { path: "/health" },
      } as const;
      const missingUrl = yield* waitForDeploymentUrl(undefined, props).pipe(
        Effect.flip,
      );
      const missingRoutingUrl = yield* waitForDeploymentUrl(undefined, {
        project: "project-1",
        appName: "api",
      }).pipe(Effect.flip);
      const disabled = yield* waitForDeploymentUrl("https://app.prisma.build", {
        ...props,
        verifyUrl: false,
      }).pipe(Effect.flip);
      const missingClient = yield* waitForDeploymentUrl(
        "https://app.prisma.build",
        props,
      ).pipe(Effect.flip);

      expect((missingUrl as Error).message).toContain("did not return");
      expect((missingRoutingUrl as Error).message).toContain(
        "readiness verification",
      );
      expect((disabled as Error).message).toContain("verifyUrl: false");
      expect((missingClient as Error).message).toContain("HTTP client");
    }),
  );

  it.live("observes health redirects without following them", () => {
    const redirects: RequestRedirect[] = [];
    const fetch = (async (
      _input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      redirects.push(init?.redirect ?? "follow");
      return init?.redirect === "manual"
        ? new Response(null, {
            status: 302,
            headers: { location: "https://attacker.example/" },
          })
        : new Response(null, { status: 200 });
    }) as typeof globalThis.fetch;

    return Effect.gen(function* () {
      yield* waitForDeploymentUrl("https://app.prisma.build", {
        project: "project-1",
        appName: "api",
        healthCheck: { path: "/health", statusCodes: [302] },
        pollIntervalMs: 1,
        urlReadinessTimeoutSeconds: 0.05,
      });
      const defaultStatusError = yield* waitForDeploymentUrl(
        "https://app.prisma.build",
        {
          project: "project-1",
          appName: "api",
          healthCheck: { path: "/health" },
          pollIntervalMs: 1,
          urlReadinessTimeoutSeconds: 0.01,
        },
      ).pipe(Effect.flip);

      expect(redirects.length).toBeGreaterThanOrEqual(2);
      expect(redirects.every((redirect) => redirect === "manual")).toBe(true);
      expect((defaultStatusError as Error).message).toContain("HTTP 302");
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
  });

  it.live("enforces one deadline for stalled requests and 404 bodies", () => {
    const stalledRequest = HttpClient.make(() => Effect.never);
    const stalledBody = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            new ReadableStream<Uint8Array>({
              pull() {
                // Deliberately never enqueue or close.
              },
            }),
            { status: 404 },
          ),
        ),
      ),
    );
    const props = {
      project: "project-1",
      appName: "api",
      pollIntervalMs: 1,
      urlReadinessTimeoutSeconds: 0.03,
    } as const;

    return Effect.gen(function* () {
      const requestError = yield* waitForDeploymentUrl(
        "https://request.prisma.build",
        props,
      ).pipe(
        Effect.provide(Layer.succeed(HttpClient.HttpClient, stalledRequest)),
        Effect.flip,
      );
      const bodyError = yield* waitForDeploymentUrl(
        "https://body.prisma.build",
        props,
      ).pipe(
        Effect.provide(Layer.succeed(HttpClient.HttpClient, stalledBody)),
        Effect.flip,
      );

      expect((requestError as Error).message).toContain("Timed out");
      expect((bodyError as Error).message).toContain("Timed out");
    });
  });

  it.live("bounds the inspected prefix of a large Prisma edge 404", () => {
    let requests = 0;
    const hugeBody = `${"There is no service on this URL"}${"x".repeat(
      256 * 1024,
    )}`;
    const http = HttpClient.make((request) => {
      requests += 1;
      return requests === 1
        ? Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(hugeBody, { status: 404 }),
            ),
          )
        : Effect.never;
    });

    return Effect.gen(function* () {
      const error = yield* waitForDeploymentUrl(
        "https://missing.prisma.build",
        {
          project: "project-1",
          appName: "api",
          pollIntervalMs: 1,
          urlReadinessTimeoutSeconds: 0.05,
        },
      ).pipe(
        Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
        Effect.flip,
      );

      expect((error as Error).message).toContain(
        "There is no service on this URL",
      );
      expect(requests).toBeGreaterThanOrEqual(1);
    });
  });

  it.effect(
    "rejects invalid URL readiness timings before making a request",
    () => {
      const http = HttpClient.make(() =>
        Effect.die("invalid readiness options must fail first"),
      );

      return Effect.gen(function* () {
        const error = yield* waitForDeploymentUrl("https://app.prisma.build", {
          project: "project-1",
          appName: "api",
          pollIntervalMs: 0,
        }).pipe(
          Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
          Effect.flip,
        );

        expect((error as Error).message).toContain("pollIntervalMs");
      });
    },
  );
  it.effect("rejects destroyOldDeployment when promotion is skipped", () => {
    const client = {} as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const error = yield* provider
        .reconcile({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            appName: "api",
            skipPromote: true,
            destroyOldDeployment: true,
          },
          olds: undefined,
          output: undefined,
          session: undefined as never,
          bindings: [],
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "destroyOldDeployment cannot be combined with skipPromote",
      );
    }).pipe(
      Effect.provide(computeProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
    );
  });

  it.effect("rejects a health check when deployment start is disabled", () => {
    const client = {} as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const error = yield* provider
        .reconcile({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            appName: "api",
            start: false,
            skipPromote: true,
            healthCheck: { path: "/health" },
          },
          olds: undefined,
          output: undefined,
          session: undefined as never,
          bindings: [],
        })
        .pipe(Effect.flip);

      expect((error as Error).message).toContain("healthCheck requires start");
    }).pipe(
      Effect.provide(computeProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, client)),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("rejects disabled start when promotion is enabled", () => {
    const client = {} as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const error = yield* provider
        .reconcile({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            appName: "api",
            start: false,
          },
          olds: undefined,
          output: undefined,
          session: undefined as never,
          bindings: [],
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "start: false requires skipPromote: true",
      );
    }).pipe(
      Effect.provide(computeProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
    );
  });

  it.effect("rejects conflicting branch attachment inputs", () => {
    const client = {} as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const error = yield* provider
        .reconcile({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            appName: "api",
            branchId: "branch-1",
            branchGitName: "main",
          },
          olds: undefined,
          output: undefined,
          session: undefined as never,
          bindings: [],
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "branchId and branchGitName are mutually exclusive",
      );
    }).pipe(
      Effect.provide(computeProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
    );
  });

  it.effect("rejects invalid production and dev ports", () => {
    const client = {} as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      for (const props of [
        { port: 0 },
        { port: 65_536 },
        { port: 1.5 },
        { dev: { port: Number.NaN } },
      ]) {
        const error = yield* provider
          .reconcile({
            id: "App",
            fqn: "App",
            instanceId: "00000000000000000000000000000000",
            news: {
              project: "project-1",
              appName: "api",
              ...props,
            },
            olds: undefined,
            output: undefined,
            session: undefined as never,
            bindings: [],
          })
          .pipe(Effect.flip);
        expect((error as Error).message).toContain(
          "must be an integer between 1 and 65535",
        );
      }
    }).pipe(
      Effect.provide(computeProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
    );
  });

  it.effect("rejects unassigned branch attachment for Compute deploys", () => {
    const client = {} as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      for (const branchProps of [{ branchId: null }, { branchGitName: null }]) {
        const error = yield* provider
          .reconcile({
            id: "App",
            fqn: "App",
            instanceId: "00000000000000000000000000000000",
            news: {
              project: "project-1",
              appName: "api",
              ...branchProps,
            } as unknown as ComputeProps,
            olds: undefined,
            output: undefined,
            session: undefined as never,
            bindings: [],
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(
          "requires an attached branch",
        );
      }
    }).pipe(
      Effect.provide(computeProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
    );
  });

  it.effect("rejects skipCodeUpload without a version to fork", () => {
    const calls: Array<[string, unknown]> = [];
    const client = {
      getApp: (id: string) => {
        calls.push(["getApp", id]);
        return Effect.succeed({
          id,
          type: "app" as const,
          url: `https://api.prisma.test/v1/apps/${id}`,
          name: "api",
          region: { id: "us-east-1", name: "US East" },
          projectId: "project-1",
          branchId: "branch-main",
          latestDeploymentId: null,
          appEndpointDomain: "api.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const error = yield* provider
        .reconcile({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            appName: "api",
            branchId: "branch-main",
            skipCodeUpload: true,
            start: false,
            skipPromote: true,
          },
          olds: undefined,
          output: {
            appId: "service-1",
            deploymentId: undefined,
            projectId: "project-1",
            appName: "api",
            regionId: "us-east-1",
            deploymentEndpointDomain: undefined,
            deploymentUrl: undefined,
            appEndpointDomain: "api.prisma.build",
            url: "https://api.prisma.build",
            promoted: false,
            previousDeploymentId: undefined,
            previousDeploymentAction: undefined,
            artifactHash: undefined,
            local: false,
          },
          session: undefined as never,
          bindings: [],
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "skipCodeUpload requires an existing Prisma deployment",
      );
      expect(calls).toEqual([["getApp", "service-1"]]);
    }).pipe(
      Effect.provide(computeProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
    );
  });

  it.effect("rejects effect-native Compute without a main module", () => {
    const client = {} as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const error = yield* provider
        .reconcile({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            appName: "api",
            exports: { default: "runtime" },
          },
          olds: undefined,
          output: undefined,
          session: undefined as never,
          bindings: [],
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "Effect-native Prisma Compute apps require `main`",
      );
    }).pipe(
      Effect.provide(computeProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
    );
  });

  it.effect("rejects effect-native Compute with an external build", () => {
    const client = {} as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const error = yield* provider
        .reconcile({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            appName: "api",
            main: "app.ts",
            build: {
              command: "bun run build",
              outdir: "dist",
            },
          },
          olds: undefined,
          output: undefined,
          session: undefined as never,
          bindings: [],
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "Effect-native Prisma Compute apps cannot use build",
      );
    }).pipe(
      Effect.provide(computeProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
    );
  });

  it.effect(
    "rejects effect-native Compute with an invalid handler name",
    () => {
      const client = {} as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const error = yield* provider
          .reconcile({
            id: "App",
            fqn: "App",
            instanceId: "00000000000000000000000000000000",
            news: {
              project: "project-1",
              appName: "api",
              main: "app.ts",
              handler: "Api;console.log('nope')",
            },
            olds: undefined,
            output: undefined,
            session: undefined as never,
            bindings: [],
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(
          "handler must be `default` or a valid JavaScript export identifier",
        );
      }).pipe(
        Effect.provide(computeProviderLive()),
        Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
      );
    },
  );

  it.effect(
    "replaces Compute when region changes even if project is unresolved",
    () => {
      const client = {} as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const error = yield* provider.diff!({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          olds: {
            project: "project-1",
            appName: "api",
            regionId: "us-east-1",
          },
          news: {
            project: Output.asOutput("project-1"),
            appName: "api",
            regionId: "us-west-2",
          },
          oldBindings: [],
          newBindings: [],
          output: {
            appId: "service-1",
            deploymentId: "version-1",
            projectId: "project-1",
            appName: "api",
            regionId: "us-east-1",
            deploymentEndpointDomain: "version-1.preview.prisma.build",
            deploymentUrl: "https://version-1.preview.prisma.build",
            appEndpointDomain: "api.prisma.build",
            url: "https://api.prisma.build",
            promoted: true,
            previousDeploymentId: undefined,
            previousDeploymentAction: undefined,
            artifactHash: Redacted.make("hash-1"),
            local: false,
          },
        } as never).pipe(Effect.flip);

        expect(String(error)).toContain("cannot be changed atomically");
      }).pipe(
        Effect.provide(computeProviderLive()),
        Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
      );
    },
  );

  it.effect(
    "replaces Compute when project changes even if region is unresolved",
    () => {
      const client = {} as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const diff = yield* provider.diff!({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          olds: {
            project: "project-1",
            appName: "api",
            regionId: "us-east-1",
          },
          news: {
            project: "project-2",
            appName: "api",
            regionId: Output.asOutput("us-east-1"),
          },
          oldBindings: [],
          newBindings: [],
          output: {
            appId: "service-1",
            deploymentId: "version-1",
            projectId: "project-1",
            appName: "api",
            regionId: "us-east-1",
            deploymentEndpointDomain: "version-1.preview.prisma.build",
            deploymentUrl: "https://version-1.preview.prisma.build",
            appEndpointDomain: "api.prisma.build",
            url: "https://api.prisma.build",
            promoted: true,
            previousDeploymentId: undefined,
            previousDeploymentAction: undefined,
            artifactHash: Redacted.make("hash-1"),
            local: false,
          },
        } as never);

        expect(diff).toEqual({ action: "replace" });
      }).pipe(
        Effect.provide(computeProviderLive()),
        Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
      );
    },
  );

  it.effect(
    "updates Compute when props are unchanged so artifacts can rehash",
    () => {
      const client = {} as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const diff = yield* provider.diff!({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          olds: {
            project: "project-1",
            appName: "api",
            regionId: "us-east-1",
            path: ".",
            entrypoint: "server.ts",
          },
          news: {
            project: "project-1",
            appName: "api",
            regionId: "us-east-1",
            path: ".",
            entrypoint: "server.ts",
          },
          oldBindings: [],
          newBindings: [],
          output: {
            appId: "service-1",
            deploymentId: "version-1",
            projectId: "project-1",
            appName: "api",
            regionId: "us-east-1",
            deploymentEndpointDomain: "version-1.preview.prisma.build",
            deploymentUrl: "https://version-1.preview.prisma.build",
            appEndpointDomain: "api.prisma.build",
            url: "https://api.prisma.build",
            promoted: true,
            previousDeploymentId: undefined,
            previousDeploymentAction: undefined,
            artifactHash: Redacted.make("hash-1"),
            local: false,
          },
        } as never);

        expect(diff).toEqual({ action: "update" });
      }).pipe(
        Effect.provide(computeProviderLive()),
        Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
      );
    },
  );

  it.effect("dev provider applies the same Compute prop validation", () =>
    Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const error = yield* provider
        .reconcile({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            appName: "api",
            skipPromote: true,
            destroyOldDeployment: true,
            dev: {
              url: "http://localhost:3000",
            },
          },
          olds: undefined,
          output: undefined,
          session: undefined as never,
          bindings: [],
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "destroyOldDeployment cannot be combined with skipPromote",
      );
    }).pipe(
      Effect.provide(ComputeDevProvider()),
      Effect.provide(
        Layer.succeed(AlchemyContext, {
          dotAlchemy: ".alchemy",
          dev: true,
          adopt: false,
        }),
      ),
      Effect.provide(PlatformServices),
    ),
  );

  it.effect(
    "adopts only the matching branch's latest deployment as Unowned",
    () => {
      const calls: Array<[string, unknown]> = [];
      const client = {
        listApps: (projectId: string, query: unknown) => {
          calls.push(["listApps", { projectId, query }]);
          return Effect.succeed([
            {
              id: "service-1",
              type: "app" as const,
              url: "https://api.prisma.test/v1/apps/service-1",
              name: "api",
              region: { id: "us-east-1", name: "US East" },
              projectId,
              branchId: "branch-main",
              latestDeploymentId: "version-live",
              appEndpointDomain: "api.prisma.build",
              createdAt: "2026-01-01T00:00:00Z",
            },
            {
              id: "service-feature",
              type: "app" as const,
              url: "https://api.prisma.test/v1/apps/service-feature",
              name: "api",
              region: { id: "us-east-1", name: "US East" },
              projectId,
              branchId: "branch-feature",
              latestDeploymentId: "version-feature",
              appEndpointDomain: "feature.prisma.build",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ]);
        },
        getDeployment: (id: string) => {
          calls.push(["getDeployment", id]);
          return Effect.succeed({
            id,
            type: "deployment" as const,
            url: `https://api.prisma.test/v1/deployments/${id}`,
            foundryVersionId: "foundry-live",
            status: "running",
            previewDomain: "version-live.preview.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
        listAppDeployments: () =>
          Effect.succeed([
            {
              id: "version-old",
              type: "deployment" as const,
              url: "https://api.prisma.test/v1/deployments/version-old",
              foundryVersionId: "foundry-version-old",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ]),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const output = yield* provider.read!({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          olds: {
            project: "project-1",
            appName: "api",
          },
          output: undefined,
        });

        expect(output?.appId).toBe("service-1");
        expect(output?.deploymentId).toBe("version-live");
        expect(output?.deploymentEndpointDomain).toBe(
          "version-live.preview.prisma.build",
        );
        expect(output?.deploymentUrl).toBe(
          "https://version-live.preview.prisma.build",
        );
        expect(output?.appEndpointDomain).toBe("api.prisma.build");
        expect(output?.url).toBe("https://api.prisma.build");
        expect(output?.promoted).toBe(true);
        expect(Unowned.is(output!)).toBe(true);
        expect(calls).toEqual([
          ["listApps", { projectId: "project-1", query: { limit: 100 } }],
          ["getDeployment", "version-live"],
        ]);
      }).pipe(
        Effect.provide(computeProviderLive()),
        Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect("reads the live deployment through the canonical route", () => {
    const calls: Array<[string, unknown]> = [];
    const client = {
      listApps: (projectId: string, query: unknown) => {
        calls.push(["listApps", { projectId, query }]);
        return Effect.succeed([
          {
            id: "service-1",
            type: "app" as const,
            url: "https://api.prisma.test/v1/apps/service-1",
            name: "api",
            region: { id: "us-east-1", name: "US East" },
            projectId,
            branchId: "branch-main",
            latestDeploymentId: "version-live",
            appEndpointDomain: "api.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ]);
      },
      getDeployment: (id: string) => {
        calls.push(["getDeployment", id]);
        return Effect.succeed({
          id,
          type: "deployment" as const,
          url: `https://api.prisma.test/v1/deployments/${id}`,
          foundryVersionId: "foundry-live",
          status: "running",
          previewDomain: "version-live.preview.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const output = yield* provider.read!({
        id: "App",
        fqn: "App",
        instanceId: "00000000000000000000000000000000",
        olds: {
          project: "project-1",
          appName: "api",
        },
        output: undefined,
      });

      expect(output?.deploymentId).toBe("version-live");
      expect(output?.promoted).toBe(true);
      expect(output?.deploymentUrl).toBe(
        "https://version-live.preview.prisma.build",
      );
      expect(calls).toEqual([
        ["listApps", { projectId: "project-1", query: { limit: 100 } }],
        ["getDeployment", "version-live"],
      ]);
    }).pipe(
      Effect.provide(computeProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect(
    "marks stored deployment unpromoted when live latest differs",
    () => {
      const calls: Array<[string, unknown]> = [];
      const client = {
        getApp: (id: string) => {
          calls.push(["getApp", id]);
          return Effect.succeed({
            id,
            type: "app" as const,
            url: "https://api.prisma.test/v1/apps/service-1",
            name: "api",
            region: { id: "us-east-1", name: "US East" },
            projectId: "project-1",
            branchId: "branch-main",
            latestDeploymentId: "version-live",
            appEndpointDomain: "api.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
        getDeployment: (id: string) => {
          calls.push(["getDeployment", id]);
          return Effect.succeed({
            id,
            type: "deployment" as const,
            url: `https://api.prisma.test/v1/deployments/${id}`,
            foundryVersionId: `foundry-${id}`,
            status: "running",
            previewDomain: `${id}.preview.prisma.build`,
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
        listAppDeployments: () =>
          Effect.succeed([
            {
              id: "version-old",
              type: "deployment" as const,
              url: "https://api.prisma.test/v1/deployments/version-old",
              foundryVersionId: "foundry-version-old",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ]),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const output = yield* provider.read!({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          olds: {
            project: "project-1",
            appName: "api",
          },
          output: {
            appId: "service-1",
            deploymentId: "version-old",
            projectId: "project-1",
            appName: "api",
            regionId: "us-east-1",
            deploymentEndpointDomain: "version-old.preview.prisma.build",
            deploymentUrl: "https://version-old.preview.prisma.build",
            appEndpointDomain: "api.prisma.build",
            url: "https://api.prisma.build",
            promoted: true,
            previousDeploymentId: undefined,
            previousDeploymentAction: undefined,
            artifactHash: Redacted.make("hash-old"),
            local: false,
          },
        });

        expect(output?.deploymentId).toBe("version-old");
        expect(output?.promoted).toBe(false);
        expect(output?.deploymentEndpointDomain).toBe(
          "version-old.preview.prisma.build",
        );
        expect(output?.url).toBe("https://version-old.preview.prisma.build");
        expect(calls).toEqual([
          ["getApp", "service-1"],
          ["getDeployment", "version-old"],
        ]);
      }).pipe(
        Effect.provide(computeProviderLive()),
        Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect("returns the preview URL for unpromoted Compute deploys", () => {
    const calls: Array<[string, unknown?]> = [];
    let status = "new";
    const client = {
      getApp: (id: string) => {
        calls.push(["getApp", id]);
        return Effect.succeed({
          id,
          type: "app" as const,
          url: "https://api.prisma.test/v1/apps/service-1",
          name: "api",
          region: { id: "us-east-1", name: "US East" },
          projectId: "project-1",
          branchId: "branch-main",
          latestDeploymentId: "version-live",
          appEndpointDomain: "api.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      listEnvironmentVariables: () => Effect.succeed([]),
      createAppDeployment: (appId: string, input: unknown) => {
        calls.push(["createAppDeployment", { appId, input }]);
        return Effect.succeed({
          id: "version-new",
          type: "deployment" as const,
          url: "https://api.prisma.test/v1/deployments/version-new",
          foundryVersionId: "foundry-new",
          uploadUrl: null,
        });
      },
      getDeployment: (id: string) => {
        calls.push(["getDeployment", id]);
        return Effect.succeed({
          id,
          type: "deployment" as const,
          url: `https://api.prisma.test/v1/deployments/${id}`,
          foundryVersionId: `foundry-${id}`,
          status,
          previewDomain: "version-new.preview.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      startDeployment: (id: string) =>
        Effect.sync(() => {
          calls.push(["startDeployment", id]);
          status = "running";
          return { previewDomain: "version-new.preview.prisma.build" };
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const output = yield* provider.reconcile({
        id: "App",
        fqn: "App",
        instanceId: "00000000000000000000000000000000",
        news: {
          project: "project-1",
          appName: "api",
          branchId: "branch-main",
          skipCodeUpload: true,
          skipPromote: true,
          verifyUrl: false,
        },
        olds: undefined,
        output: {
          appId: "service-1",
          deploymentId: undefined,
          projectId: "project-1",
          appName: "api",
          regionId: "us-east-1",
          deploymentEndpointDomain: undefined,
          deploymentUrl: undefined,
          appEndpointDomain: "api.prisma.build",
          url: "https://api.prisma.build",
          promoted: true,
          previousDeploymentId: undefined,
          previousDeploymentAction: undefined,
          artifactHash: undefined,
          local: false,
        },
        session: undefined as never,
        bindings: [],
      });

      expect(output.promoted).toBe(false);
      expect(output.deploymentUrl).toBe(
        "https://version-new.preview.prisma.build",
      );
      expect(output.appEndpointDomain).toBe("api.prisma.build");
      expect(output.url).toBe("https://version-new.preview.prisma.build");
      expect(calls).toEqual([
        ["getApp", "service-1"],
        [
          "createAppDeployment",
          {
            appId: "service-1",
            input: { portMapping: { http: 8080 }, skipCodeUpload: true },
          },
        ],
        ["getDeployment", "version-new"],
        ["startDeployment", "version-new"],
        ["getDeployment", "version-new"],
      ]);
    }).pipe(
      Effect.provide(computeProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect(
    "syncs a newly created service branch before creating a version",
    () => {
      const calls: Array<[string, unknown]> = [];
      const client = {
        listApps: (projectId: string, query: unknown) => {
          calls.push(["listApps", { projectId, query }]);
          return Effect.succeed([]);
        },
        createApp: (projectId: string, input: unknown) => {
          calls.push(["createApp", { projectId, input }]);
          return Effect.succeed({
            id: "service-1",
            type: "app" as const,
            url: "https://api.prisma.test/v1/apps/service-1",
            name: "api",
            region: { id: "us-east-1", name: "US East" },
            projectId,
            branchId: null,
            latestDeploymentId: null,
            appEndpointDomain: "api.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
        updateApp: (id: string, input: unknown) => {
          calls.push(["updateApp", { id, input }]);
          return Effect.succeed({
            id,
            type: "app" as const,
            url: "https://api.prisma.test/v1/apps/service-1",
            name: "api",
            region: { id: "us-east-1", name: "US East" },
            projectId: "project-1",
            branchId: "branch-main",
            latestDeploymentId: null,
            appEndpointDomain: "api.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
        createAppDeployment: (appId: string, input: unknown) => {
          calls.push(["createAppDeployment", { appId, input }]);
          return Effect.succeed({
            id: "version-1",
            type: "deployment" as const,
            url: "https://api.prisma.test/v1/deployments/version-1",
            foundryVersionId: "foundry-1",
            uploadUrl: "https://upload.prisma.test/version-1.tar.gz",
          });
        },
        getDeployment: (id: string) => {
          calls.push(["getDeployment", id]);
          return Effect.succeed({
            id,
            type: "deployment" as const,
            url: "https://api.prisma.test/v1/deployments/version-1",
            foundryVersionId: "foundry-1",
            status: "new",
            previewDomain: "version-1.preview.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
      } as unknown as PrismaManagementClient;
      const http = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null))),
      );
      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const output = yield* provider.reconcile({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            appName: "api",
            branchId: "branch-main",
            artifactPath: fixtureArtifactPath,
            start: false,
            skipPromote: true,
          },
          olds: undefined,
          output: undefined,
          session: undefined as never,
          bindings: [],
        });

        expect(output.appId).toBe("service-1");
        expect(output.deploymentId).toBe("version-1");
        expect(calls).toContainEqual([
          "createApp",
          {
            projectId: "project-1",
            input: {
              displayName: "api",
              regionId: undefined,
              branchId: "branch-main",
              branchGitName: undefined,
            },
          },
        ]);
        expect(calls).toContainEqual([
          "updateApp",
          {
            id: "service-1",
            input: {
              displayName: "api",
              branchId: "branch-main",
              branchGitName: undefined,
            },
          },
        ]);
        const updateIndex = calls.findIndex(([name]) => name === "updateApp");
        const versionIndex = calls.findIndex(
          ([name]) => name === "createAppDeployment",
        );
        expect(updateIndex).toBeGreaterThan(-1);
        expect(versionIndex).toBeGreaterThan(updateIndex);
      }).pipe(
        Effect.provide(computeProviderLive()),
        Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
        Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect(
    "creates a new version when branch attachment changes without artifact changes",
    () => {
      const calls: Array<[string, unknown]> = [];
      let branchId: string | null = "branch-main";
      let versionCounter = 0;

      const service = () => ({
        id: "service-1",
        type: "app" as const,
        url: "https://api.prisma.test/v1/apps/service-1",
        name: "api",
        region: { id: "us-east-1", name: "US East" },
        projectId: "project-1",
        branchId,
        latestDeploymentId: "version-seed",
        appEndpointDomain: "api.prisma.build",
        createdAt: "2026-01-01T00:00:00Z",
      });

      const client = {
        getApp: (id: string) => {
          calls.push(["getApp", id]);
          return Effect.succeed(service());
        },
        updateApp: (id: string, input: { branchId?: string | null }) => {
          calls.push(["updateApp", { id, input }]);
          branchId = input.branchId ?? null;
          return Effect.succeed(service());
        },
        createAppDeployment: (appId: string, input: unknown) => {
          versionCounter += 1;
          const id = `version-${versionCounter}`;
          calls.push(["createAppDeployment", { appId, input, id }]);
          return Effect.succeed({
            id,
            type: "deployment" as const,
            url: `https://api.prisma.test/v1/deployments/${id}`,
            foundryVersionId: `foundry-${versionCounter}`,
            uploadUrl: null,
          });
        },
        getDeployment: (id: string) => {
          calls.push(["getDeployment", id]);
          return Effect.succeed({
            id,
            type: "deployment" as const,
            url: `https://api.prisma.test/v1/deployments/${id}`,
            foundryVersionId: id.replace("version", "foundry"),
            status: "new",
            previewDomain: `${id}.preview.prisma.build`,
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
      } as unknown as PrismaManagementClient;

      const baseProps = {
        project: "project-1",
        appName: "api",
        branchId: "branch-main",
        skipCodeUpload: true,
        start: false,
        skipPromote: true,
      };

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const first = yield* provider.reconcile({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          news: baseProps,
          olds: undefined,
          output: {
            appId: "service-1",
            deploymentId: undefined,
            projectId: "project-1",
            appName: "api",
            regionId: "us-east-1",
            deploymentEndpointDomain: undefined,
            deploymentUrl: undefined,
            appEndpointDomain: "api.prisma.build",
            url: "https://api.prisma.build",
            promoted: false,
            previousDeploymentId: undefined,
            previousDeploymentAction: undefined,
            artifactHash: undefined,
            local: false,
          },
          session: undefined as never,
          bindings: [],
        });

        const second = yield* provider.reconcile({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          news: { ...baseProps, branchId: "branch-feature" },
          olds: baseProps,
          output: first,
          session: undefined as never,
          bindings: [],
        });

        expect(first.deploymentId).toBe("version-1");
        expect(second.deploymentId).toBe("version-2");
        expect(second.artifactHash).not.toBe(first.artifactHash);
        expect(calls).toContainEqual([
          "updateApp",
          {
            id: "service-1",
            input: {
              displayName: "api",
              branchId: "branch-feature",
              branchGitName: undefined,
            },
          },
        ]);
        expect(
          calls.filter(([name]) => name === "createAppDeployment"),
        ).toHaveLength(2);
      }).pipe(
        Effect.provide(computeProviderLive()),
        Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
      );
    },
  );

  it.effect(
    "does not mutate remote Compute state when artifact resolution fails",
    () => {
      const calls: Array<[string, unknown?]> = [];
      const client = {
        listApps: (projectId: string, query: unknown) => {
          calls.push(["listApps", { projectId, query }]);
          return Effect.succeed([]);
        },
        createApp: (projectId: string, input: unknown) => {
          calls.push(["createApp", { projectId, input }]);
          return Effect.die("should not create service");
        },
        listEnvironmentVariables: (query: unknown) => {
          calls.push(["listEnvironmentVariables", query]);
          return Effect.succeed([]);
        },
        createEnvironmentVariable: (input: unknown) => {
          calls.push(["createEnvironmentVariable", input]);
          return Effect.die("should not create env");
        },
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const path = yield* Path.Path;
        const missingArtifact = path.resolve(
          "tmp",
          "alchemy-prisma-missing-artifact.tar.gz",
        );

        const provider = yield* Compute.Provider;
        const error = yield* provider
          .reconcile({
            id: "App",
            fqn: "App",
            instanceId: "00000000000000000000000000000000",
            news: {
              project: "project-1",
              appName: "api",
              artifactPath: missingArtifact,
              env: {
                TOKEN: "secret",
              },
            },
            olds: undefined,
            output: undefined,
            session: undefined as never,
            bindings: [],
          })
          .pipe(Effect.flip);

        expect(error).toBeDefined();
        expect(calls).toEqual([]);
      }).pipe(
        Effect.provide(computeProviderLive()),
        Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect("forwards command build output limits before cloud mutation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-build-limit-",
      });
      const provider = yield* Compute.Provider;
      const error = yield* provider
        .reconcile({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            appName: "api",
            path: root,
            build: {
              command: "mkdir -p dist; printf '123456789'",
              outdir: "dist",
              entrypoint: "server.js",
              outputLimitBytes: 8,
            },
          },
          olds: undefined,
          output: undefined,
          session: undefined as never,
          bindings: [],
        })
        .pipe(Effect.flip);

      expect((error as Error).message).toContain(
        "Build stdout exceeded the 8 byte output safety limit",
      );
    }).pipe(
      Effect.provide(computeProviderLive()),
      Effect.provide(
        Layer.succeed(
          PrismaClient,
          withDefaultBranch({} as PrismaManagementClient),
        ),
      ),
      Effect.provide(PlatformServices),
    ),
  );

  it.effect("fails when Prisma omits an upload URL for app artifacts", () => {
    const calls: Array<[string, unknown?]> = [];
    const client = {
      getApp: () => {
        calls.push(["getApp"]);
        return Effect.succeed({
          id: "service-1",
          type: "app" as const,
          url: "https://api.prisma.test/v1/apps/service-1",
          name: "api",
          region: { id: "us-east-1", name: "US East" },
          projectId: "project-1",
          branchId: "branch-main",
          latestDeploymentId: "version-old",
          appEndpointDomain: "api.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      listEnvironmentVariables: () => Effect.succeed([]),
      createAppDeployment: () => {
        calls.push(["createAppDeployment"]);
        return Effect.succeed({
          id: "version-1",
          type: "deployment" as const,
          url: "https://api.prisma.test/v1/deployments/version-1",
          foundryVersionId: "foundry-1",
          uploadUrl: null,
        });
      },
      getDeployment: (id: string) => {
        calls.push(["getDeployment", id]);
        return Effect.succeed({
          id,
          type: "deployment" as const,
          url: `https://api.prisma.test/v1/deployments/${id}`,
          foundryVersionId: "foundry-1",
          status: "new",
          previewDomain: null,
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      deleteDeployment: (id: string) => {
        calls.push(["deleteDeployment", id]);
        return Effect.void;
      },
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const error = yield* provider
        .reconcile({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            appName: "api",
            artifactPath: fixtureArtifactPath,
            branchId: "branch-main",
            start: false,
            skipPromote: true,
          },
          olds: undefined,
          output: {
            appId: "service-1",
            deploymentId: undefined,
            projectId: "project-1",
            appName: "api",
            regionId: "us-east-1",
            deploymentEndpointDomain: undefined,
            deploymentUrl: undefined,
            appEndpointDomain: "api.prisma.build",
            url: "https://api.prisma.build",
            promoted: false,
            previousDeploymentId: undefined,
            previousDeploymentAction: undefined,
            artifactHash: undefined,
            local: false,
          },
          session: undefined as never,
          bindings: [],
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "did not return an upload URL",
      );
      expect(calls).toContainEqual(["deleteDeployment", "version-1"]);
    }).pipe(
      Effect.provide(computeProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
      Effect.provide(PlatformServices),
    );
  });

  it.effect(
    "refuses a persisted App with mismatched immutable identity",
    () => {
      const calls: string[] = [];
      const client = {
        getApp: () => {
          calls.push("getApp");
          return Effect.succeed({
            id: "service-1",
            type: "app" as const,
            url: "https://api.prisma.test/v1/apps/service-1",
            name: "api",
            region: { id: "us-east-1", name: "US East" },
            projectId: "project-other",
            branchId: "branch-main",
            latestDeploymentId: null,
            appEndpointDomain: "api.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
        updateApp: () => Effect.die("must not patch immutable identity drift"),
        createAppDeployment: () =>
          Effect.die("must not deploy against immutable identity drift"),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const error = yield* provider
          .reconcile({
            id: "App",
            fqn: "App",
            instanceId: "00000000000000000000000000000000",
            news: {
              project: "project-1",
              appName: "api",
              artifactPath: fixtureArtifactPath,
              branchId: "branch-main",
              start: false,
              skipPromote: true,
            },
            olds: undefined,
            output: {
              appId: "service-1",
              deploymentId: undefined,
              projectId: "project-1",
              appName: "api",
              regionId: "us-east-1",
              deploymentEndpointDomain: undefined,
              deploymentUrl: undefined,
              appEndpointDomain: "api.prisma.build",
              url: "https://api.prisma.build",
              promoted: false,
              previousDeploymentId: undefined,
              previousDeploymentAction: undefined,
              artifactHash: undefined,
              local: false,
            },
            session: undefined as never,
            bindings: [],
          })
          .pipe(Effect.flip);

        expect((error as Error).message).toContain("project-other");
        expect((error as Error).message).toContain("Refusing to patch");
        expect(calls).toEqual(["getApp"]);
      }).pipe(
        Effect.provide(computeProviderLive()),
        Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect(
    "deletes a newly created App when a later create step fails",
    () => {
      const calls: Array<[string, unknown?]> = [];
      const client = {
        listApps: (projectId: string, query: unknown) => {
          calls.push(["listApps", { projectId, query }]);
          return Effect.succeed([]);
        },
        createApp: (projectId: string, input: unknown) => {
          calls.push(["createApp", { projectId, input }]);
          return Effect.succeed({
            id: "service-1",
            type: "app" as const,
            url: "https://api.prisma.test/v1/apps/service-1",
            name: "api",
            region: { id: "us-east-1", name: "US East" },
            projectId,
            branchId: "branch-main",
            latestDeploymentId: null,
            appEndpointDomain: "api.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
        listEnvironmentVariables: () => Effect.succeed([]),
        createAppDeployment: () => {
          calls.push(["createAppDeployment"]);
          return Effect.succeed({
            id: "version-1",
            type: "deployment" as const,
            url: "https://api.prisma.test/v1/deployments/version-1",
            foundryVersionId: "foundry-1",
            uploadUrl: null,
          });
        },
        getDeployment: (id: string) => {
          calls.push(["getDeployment", id]);
          return Effect.succeed({
            id,
            type: "deployment" as const,
            url: `https://api.prisma.test/v1/deployments/${id}`,
            foundryVersionId: "foundry-1",
            status: "new",
            previewDomain: null,
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
        deleteDeployment: (id: string) => {
          calls.push(["deleteDeployment", id]);
          return Effect.void;
        },
        listAppDeployments: (appId: string) => {
          calls.push(["listAppDeployments", appId]);
          return Effect.succeed([]);
        },
        deleteApp: (id: string) => {
          calls.push(["deleteApp", id]);
          return Effect.void;
        },
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const error = yield* provider
          .reconcile({
            id: "App",
            fqn: "App",
            instanceId: "00000000000000000000000000000000",
            news: {
              project: "project-1",
              appName: "api",
              artifactPath: fixtureArtifactPath,
              branchId: "branch-main",
              start: false,
              skipPromote: true,
            },
            olds: undefined,
            output: undefined,
            session: undefined as never,
            bindings: [],
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(
          "did not return an upload URL",
        );
        expect(calls).toContainEqual(["deleteDeployment", "version-1"]);
        expect(calls).toContainEqual(["deleteApp", "service-1"]);
      }).pipe(
        Effect.provide(computeProviderLive()),
        Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect("deletes created deployment when artifact upload fails", () => {
    const calls: Array<[string, unknown?]> = [];
    const client = {
      getApp: () =>
        Effect.succeed({
          id: "service-1",
          type: "app" as const,
          url: "https://api.prisma.test/v1/apps/service-1",
          name: "api",
          region: { id: "us-east-1", name: "US East" },
          projectId: "project-1",
          branchId: "branch-main",
          latestDeploymentId: null,
          appEndpointDomain: "api.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        }),
      listEnvironmentVariables: () => Effect.succeed([]),
      createAppDeployment: () => {
        calls.push(["createAppDeployment"]);
        return Effect.succeed({
          id: "version-1",
          type: "deployment" as const,
          url: "https://api.prisma.test/v1/deployments/version-1",
          foundryVersionId: "foundry-1",
          uploadUrl: "https://upload.prisma.test/app.tar.gz",
        });
      },
      getDeployment: (id: string) => {
        calls.push(["getDeployment", id]);
        return Effect.succeed({
          id,
          type: "deployment" as const,
          url: `https://api.prisma.test/v1/deployments/${id}`,
          foundryVersionId: "foundry-1",
          status: "new",
          previewDomain: null,
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      deleteDeployment: (id: string) => {
        calls.push(["deleteDeployment", id]);
        return Effect.void;
      },
    } as unknown as PrismaManagementClient;
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response("upload failed", { status: 500 }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const error = yield* provider
        .reconcile({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            appName: "api",
            artifactPath: fixtureArtifactPath,
            branchId: "branch-main",
            start: false,
            skipPromote: true,
          },
          olds: undefined,
          output: {
            appId: "service-1",
            deploymentId: undefined,
            projectId: "project-1",
            appName: "api",
            regionId: "us-east-1",
            deploymentEndpointDomain: undefined,
            deploymentUrl: undefined,
            appEndpointDomain: "api.prisma.build",
            url: "https://api.prisma.build",
            promoted: false,
            previousDeploymentId: undefined,
            previousDeploymentAction: undefined,
            artifactHash: undefined,
            local: false,
          },
          session: undefined as never,
          bindings: [],
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("artifact upload failed");
      expect(calls).toContainEqual(["deleteDeployment", "version-1"]);
    }).pipe(
      Effect.provide(computeProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("deletes created deployment when start fails", () => {
    const calls: Array<[string, unknown?]> = [];
    const client = {
      getApp: (id: string) => {
        calls.push(["getApp", id]);
        return Effect.succeed({
          id,
          type: "app" as const,
          url: `https://api.prisma.test/v1/apps/${id}`,
          name: "api",
          region: { id: "us-east-1", name: "US East" },
          projectId: "project-1",
          branchId: "branch-main",
          latestDeploymentId: "version-old",
          appEndpointDomain: "api.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      createAppDeployment: (appId: string, input: unknown) => {
        calls.push(["createAppDeployment", { appId, input }]);
        return Effect.succeed({
          id: "version-1",
          type: "deployment" as const,
          url: "https://api.prisma.test/v1/deployments/version-1",
          foundryVersionId: "foundry-1",
          uploadUrl: "https://upload.prisma.test/app.tar.gz",
        });
      },
      getDeployment: (id: string) => {
        calls.push(["getDeployment", id]);
        return Effect.succeed({
          id,
          type: "deployment" as const,
          url: `https://api.prisma.test/v1/deployments/${id}`,
          foundryVersionId: "foundry-1",
          status: "new",
          previewDomain: null,
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      startDeployment: (id: string) => {
        calls.push(["startDeployment", id]);
        return Effect.fail(
          new PrismaApiError({
            method: "POST",
            path: `/v1/deployments/${id}/start`,
            status: 500,
            message: "start failed",
          }),
        );
      },
      deleteDeployment: (id: string) => {
        calls.push(["deleteDeployment", id]);
        return Effect.void;
      },
    } as unknown as PrismaManagementClient;
    const http = HttpClient.make((request) =>
      readHttpBodyBytes(request.body as HttpBody.HttpBody).pipe(
        Effect.as(HttpClientResponse.fromWeb(request, new Response(null))),
      ),
    );

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const error = yield* provider
        .reconcile({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            appName: "api",
            artifactPath: fixtureArtifactPath,
            branchId: "branch-main",
          },
          olds: undefined,
          output: {
            appId: "service-1",
            deploymentId: undefined,
            projectId: "project-1",
            appName: "api",
            regionId: "us-east-1",
            deploymentEndpointDomain: undefined,
            deploymentUrl: undefined,
            appEndpointDomain: "api.prisma.build",
            url: "https://api.prisma.build",
            promoted: false,
            previousDeploymentId: undefined,
            previousDeploymentAction: undefined,
            artifactHash: undefined,
            local: false,
          },
          session: undefined as never,
          bindings: [],
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(PrismaApiError);
      expect((error as PrismaApiError).message).toBe("start failed");
      expect(calls).toContainEqual(["deleteDeployment", "version-1"]);
    }).pipe(
      Effect.provide(computeProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
      Effect.provide(PlatformServices),
    );
  });

  it.live(
    "blocks promotion and deletes a new deployment when preview health fails",
    () => {
      const fixture = makeHealthLifecycleFixture({ previewStatus: 503 });

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const error = yield* provider
          .reconcile({
            id: "App",
            fqn: "App",
            instanceId: "00000000000000000000000000000000",
            news: {
              project: "project-1",
              appName: "api",
              artifactPath: fixtureArtifactV2Path,
              branchId: "branch-main",
              healthCheck: { path: "/health" },
              pollIntervalMs: 1,
              timeoutSeconds: 0.05,
              urlReadinessTimeoutSeconds: 0.02,
            },
            olds: {
              project: "project-1",
              appName: "api",
              artifactPath: fixtureArtifactV1Path,
              branchId: "branch-main",
            },
            output: {
              appId: "service-1",
              deploymentId: "version-old",
              projectId: "project-1",
              appName: "api",
              regionId: "us-east-1",
              deploymentEndpointDomain: "version-old.preview.prisma.build",
              deploymentUrl: "https://version-old.preview.prisma.build",
              appEndpointDomain: "api.prisma.build",
              url: "https://api.prisma.build",
              promoted: true,
              previousDeploymentId: undefined,
              previousDeploymentAction: undefined,
              artifactHash: Redacted.make("old-hash"),
              local: false,
            },
            session: undefined as never,
            bindings: [],
          })
          .pipe(Effect.flip);

        expect((error as Error).message).toContain(
          "https://version-new.preview.prisma.build/health",
        );
        expect((error as Error).message).toContain("HTTP 503");
        expect(
          fixture.calls.filter(([operation]) => operation === "promoteApp"),
        ).toEqual([]);
        expect(fixture.calls).toContainEqual(["stopDeployment", "version-new"]);
        expect(fixture.calls).toContainEqual([
          "deleteDeployment",
          "version-new",
        ]);
        expect(fixture.hasDeployment("version-new")).toBe(false);
        expect(fixture.hasDeployment("version-old")).toBe(true);
        expect(fixture.latestDeploymentId()).toBe("version-old");
      }).pipe(
        Effect.provide(computeProviderLive()),
        Effect.provide(
          Layer.succeed(PrismaClient, withDefaultBranch(fixture.client)),
        ),
        Effect.provideService(HttpClient.HttpClient, fixture.http),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.live(
    "rolls back promotion and deletes the new deployment when stable health fails",
    () => {
      const fixture = makeHealthLifecycleFixture({
        previewStatus: 204,
        stableStatus: 503,
      });

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const error = yield* provider
          .reconcile({
            id: "App",
            fqn: "App",
            instanceId: "00000000000000000000000000000000",
            news: {
              project: "project-1",
              appName: "api",
              artifactPath: fixtureArtifactV2Path,
              branchId: "branch-main",
              healthCheck: { path: "/health" },
              pollIntervalMs: 1,
              timeoutSeconds: 0.05,
              urlReadinessTimeoutSeconds: 0.02,
            },
            olds: {
              project: "project-1",
              appName: "api",
              artifactPath: fixtureArtifactV1Path,
              branchId: "branch-main",
            },
            output: {
              appId: "service-1",
              deploymentId: "version-old",
              projectId: "project-1",
              appName: "api",
              regionId: "us-east-1",
              deploymentEndpointDomain: "version-old.preview.prisma.build",
              deploymentUrl: "https://version-old.preview.prisma.build",
              appEndpointDomain: "api.prisma.build",
              url: "https://api.prisma.build",
              promoted: true,
              previousDeploymentId: undefined,
              previousDeploymentAction: undefined,
              artifactHash: Redacted.make("old-hash"),
              local: false,
            },
            session: undefined as never,
            bindings: [],
          })
          .pipe(Effect.flip);

        expect((error as Error).message).toContain(
          "https://api.prisma.build/health",
        );
        expect((error as Error).message).toContain("HTTP 503");
        expect(fixture.calls).toContainEqual([
          "promoteApp",
          { appId: "service-1", deploymentId: "version-new" },
        ]);
        expect(fixture.calls).toContainEqual([
          "rollbackApp",
          { appId: "service-1", deploymentId: "version-old" },
        ]);
        expect(fixture.calls).toContainEqual([
          "deleteDeployment",
          "version-new",
        ]);
        const promotionIndex = fixture.calls.findIndex(
          ([operation]) => operation === "promoteApp",
        );
        const rollbackIndex = fixture.calls.findIndex(
          ([operation]) => operation === "rollbackApp",
        );
        const deletionIndex = fixture.calls.findIndex(
          ([operation]) => operation === "deleteDeployment",
        );
        expect(promotionIndex).toBeLessThan(rollbackIndex);
        expect(rollbackIndex).toBeLessThan(deletionIndex);
        expect(fixture.hasDeployment("version-new")).toBe(false);
        expect(fixture.hasDeployment("version-old")).toBe(true);
        expect(fixture.latestDeploymentId()).toBe("version-old");
      }).pipe(
        Effect.provide(computeProviderLive()),
        Effect.provide(
          Layer.succeed(PrismaClient, withDefaultBranch(fixture.client)),
        ),
        Effect.provideService(HttpClient.HttpClient, fixture.http),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.live(
    "does not probe stable health after a successful promotion response that does not converge",
    () => {
      const fixture = makeHealthLifecycleFixture({
        previewStatus: 204,
        stableStatus: 204,
        promoteUpdatesLatest: false,
      });

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const error = yield* provider
          .reconcile({
            id: "App",
            fqn: "App",
            instanceId: "00000000000000000000000000000000",
            news: {
              project: "project-1",
              appName: "api",
              artifactPath: fixtureArtifactV2Path,
              branchId: "branch-main",
              healthCheck: { path: "/health" },
              pollIntervalMs: 1,
              timeoutSeconds: 0.02,
              urlReadinessTimeoutSeconds: 0.02,
            },
            olds: {
              project: "project-1",
              appName: "api",
              artifactPath: fixtureArtifactV1Path,
              branchId: "branch-main",
            },
            output: {
              appId: "service-1",
              deploymentId: "version-old",
              projectId: "project-1",
              appName: "api",
              regionId: "us-east-1",
              deploymentEndpointDomain: "version-old.preview.prisma.build",
              deploymentUrl: "https://version-old.preview.prisma.build",
              appEndpointDomain: "api.prisma.build",
              url: "https://api.prisma.build",
              promoted: true,
              previousDeploymentId: undefined,
              previousDeploymentAction: undefined,
              artifactHash: Redacted.make("old-hash"),
              local: false,
            },
            session: undefined as never,
            bindings: [],
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).message).toContain(
          "promotion returned success",
        );
        expect((error as AggregateError).message).toContain("did not converge");
        expect(fixture.latestDeploymentId()).toBe("version-old");
        expect(fixture.hasDeployment("version-new")).toBe(true);
        expect(
          fixture.calls.filter(
            ([operation, value]) =>
              operation === "healthRequest" &&
              value === "https://api.prisma.build/health",
          ),
        ).toEqual([]);
        expect(
          fixture.calls.filter(
            ([operation]) => operation === "deleteDeployment",
          ),
        ).toEqual([]);
      }).pipe(
        Effect.provide(computeProviderLive()),
        Effect.provide(
          Layer.succeed(PrismaClient, withDefaultBranch(fixture.client)),
        ),
        Effect.provideService(HttpClient.HttpClient, fixture.http),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.live(
    "does not delete a promoted deployment after a successful rollback response that does not converge",
    () => {
      const fixture = makeHealthLifecycleFixture({
        previewStatus: 204,
        stableStatus: 503,
        rollbackUpdatesLatest: false,
      });

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const error = yield* provider
          .reconcile({
            id: "App",
            fqn: "App",
            instanceId: "00000000000000000000000000000000",
            news: {
              project: "project-1",
              appName: "api",
              artifactPath: fixtureArtifactV2Path,
              branchId: "branch-main",
              healthCheck: { path: "/health" },
              pollIntervalMs: 1,
              timeoutSeconds: 0.02,
              urlReadinessTimeoutSeconds: 0.02,
            },
            olds: {
              project: "project-1",
              appName: "api",
              artifactPath: fixtureArtifactV1Path,
              branchId: "branch-main",
            },
            output: {
              appId: "service-1",
              deploymentId: "version-old",
              projectId: "project-1",
              appName: "api",
              regionId: "us-east-1",
              deploymentEndpointDomain: "version-old.preview.prisma.build",
              deploymentUrl: "https://version-old.preview.prisma.build",
              appEndpointDomain: "api.prisma.build",
              url: "https://api.prisma.build",
              promoted: true,
              previousDeploymentId: undefined,
              previousDeploymentAction: undefined,
              artifactHash: Redacted.make("old-hash"),
              local: false,
            },
            session: undefined as never,
            bindings: [],
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).message).toContain(
          "rollback to deployment 'version-old' did not converge",
        );
        expect(fixture.latestDeploymentId()).toBe("version-new");
        expect(fixture.hasDeployment("version-new")).toBe(true);
        expect(fixture.hasDeployment("version-old")).toBe(true);
        expect(
          fixture.calls.filter(
            ([operation]) => operation === "deleteDeployment",
          ),
        ).toEqual([]);
      }).pipe(
        Effect.provide(computeProviderLive()),
        Effect.provide(
          Layer.succeed(PrismaClient, withDefaultBranch(fixture.client)),
        ),
        Effect.provideService(HttpClient.HttpClient, fixture.http),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.live(
    "replaces a hash-matching terminal failed deployment before cleaning it",
    () => {
      const fixture = makeHealthLifecycleFixture({
        latestDeploymentId: null,
        previewStatus: 204,
        stableStatus: 204,
      });
      const news = {
        project: "project-1",
        appName: "api",
        artifactPath: fixtureArtifactV1Path,
        branchId: "branch-main",
        healthCheck: { path: "/health" },
        pollIntervalMs: 1,
        timeoutSeconds: 0.02,
        urlReadinessTimeoutSeconds: 0.02,
      } as const;

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const first = yield* provider.reconcile({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          news,
          olds: undefined,
          output: {
            appId: "service-1",
            deploymentId: undefined,
            projectId: "project-1",
            appName: "api",
            regionId: "us-east-1",
            deploymentEndpointDomain: undefined,
            deploymentUrl: undefined,
            appEndpointDomain: "api.prisma.build",
            url: undefined,
            promoted: false,
            previousDeploymentId: undefined,
            previousDeploymentAction: undefined,
            artifactHash: undefined,
            local: false,
          },
          session: undefined as never,
          bindings: [],
        });

        fixture.setDeploymentStatus("version-new", "failed");
        fixture.calls.splice(0);
        const recovered = yield* provider.reconcile({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          news,
          olds: news,
          output: first,
          session: undefined as never,
          bindings: [],
        });

        const replacementCreationIndex = fixture.calls.findIndex(
          ([operation]) => operation === "createAppDeployment",
        );
        const stableHealthIndex = fixture.calls.findIndex(
          ([operation, value]) =>
            operation === "healthRequest" &&
            value === "https://api.prisma.build/health",
        );
        const failedDeletionIndex = fixture.calls.findIndex(
          ([operation, value]) =>
            operation === "deleteDeployment" && value === "version-new",
        );

        expect(recovered.deploymentId).toBe("version-new-2");
        expect(recovered.promoted).toBe(true);
        expect(recovered.readinessStatus).toBe("ready");
        expect(recovered.previousDeploymentId).toBe("version-new");
        expect(recovered.previousDeploymentAction).toBe("destroyed");
        expect(replacementCreationIndex).toBeGreaterThanOrEqual(0);
        expect(stableHealthIndex).toBeGreaterThan(replacementCreationIndex);
        expect(failedDeletionIndex).toBeGreaterThan(stableHealthIndex);
        expect(fixture.hasDeployment("version-new")).toBe(false);
        expect(fixture.hasDeployment("version-new-2")).toBe(true);
        expect(
          fixture.calls.filter(
            ([operation, value]) =>
              operation === "startDeployment" && value === "version-new",
          ),
        ).toEqual([]);
      }).pipe(
        Effect.provide(computeProviderLive()),
        Effect.provide(
          Layer.succeed(PrismaClient, withDefaultBranch(fixture.client)),
        ),
        Effect.provideService(HttpClient.HttpClient, fixture.http),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.live(
    "destroys a changed-hash terminal failed deployment only after replacement convergence",
    () => {
      const fixture = makeHealthLifecycleFixture({
        previewStatus: 204,
        stableStatus: 204,
      });
      fixture.setDeploymentStatus("version-old", "failed");

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const output = yield* provider.reconcile({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            appName: "api",
            artifactPath: fixtureArtifactV2Path,
            branchId: "branch-main",
            healthCheck: { path: "/health" },
            pollIntervalMs: 1,
            timeoutSeconds: 0.02,
            urlReadinessTimeoutSeconds: 0.02,
          },
          olds: {
            project: "project-1",
            appName: "api",
            artifactPath: fixtureArtifactV1Path,
            branchId: "branch-main",
          },
          output: {
            appId: "service-1",
            deploymentId: "version-old",
            projectId: "project-1",
            appName: "api",
            regionId: "us-east-1",
            deploymentEndpointDomain: "version-old.preview.prisma.build",
            deploymentUrl: "https://version-old.preview.prisma.build",
            appEndpointDomain: "api.prisma.build",
            url: "https://api.prisma.build",
            promoted: true,
            previousDeploymentId: undefined,
            previousDeploymentAction: undefined,
            artifactHash: Redacted.make("old-hash"),
            local: false,
          },
          session: undefined as never,
          bindings: [],
        });

        const stableHealthIndex = fixture.calls.findIndex(
          ([operation, value]) =>
            operation === "healthRequest" &&
            value === "https://api.prisma.build/health",
        );
        const failedDeletionIndex = fixture.calls.findIndex(
          ([operation, value]) =>
            operation === "deleteDeployment" && value === "version-old",
        );

        expect(output.deploymentId).toBe("version-new");
        expect(output.previousDeploymentId).toBe("version-old");
        expect(output.previousDeploymentAction).toBe("destroyed");
        expect(stableHealthIndex).toBeGreaterThanOrEqual(0);
        expect(failedDeletionIndex).toBeGreaterThan(stableHealthIndex);
        expect(fixture.hasDeployment("version-old")).toBe(false);
        expect(fixture.hasDeployment("version-new")).toBe(true);
        expect(
          fixture.calls.filter(
            ([operation, value]) =>
              operation === "stopDeployment" && value === "version-old",
          ),
        ).toEqual([]);
      }).pipe(
        Effect.provide(computeProviderLive()),
        Effect.provide(
          Layer.succeed(PrismaClient, withDefaultBranch(fixture.client)),
        ),
        Effect.provideService(HttpClient.HttpClient, fixture.http),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.live(
    "never rolls back to a changed-hash terminal failed deployment and blocks duplicate retry creation",
    () => {
      const fixture = makeHealthLifecycleFixture({
        previewStatus: 204,
        stableStatus: 503,
      });
      fixture.setDeploymentStatus("version-old", "failed");
      const news = {
        project: "project-1",
        appName: "api",
        artifactPath: fixtureArtifactV2Path,
        branchId: "branch-main",
        healthCheck: { path: "/health" },
        pollIntervalMs: 1,
        timeoutSeconds: 0.02,
        urlReadinessTimeoutSeconds: 0.02,
      } as const;
      const olds = {
        project: "project-1",
        appName: "api",
        artifactPath: fixtureArtifactV1Path,
        branchId: "branch-main",
      } as const;
      const output = {
        appId: "service-1",
        deploymentId: "version-old",
        projectId: "project-1",
        appName: "api",
        regionId: "us-east-1",
        deploymentEndpointDomain: "version-old.preview.prisma.build",
        deploymentUrl: "https://version-old.preview.prisma.build",
        appEndpointDomain: "api.prisma.build",
        url: "https://api.prisma.build",
        promoted: true,
        previousDeploymentId: undefined,
        previousDeploymentAction: undefined,
        artifactHash: Redacted.make("old-hash"),
        local: false,
      } as const;

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const firstError = yield* provider
          .reconcile({
            id: "App",
            fqn: "App",
            instanceId: "00000000000000000000000000000000",
            news,
            olds,
            output,
            session: undefined as never,
            bindings: [],
          })
          .pipe(Effect.flip);

        expect(firstError).toBeInstanceOf(AggregateError);
        expect((firstError as AggregateError).message).toContain(
          "no safe rollback target exists",
        );
        expect(
          fixture.calls.filter(([operation]) => operation === "rollbackApp"),
        ).toEqual([]);
        expect(fixture.latestDeploymentId()).toBe("version-new");
        expect(fixture.hasDeployment("version-old")).toBe(true);
        expect(fixture.hasDeployment("version-new")).toBe(true);

        fixture.setStableStatus(204);
        const callsBeforeRetry = fixture.calls.length;
        const retryError = yield* provider
          .reconcile({
            id: "App",
            fqn: "App",
            instanceId: "00000000000000000000000000000000",
            news,
            olds,
            output,
            session: undefined as never,
            bindings: [],
          })
          .pipe(Effect.flip);
        const retryCalls = fixture.calls.slice(callsBeforeRetry);

        expect(retryError).toBeInstanceOf(AggregateError);
        expect((retryError as AggregateError).message).toContain(
          "cannot prove that the live deployment is the interrupted replacement",
        );
        expect(
          retryCalls.filter(
            ([operation]) => operation === "createAppDeployment",
          ),
        ).toEqual([]);
        expect(
          retryCalls.filter(([operation]) => operation === "rollbackApp"),
        ).toEqual([]);
        expect(
          retryCalls.filter(([operation]) => operation === "deleteDeployment"),
        ).toEqual([]);
        expect(fixture.latestDeploymentId()).toBe("version-new");
        expect(fixture.hasDeployment("version-old")).toBe(true);
        expect(fixture.hasDeployment("version-new")).toBe(true);
      }).pipe(
        Effect.provide(computeProviderLive()),
        Effect.provide(
          Layer.succeed(PrismaClient, withDefaultBranch(fixture.client)),
        ),
        Effect.provideService(HttpClient.HttpClient, fixture.http),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.live(
    "does not create another generation after failed terminal replacement loses a safe rollback target",
    () => {
      const fixture = makeHealthLifecycleFixture({
        latestDeploymentId: null,
        previewStatus: 204,
        stableStatus: 204,
      });
      const news = {
        project: "project-1",
        appName: "api",
        artifactPath: fixtureArtifactV1Path,
        branchId: "branch-main",
        healthCheck: { path: "/health" },
        pollIntervalMs: 1,
        timeoutSeconds: 0.02,
        urlReadinessTimeoutSeconds: 0.02,
      } as const;

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const first = yield* provider.reconcile({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          news,
          olds: undefined,
          output: {
            appId: "service-1",
            deploymentId: undefined,
            projectId: "project-1",
            appName: "api",
            regionId: "us-east-1",
            deploymentEndpointDomain: undefined,
            deploymentUrl: undefined,
            appEndpointDomain: "api.prisma.build",
            url: undefined,
            promoted: false,
            previousDeploymentId: undefined,
            previousDeploymentAction: undefined,
            artifactHash: undefined,
            local: false,
          },
          session: undefined as never,
          bindings: [],
        });

        fixture.setDeploymentStatus("version-new", "failed");
        fixture.setStableStatus(503);
        fixture.calls.splice(0);
        const replacementError = yield* provider
          .reconcile({
            id: "App",
            fqn: "App",
            instanceId: "00000000000000000000000000000000",
            news,
            olds: news,
            output: first,
            session: undefined as never,
            bindings: [],
          })
          .pipe(Effect.flip);

        expect(replacementError).toBeInstanceOf(AggregateError);
        expect((replacementError as AggregateError).message).toContain(
          "no safe rollback target exists",
        );
        expect(fixture.latestDeploymentId()).toBe("version-new-2");
        expect(fixture.hasDeployment("version-new")).toBe(true);
        expect(fixture.hasDeployment("version-new-2")).toBe(true);
        expect(
          fixture.calls.filter(
            ([operation]) => operation === "deleteDeployment",
          ),
        ).toEqual([]);

        fixture.setStableStatus(204);
        const callsBeforeRetry = fixture.calls.length;
        const retryError = yield* provider
          .reconcile({
            id: "App",
            fqn: "App",
            instanceId: "00000000000000000000000000000000",
            news,
            olds: news,
            output: first,
            session: undefined as never,
            bindings: [],
          })
          .pipe(Effect.flip);
        const retryCalls = fixture.calls.slice(callsBeforeRetry);

        expect(retryError).toBeInstanceOf(AggregateError);
        expect((retryError as AggregateError).message).toContain(
          "cannot prove that the live deployment is the interrupted replacement",
        );
        expect(
          retryCalls.filter(
            ([operation]) => operation === "createAppDeployment",
          ),
        ).toEqual([]);
        expect(
          retryCalls.filter(([operation]) => operation === "deleteDeployment"),
        ).toEqual([]);
        expect(fixture.latestDeploymentId()).toBe("version-new-2");
        expect(fixture.hasDeployment("version-new")).toBe(true);
        expect(fixture.hasDeployment("version-new-2")).toBe(true);
      }).pipe(
        Effect.provide(computeProviderLive()),
        Effect.provide(
          Layer.succeed(PrismaClient, withDefaultBranch(fixture.client)),
        ),
        Effect.provideService(HttpClient.HttpClient, fixture.http),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.live(
    "fails closed on rollback failure and recovers from persisted state before retrying",
    () => {
      const fixture = makeHealthLifecycleFixture({
        previewStatus: 204,
        stableStatus: 503,
        rollbackFailures: 2,
      });
      const news = {
        project: "project-1",
        appName: "api",
        artifactPath: fixtureArtifactV2Path,
        branchId: "branch-main",
        healthCheck: { path: "/health" },
        pollIntervalMs: 1,
        timeoutSeconds: 0.05,
        urlReadinessTimeoutSeconds: 0.02,
      } as const;
      const olds = {
        project: "project-1",
        appName: "api",
        artifactPath: fixtureArtifactV1Path,
        branchId: "branch-main",
      } as const;
      const output = {
        appId: "service-1",
        deploymentId: "version-old",
        projectId: "project-1",
        appName: "api",
        regionId: "us-east-1",
        deploymentEndpointDomain: "version-old.preview.prisma.build",
        deploymentUrl: "https://version-old.preview.prisma.build",
        appEndpointDomain: "api.prisma.build",
        url: "https://api.prisma.build",
        promoted: true,
        previousDeploymentId: undefined,
        previousDeploymentAction: undefined,
        artifactHash: Redacted.make("old-hash"),
        local: false,
      } as const;
      const reconcile = Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        return yield* provider.reconcile({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          news,
          olds,
          output,
          session: undefined as never,
          bindings: [],
        });
      });

      return Effect.gen(function* () {
        const firstError = yield* reconcile.pipe(Effect.flip);

        expect(firstError).toBeInstanceOf(AggregateError);
        expect((firstError as AggregateError).message).toContain(
          "promoted deployment 'version-new'",
        );
        expect((firstError as AggregateError).message).toContain(
          "rollback to deployment 'version-old' did not converge",
        );
        expect((firstError as AggregateError).message).toContain(
          "next reconcile will retry recovery",
        );
        expect(fixture.latestDeploymentId()).toBe("version-new");
        expect(fixture.hasDeployment("version-new")).toBe(true);
        expect(fixture.hasDeployment("version-old")).toBe(true);
        expect(
          fixture.calls.filter(
            ([operation]) => operation === "deleteDeployment",
          ),
        ).toEqual([]);

        fixture.setStableStatus(204);
        const callsBeforeBlockedRetry = fixture.calls.length;
        const retryError = yield* reconcile.pipe(Effect.flip);
        const blockedRetryCalls = fixture.calls.slice(callsBeforeBlockedRetry);

        expect(retryError).toBeInstanceOf(AggregateError);
        expect((retryError as AggregateError).message).toContain(
          "no environment variables or new deployment were changed",
        );
        expect(
          (retryError as AggregateError).errors.some(
            (error) =>
              error instanceof Error &&
              error.message === "rollback unavailable",
          ),
        ).toBe(true);
        expect(
          blockedRetryCalls.filter(
            ([operation]) => operation === "createAppDeployment",
          ),
        ).toEqual([]);
        expect(
          fixture.calls.filter(
            ([operation]) => operation === "createAppDeployment",
          ),
        ).toHaveLength(1);
        expect(fixture.latestDeploymentId()).toBe("version-new");
        expect(fixture.hasDeployment("version-new")).toBe(true);

        const callsBeforeRecovery = fixture.calls.length;
        const recovered = yield* reconcile;
        const recoveryCalls = fixture.calls.slice(callsBeforeRecovery);
        const rollbackIndex = recoveryCalls.findIndex(
          ([operation]) => operation === "rollbackApp",
        );
        const failedDeletionIndex = recoveryCalls.findIndex(
          ([operation, value]) =>
            operation === "deleteDeployment" && value === "version-new",
        );
        const replacementCreationIndex = recoveryCalls.findIndex(
          ([operation]) => operation === "createAppDeployment",
        );

        expect(recovered.deploymentId).toBe("version-new-2");
        expect(recovered.promoted).toBe(true);
        expect(recovered.readinessStatus).toBe("ready");
        expect(rollbackIndex).toBeGreaterThanOrEqual(0);
        expect(rollbackIndex).toBeLessThan(failedDeletionIndex);
        expect(failedDeletionIndex).toBeLessThan(replacementCreationIndex);
        expect(fixture.hasDeployment("version-new")).toBe(false);
        expect(fixture.hasDeployment("version-new-2")).toBe(true);
        expect(fixture.latestDeploymentId()).toBe("version-new-2");
        expect(
          fixture.calls.filter(
            ([operation]) => operation === "createAppDeployment",
          ),
        ).toHaveLength(2);
      }).pipe(
        Effect.provide(computeProviderLive()),
        Effect.provide(
          Layer.succeed(PrismaClient, withDefaultBranch(fixture.client)),
        ),
        Effect.provideService(HttpClient.HttpClient, fixture.http),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect(
    "honors custom accepted health statuses before and after promotion",
    () => {
      const fixture = makeHealthLifecycleFixture({
        latestDeploymentId: null,
        previewStatus: 302,
        stableStatus: 302,
      });

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const output = yield* provider.reconcile({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            appName: "api",
            artifactPath: fixtureArtifactV2Path,
            branchId: "branch-main",
            healthCheck: { path: "/ready", statusCodes: [302] },
            pollIntervalMs: 1,
            timeoutSeconds: 0.05,
            urlReadinessTimeoutSeconds: 0.02,
          },
          olds: undefined,
          output: {
            appId: "service-1",
            deploymentId: undefined,
            projectId: "project-1",
            appName: "api",
            regionId: "us-east-1",
            deploymentEndpointDomain: undefined,
            deploymentUrl: undefined,
            appEndpointDomain: "api.prisma.build",
            url: undefined,
            promoted: false,
            previousDeploymentId: undefined,
            previousDeploymentAction: undefined,
            artifactHash: undefined,
            local: false,
          },
          session: undefined as never,
          bindings: [],
        });

        expect(output.deploymentId).toBe("version-new");
        expect(output.promoted).toBe(true);
        expect(output.readinessStatus).toBe("ready");
        expect(
          fixture.calls.filter(([operation]) => operation === "healthRequest"),
        ).toEqual([
          ["healthRequest", "https://version-new.preview.prisma.build/ready"],
          ["healthRequest", "https://api.prisma.build/ready"],
        ]);
        expect(
          fixture.calls.filter(([operation]) => operation === "rollbackApp"),
        ).toEqual([]);
        expect(
          fixture.calls.filter(
            ([operation]) => operation === "deleteDeployment",
          ),
        ).toEqual([]);
      }).pipe(
        Effect.provide(computeProviderLive()),
        Effect.provide(
          Layer.succeed(PrismaClient, withDefaultBranch(fixture.client)),
        ),
        Effect.provideService(HttpClient.HttpClient, fixture.http),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect("uploads a pre-created artifact from artifactPath", () => {
    let uploaded:
      | { url: string; contentType: string | undefined; bytes: Uint8Array }
      | undefined;
    const client = {
      getApp: () =>
        Effect.succeed({
          id: "service-1",
          type: "app" as const,
          url: "https://api.prisma.test/v1/apps/service-1",
          name: "api",
          region: { id: "us-east-1", name: "US East" },
          projectId: "project-1",
          branchId: "branch-main",
          latestDeploymentId: "version-old",
          appEndpointDomain: "api.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        }),
      listEnvironmentVariables: () => Effect.succeed([]),
      createAppDeployment: () =>
        Effect.succeed({
          id: "version-1",
          type: "deployment" as const,
          url: "https://api.prisma.test/v1/deployments/version-1",
          foundryVersionId: "foundry-1",
          uploadUrl: "https://upload.prisma.test/app.tar.gz",
        }),
      getDeployment: (id: string) =>
        Effect.succeed({
          id,
          type: "deployment" as const,
          url: "https://api.prisma.test/v1/deployments/version-1",
          foundryVersionId: "foundry-1",
          status: "new",
          previewDomain: "version-1.preview.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        }),
    } as unknown as PrismaManagementClient;
    const http = HttpClient.make((request) =>
      Effect.gen(function* () {
        const body = request.body as HttpBody.HttpBody;
        uploaded = {
          url: request.url,
          contentType: httpBodyContentType(body),
          bytes: yield* readHttpBodyBytes(body),
        };
        return HttpClientResponse.fromWeb(request, new Response(null));
      }),
    );

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-artifact-",
      });
      const artifactPath = path.join(root, "app.tar.gz");
      yield* fs.writeFileString(artifactPath, "prebuilt-archive");

      const provider = yield* Compute.Provider;
      const output = yield* provider.reconcile({
        id: "App",
        fqn: "App",
        instanceId: "00000000000000000000000000000000",
        news: {
          project: "project-1",
          appName: "api",
          artifactPath,
          branchId: "branch-main",
          start: false,
          skipPromote: true,
        },
        olds: undefined,
        output: {
          appId: "service-1",
          deploymentId: undefined,
          projectId: "project-1",
          appName: "api",
          regionId: "us-east-1",
          deploymentEndpointDomain: undefined,
          deploymentUrl: undefined,
          appEndpointDomain: "api.prisma.build",
          url: "https://api.prisma.build",
          promoted: false,
          previousDeploymentId: undefined,
          previousDeploymentAction: undefined,
          artifactHash: undefined,
          local: false,
        },
        session: undefined as never,
        bindings: [],
      });

      expect(output.deploymentId).toBe("version-1");
      expect(uploaded?.url).toBe("https://upload.prisma.test/app.tar.gz");
      expect(uploaded?.contentType).toBe("application/gzip");
      expect(new TextDecoder().decode(uploaded?.bytes)).toBe(
        "prebuilt-archive",
      );
    }).pipe(
      Effect.provide(computeProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
      Effect.provide(PlatformServices),
    );
  });

  it.effect(
    "bundles effect-native Compute apps into an upload artifact",
    () => {
      const calls: Array<[string, unknown]> = [];
      let uploaded:
        | { url: string; contentType: string | undefined; bytes: Uint8Array }
        | undefined;
      const client = {
        listApps: (projectId: string, query: unknown) => {
          calls.push(["listApps", { projectId, query }]);
          return Effect.succeed([]);
        },
        createApp: (projectId: string, input: unknown) => {
          calls.push(["createApp", { projectId, input }]);
          return Effect.succeed({
            id: "service-1",
            type: "app" as const,
            url: "https://api.prisma.test/v1/apps/service-1",
            name: "api",
            region: { id: "us-east-1", name: "US East" },
            projectId,
            branchId: "branch-main",
            latestDeploymentId: "version-old",
            appEndpointDomain: "api.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
        listEnvironmentVariables: () => Effect.succeed([]),
        createAppDeployment: (appId: string, input: unknown) => {
          calls.push(["createAppDeployment", { appId, input }]);
          return Effect.succeed({
            id: "version-1",
            type: "deployment" as const,
            url: "https://api.prisma.test/v1/deployments/version-1",
            foundryVersionId: "foundry-1",
            uploadUrl: "https://upload.prisma.test/effect.tar.gz",
          });
        },
        getDeployment: (id: string) => {
          calls.push(["getDeployment", id]);
          return Effect.succeed({
            id,
            type: "deployment" as const,
            url: "https://api.prisma.test/v1/deployments/version-1",
            foundryVersionId: "foundry-1",
            status: "new",
            previewDomain: "version-1.preview.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
      } as unknown as PrismaManagementClient;
      const http = HttpClient.make((request) =>
        Effect.gen(function* () {
          const body = request.body as HttpBody.HttpBody;
          uploaded = {
            url: request.url,
            contentType: httpBodyContentType(body),
            bytes: yield* readHttpBodyBytes(body),
          };
          return HttpClientResponse.fromWeb(request, new Response(null));
        }),
      );

      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({
          prefix: "alchemy-prisma-compute-effect-",
        });
        const main = path.join(root, "app.ts");
        yield* fs.writeFileString(
          main,
          [
            'import * as Prisma from "alchemy/Prisma";',
            'import * as Effect from "effect/Effect";',
            'import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";',
            "",
            "export default Prisma.Compute(",
            '  "App",',
            "  {",
            '    project: "project-1",',
            '    appName: "api",',
            "    main: import.meta.filename,",
            "    port: 4555,",
            "  },",
            "  Effect.gen(function* () {",
            "    return {",
            '      fetch: HttpServerResponse.text("effect-native-ok"),',
            "    };",
            "  }),",
            ");",
            "",
          ].join("\n"),
        );

        const provider = yield* Compute.Provider;
        const output = yield* provider.reconcile({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            appName: "api",
            branchId: "branch-main",
            main,
            port: 4555,
            start: false,
            skipPromote: true,
          },
          olds: undefined,
          output: undefined,
          session: undefined as never,
          bindings: [],
        });

        expect(output.deploymentId).toBe("version-1");
        expect(uploaded?.url).toBe("https://upload.prisma.test/effect.tar.gz");
        expect(uploaded?.contentType).toBe("application/gzip");
        const tar = yield* Effect.sync(() => gunzipSync(uploaded!.bytes));
        const manifest = readTarFile(tar, "compute.manifest.json");
        const bundle = readTarFile(tar, "bundle/index.js");
        expect(JSON.parse(manifest)).toMatchObject({
          entrypoint: "bundle/index.js",
        });
        // The generated entry is a shim over alchemy/Runtime/Bootstrap/Prisma;
        // its label and the shared "bootstrap starting" message are separate
        // literals joined at runtime (see Runtime/Bootstrap/Process.ts).
        expect(bundle).toContain("Prisma Compute");
        expect(bundle).toContain("bootstrap starting");
        expect(bundle).toMatch(/hostname\s*:\s*["'`]0\.0\.0\.0["'`]/);
        // The deploy-time stack identity is baked into the artifact (the shim
        // passes it to the bootstrap once; the module fans it out to `Stack`
        // and `Stage`).
        expect(bundle).toContain("prisma-runtime-stack-sentinel");
        expect(bundle).toContain("prisma-runtime-stage-sentinel");
        expect(bundle).toContain("ALCHEMY_PHASE");
        expect(bundle).toContain("runtime");
        expect(bundle).toContain("effect-native-ok");
        expect(calls).toContainEqual([
          "createAppDeployment",
          {
            appId: "service-1",
            input: {
              portMapping: { http: 4555 },
              skipCodeUpload: undefined,
            },
          },
        ]);
      }).pipe(
        Effect.provideService(Stack, {
          name: "prisma-runtime-stack-sentinel",
          stage: "prisma-runtime-stage-sentinel",
          bindings: {},
          resources: {},
          actions: {},
        }),
        Effect.provide(computeProviderLive()),
        Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
        Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect("bundles effect-native Compute apps from a named export", () => {
    let uploaded: Uint8Array | undefined;
    const client = {
      listApps: () => Effect.succeed([]),
      createApp: ({ projectId }: { projectId: string }) =>
        Effect.succeed({
          id: "service-1",
          type: "app" as const,
          url: "https://api.prisma.test/v1/apps/service-1",
          name: "api",
          region: { id: "us-east-1", name: "US East" },
          projectId,
          branchId: "branch-main",
          latestDeploymentId: "version-old",
          appEndpointDomain: "api.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        }),
      listEnvironmentVariables: () => Effect.succeed([]),
      createAppDeployment: () =>
        Effect.succeed({
          id: "version-1",
          type: "deployment" as const,
          url: "https://api.prisma.test/v1/deployments/version-1",
          foundryVersionId: "foundry-1",
          uploadUrl: "https://upload.prisma.test/effect.tar.gz",
        }),
      getDeployment: (id: string) =>
        Effect.succeed({
          id,
          type: "deployment" as const,
          url: "https://api.prisma.test/v1/deployments/version-1",
          foundryVersionId: "foundry-1",
          status: "new",
          previewDomain: "version-1.preview.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        }),
    } as unknown as PrismaManagementClient;
    const http = HttpClient.make((request) =>
      Effect.gen(function* () {
        const body = request.body as HttpBody.HttpBody;
        uploaded = yield* readHttpBodyBytes(body);
        return HttpClientResponse.fromWeb(request, new Response(null));
      }),
    );

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-named-effect-",
      });
      const main = path.join(root, "app.ts");
      yield* fs.writeFileString(
        main,
        [
          'import * as Prisma from "alchemy/Prisma";',
          'import * as Effect from "effect/Effect";',
          'import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";',
          "",
          "export const Api = Prisma.Compute(",
          '  "App",',
          "  {",
          '    project: "project-1",',
          '    appName: "api",',
          "    main: import.meta.filename,",
          '    handler: "Api",',
          "  },",
          "  Effect.gen(function* () {",
          "    return {",
          '      fetch: HttpServerResponse.text("named-handler-ok"),',
          "    };",
          "  }),",
          ");",
          "",
        ].join("\n"),
      );

      const provider = yield* Compute.Provider;
      const output = yield* provider.reconcile({
        id: "App",
        fqn: "App",
        instanceId: "00000000000000000000000000000000",
        news: {
          project: "project-1",
          appName: "api",
          branchId: "branch-main",
          main,
          handler: "Api",
          start: false,
          skipPromote: true,
        },
        olds: undefined,
        output: undefined,
        session: undefined as never,
        bindings: [],
      });

      expect(output.deploymentId).toBe("version-1");
      const tarText = new TextDecoder().decode(
        yield* Effect.sync(() => gunzipSync(uploaded!)),
      );
      expect(tarText).toContain("compute.manifest.json");
      expect(tarText).toContain("named-handler-ok");
    }).pipe(
      Effect.provide(computeProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("syncs env vars through the environment variable API", () => {
    const calls: Array<[string, unknown]> = [];
    const projectToken = {
      id: "env-token",
      type: "environment-variable" as const,
      url: "https://api.prisma.test/v1/environment-variables/env-token",
      projectId: "project-1",
      branchId: null,
      class: "production" as const,
      key: "TOKEN",
      valueKid: "kid-1",
      isManagedBySystem: false,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const projectRemove = {
      id: "env-remove",
      type: "environment-variable" as const,
      url: "https://api.prisma.test/v1/environment-variables/env-remove",
      projectId: "project-1",
      branchId: null,
      class: "production" as const,
      key: "REMOVE_ME",
      valueKid: "kid-1",
      isManagedBySystem: false,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const byKey = new Map([
      [
        "TOKEN",
        [
          { ...projectToken, id: "env-token-branch", branchId: "branch-1" },
          { ...projectToken, id: "env-token-branch-2", branchId: "branch-2" },
          projectToken,
        ],
      ],
      [
        "REMOVE_ME",
        [
          { ...projectRemove, id: "env-remove-branch", branchId: "branch-1" },
          projectRemove,
        ],
      ],
    ]);

    const client = {
      listEnvironmentVariables: (query: { key: string }) => {
        calls.push(["list", query]);
        return Effect.succeed(byKey.get(query.key) ?? []);
      },
      createEnvironmentVariable: (input: unknown) => {
        calls.push(["create", input]);
        return Effect.succeed({
          id: "env-created",
          type: "environment-variable" as const,
          url: "https://api.prisma.test/v1/environment-variables/env-created",
          projectId: "project-1",
          branchId: "branch-main",
          class: "production" as const,
          key: "API_URL",
          valueKid: "kid-2",
          isManagedBySystem: false,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        });
      },
      updateEnvironmentVariable: (id: string, input: unknown) => {
        calls.push(["update", { id, input }]);
        return Effect.succeed(projectToken);
      },
      deleteEnvironmentVariable: (id: string) => {
        calls.push(["delete", id]);
        return Effect.void;
      },
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const result = yield* syncComputeEnvironment(
        client,
        "project-1",
        "production",
        {
          API_URL: "https://example.test",
          TOKEN: Redacted.make("secret"),
          REMOVE_ME: null,
          SKIP_ME: undefined,
        },
        undefined,
        {
          TOKEN: "env-token",
          REMOVE_ME: "env-remove",
        },
      );

      expect(result).toEqual({
        synced: ["API_URL", "TOKEN"],
        deleted: ["REMOVE_ME"],
        ownedIds: {
          API_URL: "env-created",
          TOKEN: "env-token",
        },
      });
      expect(calls).toEqual([
        [
          "list",
          {
            projectId: "project-1",
            class: "production",
            key: "API_URL",
            limit: 100,
          },
        ],
        [
          "list",
          {
            projectId: "project-1",
            class: "production",
            key: "TOKEN",
            limit: 100,
          },
        ],
        [
          "list",
          {
            projectId: "project-1",
            class: "production",
            key: "REMOVE_ME",
            limit: 100,
          },
        ],
        [
          "create",
          {
            projectId: "project-1",
            class: "production",
            key: "API_URL",
            value: "https://example.test",
          },
        ],
        ["update", { id: "env-token", input: { value: "secret" } }],
        ["delete", "env-remove"],
      ]);
    });
  });

  it.effect(
    "rolls back variables created by a partially failed env sync",
    () => {
      const calls: Array<[string, unknown]> = [];
      const createError = new Error("second create failed");
      const client = {
        listEnvironmentVariables: (query: unknown) => {
          calls.push(["list", query]);
          return Effect.succeed([]);
        },
        createEnvironmentVariable: (input: { key: string }) => {
          calls.push(["create", input]);
          return input.key === "A"
            ? Effect.succeed({ id: "env-a" })
            : Effect.fail(createError);
        },
        deleteEnvironmentVariable: (id: string) => {
          calls.push(["delete", id]);
          return Effect.void;
        },
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const error = yield* syncComputeEnvironment(
          client,
          "project-1",
          "production",
          { A: "one", B: "two" },
        ).pipe(Effect.flip);

        expect(error).toBe(createError);
        expect(calls.map(([name]) => name)).toEqual([
          "list",
          "list",
          "create",
          "create",
          "delete",
        ]);
        expect(calls).toContainEqual(["delete", "env-a"]);
      });
    },
  );

  it.effect("surfaces env rollback failures with manual cleanup routes", () => {
    const createError = new Error("second create failed");
    const cleanupError = new Error("rollback delete failed");
    const client = {
      listEnvironmentVariables: () => Effect.succeed([]),
      createEnvironmentVariable: (input: { key: string }) =>
        input.key === "A"
          ? Effect.succeed({ id: "env-a" })
          : Effect.fail(createError),
      deleteEnvironmentVariable: () => Effect.fail(cleanupError),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const error = yield* syncComputeEnvironment(
        client,
        "project-1",
        "production",
        { A: "one", B: "two" },
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([
        createError,
        cleanupError,
      ]);
      expect((error as AggregateError).message).toContain(
        "DELETE /v1/environment-variables/env-a",
      );
    });
  });

  it.effect("preflights foreign env ownership before any write", () => {
    const calls: string[] = [];
    const foreign = {
      id: "env-foreign",
      key: "B",
      branchId: null,
      isManagedBySystem: false,
    };
    const client = {
      listEnvironmentVariables: (query: { key: string }) => {
        calls.push(`list:${query.key}`);
        return Effect.succeed(query.key === "B" ? [foreign] : []);
      },
      createEnvironmentVariable: () => {
        calls.push("create");
        return Effect.die("ownership preflight must happen first");
      },
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const error = yield* syncComputeEnvironment(
        client,
        "project-1",
        "production",
        { A: "one", B: "two" },
      ).pipe(Effect.flip);

      expect((error as Error).message).toContain("is not owned");
      expect(calls).toEqual(["list:A", "list:B"]);
    });
  });

  it.effect(
    "preserves old owned env variables when new-scope validation fails",
    () => {
      const calls: Array<[string, unknown?]> = [];
      const client = {
        getApp: () =>
          Effect.succeed({
            id: "service-1",
            type: "app" as const,
            url: "https://api.prisma.test/v1/apps/service-1",
            name: "api",
            region: { id: "us-east-1", name: "US East" },
            projectId: "project-1",
            branchId: "branch-main",
            latestDeploymentId: "version-old",
            appEndpointDomain: "api.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          }),
        getBranch: () => Effect.succeed(testBranch("branch-main")),
        getDeployment: (id: string) =>
          Effect.succeed({
            id,
            type: "deployment" as const,
            url: `https://api.prisma.test/v1/deployments/${id}`,
            foundryVersionId: `foundry-${id}`,
            status: "running",
            previewDomain: `${id}.preview.prisma.build`,
            createdAt: "2026-01-01T00:00:00Z",
          }),
        listEnvironmentVariables: (query: { key: string }) => {
          calls.push(["listEnvironmentVariables", query]);
          return Effect.succeed([
            {
              id: query.key === "OLD" ? "env-old" : "env-foreign",
              type: "environment-variable" as const,
              url: `https://api.prisma.test/v1/environment-variables/${query.key}`,
              projectId: "project-1",
              branchId: null,
              class: "production" as const,
              key: query.key,
              valueKid: "kid-1",
              isManagedBySystem: false,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
            },
          ]);
        },
        deleteEnvironmentVariable: (id: string) => {
          calls.push(["deleteEnvironmentVariable", id]);
          return Effect.void;
        },
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const error = yield* provider
          .reconcile({
            id: "App",
            fqn: "App",
            instanceId: "00000000000000000000000000000000",
            news: {
              project: "project-1",
              appName: "api",
              artifactPath: fixtureArtifactPath,
              branchId: "branch-main",
              env: { FOREIGN: "new" },
              start: false,
              skipPromote: true,
            },
            olds: {
              project: "project-1",
              appName: "api",
              artifactPath: fixtureArtifactV1Path,
              branchId: "branch-main",
              env: { OLD: "old" },
            },
            output: {
              appId: "service-1",
              deploymentId: "version-old",
              projectId: "project-1",
              appName: "api",
              regionId: "us-east-1",
              deploymentEndpointDomain: "version-old.preview.prisma.build",
              deploymentUrl: "https://version-old.preview.prisma.build",
              appEndpointDomain: "api.prisma.build",
              url: "https://api.prisma.build",
              promoted: true,
              previousDeploymentId: undefined,
              previousDeploymentAction: undefined,
              environmentVariableIds: { OLD: "env-old" },
              environmentClass: "production",
              environmentBranchId: null,
              artifactHash: Redacted.make("old-hash"),
              local: false,
            },
            session: undefined as never,
            bindings: [],
          })
          .pipe(Effect.flip);

        expect((error as Error).message).toContain("is not owned");
        expect(calls).toEqual([
          [
            "listEnvironmentVariables",
            {
              projectId: "project-1",
              class: "production",
              key: "FOREIGN",
              limit: 100,
            },
          ],
        ]);
      }).pipe(
        Effect.provide(computeProviderLive()),
        Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect("refuses to sync system-managed Compute env vars", () => {
    const calls: Array<[string, unknown]> = [];
    const systemVariable = {
      id: "env-system",
      type: "environment-variable" as const,
      url: "https://api.prisma.test/v1/environment-variables/env-system",
      projectId: "project-1",
      branchId: null,
      class: "production" as const,
      key: "PRISMA_INTERNAL_URL",
      valueKid: "kid-system",
      isManagedBySystem: true,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const client = {
      listEnvironmentVariables: (query: unknown) => {
        calls.push(["list", query]);
        return Effect.succeed([systemVariable]);
      },
      updateEnvironmentVariable: (id: string, input: unknown) => {
        calls.push(["update", { id, input }]);
        return Effect.succeed(systemVariable);
      },
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const error = yield* syncComputeEnvironment(
        client,
        "project-1",
        "production",
        {
          PRISMA_INTERNAL_URL: "secret",
        },
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "is managed by Prisma and cannot be managed by Alchemy",
      );
      expect(calls).toEqual([
        [
          "list",
          {
            projectId: "project-1",
            class: "production",
            key: "PRISMA_INTERNAL_URL",
            limit: 100,
          },
        ],
      ]);
    });
  });

  it.effect("validates Compute env vars before remote writes", () => {
    const calls: Array<[string, unknown]> = [];
    const client = {
      getApp: (id: string) =>
        Effect.sync(() => {
          calls.push(["getApp", id]);
          return {
            id,
            type: "app" as const,
            url: "https://api.prisma.test/v1/apps/service-1",
            name: "api",
            region: { id: "us-east-1", name: "US East" },
            projectId: "project-1",
            branchId: "branch-main",
            latestDeploymentId: "version-old",
            appEndpointDomain: "api.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          };
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const error = yield* provider
        .reconcile({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            appName: "api",
            artifactPath: fixtureArtifactV1Path,
            env: {
              "bad-key": "secret",
            },
          },
          olds: undefined,
          output: undefined,
          session: undefined as never,
          bindings: [],
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "must match POSIX env-var key shape",
      );
      expect(calls).toEqual([]);
    }).pipe(
      Effect.provide(computeProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("merges binding env into Compute deployment env", () => {
    const calls: Array<[string, unknown]> = [];
    const client = {
      getApp: (id: string) => {
        calls.push(["getApp", id]);
        return Effect.succeed({
          id,
          type: "app" as const,
          url: "https://api.prisma.test/v1/apps/service-1",
          name: "api",
          region: { id: "us-east-1", name: "US East" },
          projectId: "project-1",
          branchId: "branch-main",
          latestDeploymentId: "version-old",
          appEndpointDomain: "api.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      listEnvironmentVariables: (query: unknown) => {
        calls.push(["listEnvironmentVariables", query]);
        return Effect.succeed([]);
      },
      createEnvironmentVariable: (input: unknown) => {
        calls.push(["createEnvironmentVariable", input]);
        return Effect.succeed({
          id: "env-created",
          type: "environment-variable" as const,
          url: "https://api.prisma.test/v1/environment-variables/env-created",
          projectId: "project-1",
          branchId: "branch-main",
          class: "production" as const,
          key: "DATABASE_URL",
          valueKid: "kid-created",
          isManagedBySystem: false,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        });
      },
      createAppDeployment: (appId: string, input: unknown) => {
        calls.push(["createAppDeployment", { appId, input }]);
        return Effect.succeed({
          id: "version-1",
          type: "deployment" as const,
          url: "https://api.prisma.test/v1/deployments/version-1",
          foundryVersionId: "foundry-1",
          uploadUrl: null,
        });
      },
      getDeployment: (id: string) => {
        calls.push(["getDeployment", id]);
        return Effect.succeed({
          id,
          type: "deployment" as const,
          url: "https://api.prisma.test/v1/deployments/version-1",
          foundryVersionId: "foundry-1",
          status: "new",
          previewDomain: "version-1.preview.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const output = yield* provider.reconcile({
        id: "App",
        fqn: "App",
        instanceId: "00000000000000000000000000000000",
        news: {
          project: "project-1",
          appName: "api",
          branchId: "branch-main",
          skipCodeUpload: true,
          start: false,
          skipPromote: true,
          envClass: "preview",
        },
        olds: undefined,
        output: {
          appId: "service-1",
          deploymentId: undefined,
          projectId: "project-1",
          appName: "api",
          regionId: "us-east-1",
          deploymentEndpointDomain: undefined,
          deploymentUrl: undefined,
          appEndpointDomain: "api.prisma.build",
          url: "https://api.prisma.build",
          promoted: false,
          previousDeploymentId: undefined,
          previousDeploymentAction: undefined,
          artifactHash: undefined,
          local: false,
        },
        session: undefined as never,
        bindings: [
          {
            sid: "Connection",
            data: {
              env: {
                DATABASE_URL: Redacted.make("postgres://bound"),
                SHARED_FLAG: "from-binding",
              },
            },
          },
        ],
      });

      expect(output.deploymentId).toBe("version-1");
      expect(output.environmentKeys).toEqual(["DATABASE_URL", "SHARED_FLAG"]);
      expect(output.environmentClass).toBe("preview");
      expect(calls).toContainEqual([
        "createEnvironmentVariable",
        {
          projectId: "project-1",
          branchId: "branch-main",
          class: "preview",
          key: "DATABASE_URL",
          value: "postgres://bound",
        },
      ]);
      expect(calls).toContainEqual([
        "createEnvironmentVariable",
        {
          projectId: "project-1",
          branchId: "branch-main",
          class: "preview",
          key: "SHARED_FLAG",
          value: "from-binding",
        },
      ]);
    }).pipe(
      Effect.provide(computeProviderLive()),
      Effect.provide(
        Layer.succeed(PrismaClient, withDefaultBranch(client, "preview")),
      ),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect(
    "lets explicit Compute env override bindings and ignores deleted bindings",
    () => {
      const calls: Array<[string, unknown]> = [];
      const client = {
        getApp: (id: string) => {
          calls.push(["getApp", id]);
          return Effect.succeed({
            id,
            type: "app" as const,
            url: "https://api.prisma.test/v1/apps/service-1",
            name: "api",
            region: { id: "us-east-1", name: "US East" },
            projectId: "project-1",
            branchId: "branch-main",
            latestDeploymentId: "version-old",
            appEndpointDomain: "api.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
        listEnvironmentVariables: (query: unknown) => {
          calls.push(["listEnvironmentVariables", query]);
          return Effect.succeed([]);
        },
        createEnvironmentVariable: (input: {
          key: string;
          projectId: string;
          class: "production" | "preview";
        }) => {
          calls.push(["createEnvironmentVariable", input]);
          return Effect.succeed({
            id: `env-${input.key.toLowerCase()}`,
            type: "environment-variable" as const,
            url: `https://api.prisma.test/v1/environment-variables/env-${input.key.toLowerCase()}`,
            projectId: input.projectId,
            branchId: null,
            class: input.class,
            key: input.key,
            valueKid: `kid-${input.key.toLowerCase()}`,
            isManagedBySystem: false,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          });
        },
        createAppDeployment: (appId: string, input: unknown) => {
          calls.push(["createAppDeployment", { appId, input }]);
          return Effect.succeed({
            id: "version-1",
            type: "deployment" as const,
            url: "https://api.prisma.test/v1/deployments/version-1",
            foundryVersionId: "foundry-1",
            uploadUrl: "https://upload.prisma.test/version-1.tar.gz",
          });
        },
        getDeployment: (id: string) => {
          calls.push(["getDeployment", id]);
          return Effect.succeed({
            id,
            type: "deployment" as const,
            url: "https://api.prisma.test/v1/deployments/version-1",
            foundryVersionId: "foundry-1",
            status: "new",
            previewDomain: "version-1.preview.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
      } as unknown as PrismaManagementClient;
      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const deletedBinding = {
          sid: "RemovedConnection",
          action: "delete",
          data: {
            env: {
              DELETED_BINDING: "must-not-sync",
            },
          },
        } as ResourceBinding<Compute["Binding"]> & { action: "delete" };
        const output = yield* provider.reconcile({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            appName: "api",
            branchId: "branch-main",
            skipCodeUpload: true,
            start: false,
            skipPromote: true,
            env: {
              DATABASE_URL: Redacted.make("postgres://explicit"),
              BOUND_ONLY: null,
            },
          },
          olds: undefined,
          output: {
            appId: "service-1",
            deploymentId: undefined,
            projectId: "project-1",
            appName: "api",
            regionId: "us-east-1",
            deploymentEndpointDomain: undefined,
            deploymentUrl: undefined,
            appEndpointDomain: "api.prisma.build",
            url: "https://api.prisma.build",
            promoted: false,
            previousDeploymentId: undefined,
            previousDeploymentAction: undefined,
            artifactHash: undefined,
            local: false,
          },
          session: undefined as never,
          bindings: [
            {
              sid: "Connection",
              data: {
                env: {
                  DATABASE_URL: Redacted.make("postgres://bound"),
                  BOUND_ONLY: "from-binding",
                  ACTIVE_BINDING: "from-active-binding",
                },
              },
            },
            deletedBinding,
          ],
        });

        expect(output.environmentKeys).toEqual([
          "ACTIVE_BINDING",
          "DATABASE_URL",
        ]);
        expect(calls).toContainEqual([
          "createEnvironmentVariable",
          {
            projectId: "project-1",
            class: "production",
            key: "DATABASE_URL",
            value: "postgres://explicit",
          },
        ]);
        expect(calls).toContainEqual([
          "createEnvironmentVariable",
          {
            projectId: "project-1",
            class: "production",
            key: "ACTIVE_BINDING",
            value: "from-active-binding",
          },
        ]);
        expect(calls).not.toContainEqual([
          "createEnvironmentVariable",
          {
            projectId: "project-1",
            class: "production",
            key: "DELETED_BINDING",
            value: "must-not-sync",
          },
        ]);
        expect(calls).not.toContainEqual([
          "createEnvironmentVariable",
          {
            projectId: "project-1",
            class: "production",
            key: "BOUND_ONLY",
            value: "from-binding",
          },
        ]);
      }).pipe(
        Effect.provide(computeProviderLive()),
        Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect("removes env vars from previously managed bindings", () => {
    const calls: Array<[string, unknown]> = [];
    const byKey = new Map([
      [
        "OLD_BOUND_FLAG",
        {
          id: "env-old-bound-flag",
          type: "environment-variable" as const,
          url: "https://api.prisma.test/v1/environment-variables/env-old-bound-flag",
          projectId: "project-1",
          branchId: null,
          class: "production" as const,
          key: "OLD_BOUND_FLAG",
          valueKid: "kid-old",
          isManagedBySystem: false,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    ]);
    const client = {
      getApp: (id: string) => {
        calls.push(["getApp", id]);
        return Effect.succeed({
          id,
          type: "app" as const,
          url: "https://api.prisma.test/v1/apps/service-1",
          name: "api",
          region: { id: "us-east-1", name: "US East" },
          projectId: "project-1",
          branchId: "branch-main",
          latestDeploymentId: "version-old",
          appEndpointDomain: "api.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      listEnvironmentVariables: (query: { key: string }) => {
        calls.push(["listEnvironmentVariables", query]);
        return Effect.succeed(
          byKey.get(query.key) ? [byKey.get(query.key)] : [],
        );
      },
      createEnvironmentVariable: (input: unknown) => {
        calls.push(["createEnvironmentVariable", input]);
        return Effect.succeed({
          id: "env-created",
          type: "environment-variable" as const,
          url: "https://api.prisma.test/v1/environment-variables/env-created",
          projectId: "project-1",
          branchId: null,
          class: "production" as const,
          key: "DATABASE_URL",
          valueKid: "kid-created",
          isManagedBySystem: false,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        });
      },
      deleteEnvironmentVariable: (id: string) => {
        calls.push(["deleteEnvironmentVariable", id]);
        return Effect.void;
      },
      createAppDeployment: (appId: string, input: unknown) => {
        calls.push(["createAppDeployment", { appId, input }]);
        return Effect.succeed({
          id: "version-1",
          type: "deployment" as const,
          url: "https://api.prisma.test/v1/deployments/version-1",
          foundryVersionId: "foundry-1",
          uploadUrl: null,
        });
      },
      getDeployment: (id: string) => {
        calls.push(["getDeployment", id]);
        return Effect.succeed({
          id,
          type: "deployment" as const,
          url: "https://api.prisma.test/v1/deployments/version-1",
          foundryVersionId: "foundry-1",
          status: "new",
          previewDomain: "version-1.preview.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const output = yield* provider.reconcile({
        id: "App",
        fqn: "App",
        instanceId: "00000000000000000000000000000000",
        news: {
          project: "project-1",
          appName: "api",
          branchId: "branch-main",
          skipCodeUpload: true,
          start: false,
          skipPromote: true,
        },
        olds: undefined,
        output: {
          appId: "service-1",
          deploymentId: undefined,
          projectId: "project-1",
          appName: "api",
          regionId: "us-east-1",
          deploymentEndpointDomain: undefined,
          deploymentUrl: undefined,
          appEndpointDomain: "api.prisma.build",
          url: "https://api.prisma.build",
          promoted: false,
          previousDeploymentId: undefined,
          previousDeploymentAction: undefined,
          environmentKeys: ["DATABASE_URL", "OLD_BOUND_FLAG"],
          environmentVariableIds: {
            OLD_BOUND_FLAG: "env-old-bound-flag",
          },
          artifactHash: undefined,
          local: false,
        },
        session: undefined as never,
        bindings: [
          {
            sid: "Connection",
            data: {
              env: {
                DATABASE_URL: Redacted.make("postgres://still-bound"),
              },
            },
          },
        ],
      });

      expect(output.environmentKeys).toEqual(["DATABASE_URL"]);
      expect(calls).toContainEqual([
        "deleteEnvironmentVariable",
        "env-old-bound-flag",
      ]);
    }).pipe(
      Effect.provide(computeProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect(
    "deletes persisted env keys even when old props contain null tombstones",
    () => {
      const calls: Array<[string, unknown?]> = [];
      const staleVariable = {
        id: "env-stale-flag",
        type: "environment-variable" as const,
        url: "https://api.prisma.test/v1/environment-variables/env-stale-flag",
        projectId: "project-1",
        branchId: null,
        class: "production" as const,
        key: "STALE_FLAG",
        valueKid: "kid-stale",
        isManagedBySystem: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };
      const client = {
        listEnvironmentVariables: (query: { key: string }) => {
          calls.push(["listEnvironmentVariables", query]);
          return Effect.succeed(
            query.key === "STALE_FLAG" ? [staleVariable] : [],
          );
        },
        deleteEnvironmentVariable: (id: string) => {
          calls.push(["deleteEnvironmentVariable", id]);
          return Effect.void;
        },
        listAppDeployments: (appId: string, query: unknown) => {
          calls.push(["listAppDeployments", { appId, query }]);
          return Effect.succeed([]);
        },
        deleteApp: (id: string) => {
          calls.push(["deleteApp", id]);
          return Effect.void;
        },
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        yield* provider.delete({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          olds: {
            project: "project-1",
            appName: "api",
            env: {
              STALE_FLAG: null,
            },
          },
          output: {
            appId: "service-1",
            deploymentId: undefined,
            projectId: "project-1",
            appName: "api",
            regionId: "us-east-1",
            deploymentEndpointDomain: undefined,
            deploymentUrl: undefined,
            appEndpointDomain: "api.prisma.build",
            url: "https://api.prisma.build",
            promoted: false,
            previousDeploymentId: undefined,
            previousDeploymentAction: undefined,
            environmentKeys: ["STALE_FLAG"],
            environmentVariableIds: {
              STALE_FLAG: "env-stale-flag",
            },
            environmentClass: "production",
            artifactHash: undefined,
            local: false,
          },
          session: undefined as never,
          bindings: [],
        });

        expect(calls).toEqual([
          [
            "listEnvironmentVariables",
            {
              projectId: "project-1",
              class: "production",
              key: "STALE_FLAG",
              limit: 100,
            },
          ],
          ["deleteEnvironmentVariable", "env-stale-flag"],
          ["deleteApp", "service-1"],
        ]);
      }).pipe(
        Effect.provide(computeProviderLive()),
        Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
      );
    },
  );

  it.effect("does not expose redacted env values in Compute outputs", () => {
    const calls: Array<[string, unknown]> = [];
    const client = {
      getApp: (id: string) => {
        calls.push(["getApp", id]);
        return Effect.succeed({
          id,
          type: "app" as const,
          url: "https://api.prisma.test/v1/apps/service-1",
          name: "api",
          region: { id: "us-east-1", name: "US East" },
          projectId: "project-1",
          branchId: "branch-main",
          latestDeploymentId: "version-old",
          appEndpointDomain: "api.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      listEnvironmentVariables: (query: unknown) => {
        calls.push(["listEnvironmentVariables", query]);
        return Effect.succeed([]);
      },
      createEnvironmentVariable: (input: unknown) => {
        calls.push(["createEnvironmentVariable", input]);
        return Effect.succeed({
          id: "env-secret",
          type: "environment-variable" as const,
          url: "https://api.prisma.test/v1/environment-variables/env-secret",
          projectId: "project-1",
          branchId: null,
          class: "production" as const,
          key: "SECRET",
          valueKid: "kid-secret",
          isManagedBySystem: false,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        });
      },
      createAppDeployment: (appId: string, input: unknown) => {
        calls.push(["createAppDeployment", { appId, input }]);
        return Effect.succeed({
          id: "version-new",
          type: "deployment" as const,
          url: "https://api.prisma.test/v1/deployments/version-new",
          foundryVersionId: "foundry-new",
          uploadUrl: null,
        });
      },
      getDeployment: (id: string) => {
        calls.push(["getDeployment", id]);
        return Effect.succeed({
          id,
          type: "deployment" as const,
          url: `https://api.prisma.test/v1/deployments/${id}`,
          foundryVersionId: "foundry-new",
          status: "new",
          previewDomain: "version-new.preview.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const output = yield* provider.reconcile({
        id: "App",
        fqn: "App",
        instanceId: "00000000000000000000000000000000",
        news: {
          project: "project-1",
          appName: "api",
          branchId: "branch-main",
          skipCodeUpload: true,
          start: false,
          skipPromote: true,
          env: {
            SECRET: Redacted.make("super-secret"),
          },
        },
        olds: undefined,
        output: {
          appId: "service-1",
          deploymentId: "version-old",
          projectId: "project-1",
          appName: "api",
          regionId: "us-east-1",
          deploymentEndpointDomain: "version-old.preview.prisma.build",
          deploymentUrl: "https://version-old.preview.prisma.build",
          appEndpointDomain: "api.prisma.build",
          url: "https://api.prisma.build",
          promoted: true,
          previousDeploymentId: undefined,
          previousDeploymentAction: undefined,
          artifactHash: Redacted.make("old-hash"),
          local: false,
        },
        session: undefined as never,
        bindings: [],
      });

      expect(output.deploymentId).toBe("version-new");
      expect(Redacted.value(output.artifactHash!)).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(output)).not.toContain("super-secret");
      expect(calls).toContainEqual([
        "createEnvironmentVariable",
        {
          projectId: "project-1",
          class: "production",
          key: "SECRET",
          value: "super-secret",
        },
      ]);
    }).pipe(
      Effect.provide(computeProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("runs a build command and uploads the built archive", () => {
    const calls: Array<[string, unknown]> = [];
    let latestDeploymentId: string | null = null;
    let uploaded:
      | { url: string; contentType: string | undefined; bytes: Uint8Array }
      | undefined;
    const client = {
      listApps: (projectId: string, query: unknown) => {
        calls.push(["listApps", { projectId, query }]);
        return Effect.succeed([]);
      },
      createApp: (projectId: string, input: unknown) => {
        calls.push(["createApp", { projectId, input }]);
        return Effect.succeed({
          id: "service-1",
          type: "app" as const,
          url: "https://api.prisma.test/v1/apps/service-1",
          name: "api",
          region: { id: "us-east-1", name: "US East" },
          projectId,
          branchId: "branch-main",
          latestDeploymentId,
          appEndpointDomain: "api.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      updateApp: (id: string, input: unknown) => {
        calls.push(["updateApp", { id, input }]);
        return Effect.succeed({
          id,
          type: "app" as const,
          url: "https://api.prisma.test/v1/apps/service-1",
          name: "api",
          region: { id: "us-east-1", name: "US East" },
          projectId: "project-1",
          branchId: "branch-main",
          latestDeploymentId,
          appEndpointDomain: "api.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      getApp: (id: string) =>
        Effect.succeed({
          id,
          type: "app" as const,
          url: "https://api.prisma.test/v1/apps/service-1",
          name: "api",
          region: { id: "us-east-1", name: "US East" },
          projectId: "project-1",
          branchId: "branch-main",
          latestDeploymentId,
          appEndpointDomain: "api.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        }),
      listEnvironmentVariables: () => Effect.succeed([]),
      createAppDeployment: (appId: string, input: unknown) => {
        calls.push(["createAppDeployment", { appId, input }]);
        return Effect.succeed({
          id: "version-1",
          type: "deployment" as const,
          url: "https://api.prisma.test/v1/deployments/version-1",
          foundryVersionId: "foundry-1",
          uploadUrl: "https://upload.prisma.test/artifact.tar.gz",
        });
      },
      getDeployment: (id: string) => {
        calls.push(["getDeployment", id]);
        return Effect.succeed({
          id,
          type: "deployment" as const,
          url: "https://api.prisma.test/v1/deployments/version-1",
          foundryVersionId: "foundry-1",
          status: "running",
          previewDomain: "version-1.preview.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      promoteApp: (
        appId: string,
        { deploymentId }: { deploymentId: string },
      ) => {
        calls.push(["promoteApp", { appId, deploymentId }]);
        latestDeploymentId = deploymentId;
        return Effect.succeed({ appEndpointDomain: "api.prisma.build" });
      },
    } as unknown as PrismaManagementClient;
    const http = HttpClient.make((request) =>
      Effect.gen(function* () {
        const body = request.body as HttpBody.HttpBody;
        uploaded = {
          url: request.url,
          contentType: httpBodyContentType(body),
          bytes: yield* readHttpBodyBytes(body),
        };
        return HttpClientResponse.fromWeb(request, new Response(null));
      }),
    );

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-build-",
      });
      yield* fs.writeFileString(
        path.join(root, "build.sh"),
        [
          "mkdir -p dist",
          'printf \'console.log("%s");\' "$BUILD_GREETING" > dist/server.js',
          "",
        ].join("\n"),
      );

      const provider = yield* Compute.Provider;
      const output = yield* provider.reconcile({
        id: "App",
        fqn: "App",
        instanceId: "00000000000000000000000000000000",
        news: {
          project: "project-1",
          appName: "api",
          path: root,
          port: 4567,
          verifyUrl: false,
          build: {
            command: "sh build.sh",
            cwd: root,
            outdir: "dist",
            entrypoint: "server.js",
            env: { BUILD_GREETING: "hello-build" },
          },
        },
        olds: undefined,
        output: undefined,
        session: undefined as never,
        bindings: [],
      });

      expect(output.deploymentId).toBe("version-1");
      expect(uploaded?.url).toBe("https://upload.prisma.test/artifact.tar.gz");
      expect(uploaded?.contentType).toBe("application/gzip");
      const tarText = new TextDecoder().decode(
        yield* Effect.sync(() => gunzipSync(uploaded!.bytes)),
      );
      expect(tarText).toContain("compute.manifest.json");
      expect(tarText).toContain("bundle/server.js");
      expect(tarText).toContain("hello-build");
      expect(calls).toContainEqual([
        "createAppDeployment",
        {
          appId: "service-1",
          input: {
            portMapping: { http: 4567 },
            skipCodeUpload: undefined,
          },
        },
      ]);
    }).pipe(
      Effect.provide(computeProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("auto-builds a Bun app before uploading", () => {
    const calls: Array<[string, unknown]> = [];
    let uploaded:
      | { url: string; contentType: string | undefined; bytes: Uint8Array }
      | undefined;
    const client = {
      listApps: (projectId: string, query: unknown) => {
        calls.push(["listApps", { projectId, query }]);
        return Effect.succeed([]);
      },
      createApp: (projectId: string, input: unknown) => {
        calls.push(["createApp", { projectId, input }]);
        return Effect.succeed({
          id: "service-1",
          type: "app" as const,
          url: "https://api.prisma.test/v1/apps/service-1",
          name: "api",
          region: { id: "us-east-1", name: "US East" },
          projectId,
          branchId: "branch-main",
          latestDeploymentId: null,
          appEndpointDomain: "api.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      listEnvironmentVariables: () => Effect.succeed([]),
      createAppDeployment: (appId: string, input: unknown) => {
        calls.push(["createAppDeployment", { appId, input }]);
        return Effect.succeed({
          id: "version-1",
          type: "deployment" as const,
          url: "https://api.prisma.test/v1/deployments/version-1",
          foundryVersionId: "foundry-1",
          uploadUrl: "https://upload.prisma.test/auto.tar.gz",
        });
      },
      getDeployment: (id: string) => {
        calls.push(["getDeployment", id]);
        return Effect.succeed({
          id,
          type: "deployment" as const,
          url: "https://api.prisma.test/v1/deployments/version-1",
          foundryVersionId: "foundry-1",
          status: "new",
          previewDomain: "version-1.preview.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
    } as unknown as PrismaManagementClient;
    const http = HttpClient.make((request) =>
      Effect.gen(function* () {
        const body = request.body as HttpBody.HttpBody;
        uploaded = {
          url: request.url,
          contentType: httpBodyContentType(body),
          bytes: yield* readHttpBodyBytes(body),
        };
        return HttpClientResponse.fromWeb(request, new Response(null));
      }),
    );

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-auto-",
      });
      yield* fs.makeDirectory(path.join(root, "src"));
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({ main: "src/server.ts" }),
      );
      yield* fs.writeFileString(
        path.join(root, "src", "server.ts"),
        "console.log('auto app');",
      );

      const provider = yield* Compute.Provider;
      const output = yield* provider.reconcile({
        id: "App",
        fqn: "App",
        instanceId: "00000000000000000000000000000000",
        news: {
          project: "project-1",
          appName: "api",
          path: root,
          build: "auto",
          start: false,
          skipPromote: true,
        },
        olds: undefined,
        output: undefined,
        session: undefined as never,
        bindings: [],
      });

      expect(output.deploymentId).toBe("version-1");
      expect(uploaded?.url).toBe("https://upload.prisma.test/auto.tar.gz");
      expect(uploaded?.contentType).toBe("application/gzip");
      const tarText = new TextDecoder().decode(
        yield* Effect.sync(() => gunzipSync(uploaded!.bytes)),
      );
      expect(tarText).toContain("bundle/server.js");
      expect(tarText).toContain("auto app");
      expect(calls).toContainEqual([
        "createAppDeployment",
        {
          appId: "service-1",
          input: {
            portMapping: { http: 8080 },
            skipCodeUpload: undefined,
          },
        },
      ]);
    }).pipe(
      Effect.provide(computeProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("uses framework auto-build default ports in Compute", () => {
    const calls: Array<[string, unknown]> = [];
    const client = {
      listApps: (projectId: string, query: unknown) => {
        calls.push(["listApps", { projectId, query }]);
        return Effect.succeed([]);
      },
      createApp: (projectId: string, input: unknown) => {
        calls.push(["createApp", { projectId, input }]);
        return Effect.succeed({
          id: "service-1",
          type: "app" as const,
          url: "https://api.prisma.test/v1/apps/service-1",
          name: "web",
          region: { id: "us-east-1", name: "US East" },
          projectId,
          branchId: "branch-main",
          latestDeploymentId: null,
          appEndpointDomain: "web.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      listEnvironmentVariables: () => Effect.succeed([]),
      createAppDeployment: (appId: string, input: unknown) => {
        calls.push(["createAppDeployment", { appId, input }]);
        return Effect.succeed({
          id: "version-1",
          type: "deployment" as const,
          url: "https://api.prisma.test/v1/deployments/version-1",
          foundryVersionId: "foundry-1",
          uploadUrl: "https://upload.prisma.test/next.tar.gz",
        });
      },
      getDeployment: (id: string) => {
        calls.push(["getDeployment", id]);
        return Effect.succeed({
          id,
          type: "deployment" as const,
          url: "https://api.prisma.test/v1/deployments/version-1",
          foundryVersionId: "foundry-1",
          status: "new",
          previewDomain: "version-1.preview.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
    } as unknown as PrismaManagementClient;
    const http = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null))),
    );

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-compute-auto-next-",
      });
      const binDir = path.join(root, "node_modules", ".bin");
      const nextBin = path.join(binDir, "next");
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(root, "package.json"),
        JSON.stringify({ dependencies: { next: "0.0.0-test" } }),
      );
      yield* fs.writeFileString(
        nextBin,
        [
          "#!/bin/sh",
          "mkdir -p .next/standalone",
          "printf 'next server' > .next/standalone/server.js",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(nextBin, 0o755);

      const provider = yield* Compute.Provider;
      const output = yield* provider.reconcile({
        id: "App",
        fqn: "App",
        instanceId: "00000000000000000000000000000000",
        news: {
          project: "project-1",
          appName: "web",
          path: root,
          build: { type: "auto", framework: "nextjs" },
          start: false,
          skipPromote: true,
        },
        olds: undefined,
        output: undefined,
        session: undefined as never,
        bindings: [],
      });

      expect(output.deploymentId).toBe("version-1");
      expect(calls).toContainEqual([
        "createAppDeployment",
        {
          appId: "service-1",
          input: {
            portMapping: { http: 3000 },
            skipCodeUpload: undefined,
          },
        },
      ]);
    }).pipe(
      Effect.provide(computeProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
      Effect.provide(PlatformServices),
    );
  });

  it.effect(
    "refuses to claim a foreign service after a create conflict",
    () => {
      const calls: Array<[string, unknown]> = [];
      let serviceListCount = 0;
      const service = {
        id: "service-1",
        type: "app" as const,
        url: "https://api.prisma.test/v1/apps/service-1",
        name: "api",
        region: { id: "us-east-1", name: "US East" },
        projectId: "project-1",
        branchId: "branch-main",
        latestDeploymentId: null,
        appEndpointDomain: "api.prisma.build",
        createdAt: "2026-01-01T00:00:00Z",
      };

      const client = {
        listApps: (projectId: string, query: unknown) =>
          Effect.sync(() => {
            serviceListCount += 1;
            calls.push(["listApps", { projectId, query }]);
            return serviceListCount === 1 ? [] : [service];
          }),
        createApp: (projectId: string, input: unknown) =>
          Effect.gen(function* () {
            calls.push(["createApp", { projectId, input }]);
            return yield* Effect.fail(
              new PrismaApiError({
                method: "POST",
                path: `/v1/apps`,
                status: 409,
                message: "already exists",
              }),
            );
          }),
        listBranches: (projectId: string, query: unknown) => {
          calls.push(["listBranches", { projectId, query }]);
          return Effect.succeed([
            {
              id: "branch-main",
              type: "branch" as const,
              url: "https://api.prisma.test/v1/branches/branch-main",
              gitName: "main",
              isDefault: true,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
              project: {
                id: "project-1",
                url: "https://api.prisma.test/v1/projects/project-1",
                name: "project",
              },
            },
          ]);
        },
        updateApp: (id: string, input: unknown) => {
          calls.push(["updateApp", { id, input }]);
          return Effect.succeed({ ...service, branchId: "branch-main" });
        },
        listEnvironmentVariables: (query: unknown) => {
          calls.push(["listEnvironmentVariables", query]);
          return Effect.succeed([]);
        },
        createAppDeployment: (appId: string, input: unknown) => {
          calls.push(["createAppDeployment", { appId, input }]);
          return Effect.succeed({
            id: "version-1",
            type: "deployment" as const,
            url: "https://api.prisma.test/v1/deployments/version-1",
            foundryVersionId: "foundry-1",
            uploadUrl: "https://upload.prisma.test/version-1.tar.gz",
          });
        },
        getDeployment: (id: string) => {
          calls.push(["getDeployment", id]);
          return Effect.succeed({
            id,
            type: "deployment" as const,
            url: "https://api.prisma.test/v1/deployments/version-1",
            foundryVersionId: "foundry-1",
            status: "new",
            previewDomain: null,
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
      } as unknown as PrismaManagementClient;
      const http = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null))),
      );

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const error = yield* provider
          .reconcile({
            id: "App",
            fqn: "App",
            instanceId: "00000000000000000000000000000000",
            news: {
              project: "project-1",
              appName: "api",
              artifactPath: fixtureArtifactPath,
              start: false,
              skipPromote: true,
            },
            olds: undefined,
            output: undefined,
            session: undefined as never,
            bindings: [],
          })
          .pipe(Effect.flip);

        expect((error as Error).message).toContain("is not owned");
        expect(calls.some(([name]) => name === "createAppDeployment")).toBe(
          false,
        );
      }).pipe(
        Effect.provide(computeProviderLive()),
        Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
        Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect("reconciles deploy updates and destroys old deployments", () => {
    const calls: Array<[string, unknown]> = [];
    const versions = new Map<string, "new" | "running" | "stopped">();
    let latestDeploymentId: string | null = null;
    let versionCounter = 0;

    const service = () => ({
      id: "service-1",
      type: "app" as const,
      url: "https://api.prisma.test/v1/apps/service-1",
      name: "api",
      region: { id: "us-east-1", name: "US East" },
      projectId: "project-1",
      branchId: "branch-main",
      latestDeploymentId,
      appEndpointDomain: "api.prisma.build",
      createdAt: "2026-01-01T00:00:00Z",
    });

    const version = (id: string) => ({
      id,
      type: "deployment" as const,
      url: `https://api.prisma.test/v1/deployments/${id}`,
      foundryVersionId: `foundry-${id}`,
      status: versions.get(id) ?? "new",
      previewDomain: `${id}.preview.prisma.build`,
      createdAt: "2026-01-01T00:00:00Z",
    });

    const client = {
      listApps: (projectId: string, query: unknown) => {
        calls.push(["listApps", { projectId, query }]);
        return Effect.succeed([]);
      },
      getApp: (id: string) => {
        calls.push(["getApp", id]);
        return Effect.succeed(service());
      },
      listBranches: (projectId: string, query: unknown) => {
        calls.push(["listBranches", { projectId, query }]);
        return Effect.succeed([
          {
            id: "branch-main",
            type: "branch" as const,
            url: "https://api.prisma.test/v1/branches/branch-main",
            gitName: "main",
            isDefault: true,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            project: {
              id: "project-1",
              url: "https://api.prisma.test/v1/projects/project-1",
              name: "project",
            },
          },
        ]);
      },
      createApp: (projectId: string, input: unknown) => {
        calls.push(["createApp", { projectId, input }]);
        return Effect.succeed(service());
      },
      updateApp: (id: string, input: unknown) => {
        calls.push(["updateApp", { id, input }]);
        return Effect.succeed(service());
      },
      listEnvironmentVariables: (query: unknown) => {
        calls.push(["listEnvironmentVariables", query]);
        return Effect.succeed([]);
      },
      createAppDeployment: (appId: string, input: unknown) =>
        Effect.sync(() => {
          const id = `version-${++versionCounter}`;
          calls.push(["createAppDeployment", { appId, input }]);
          versions.set(id, "new");
          return {
            id,
            type: "deployment" as const,
            url: `https://api.prisma.test/v1/deployments/${id}`,
            foundryVersionId: `foundry-${id}`,
            uploadUrl: `https://upload.prisma.test/${id}.tar.gz`,
          };
        }),
      getDeployment: (id: string) => {
        calls.push(["getDeployment", id]);
        return versions.has(id)
          ? Effect.succeed(version(id))
          : Effect.fail(
              new PrismaApiError({
                method: "GET",
                path: `/v1/deployments/${id}`,
                status: 404,
                message: "not found",
              }),
            );
      },
      startDeployment: (id: string) =>
        Effect.sync(() => {
          calls.push(["startDeployment", id]);
          versions.set(id, "running");
          return { previewDomain: `${id}.preview.prisma.build` };
        }),
      promoteApp: (appId: string, { deploymentId }: { deploymentId: string }) =>
        Effect.sync(() => {
          calls.push(["promoteApp", { appId, deploymentId }]);
          latestDeploymentId = deploymentId;
          return { appEndpointDomain: "api.prisma.build" };
        }),
      stopDeployment: (id: string) =>
        Effect.gen(function* () {
          calls.push(["stopDeployment", id]);
          if (id === "version-1") {
            versions.delete(id);
            return yield* Effect.fail(
              new PrismaApiError({
                method: "POST",
                path: `/v1/deployments/${id}/stop`,
                status: 404,
                message: "not found",
              }),
            );
          }
          versions.set(id, "stopped");
        }),
      deleteDeployment: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteDeployment", id]);
          versions.delete(id);
        }),
      listAppDeployments: (appId: string, query: unknown) => {
        calls.push(["listAppDeployments", { appId, query }]);
        return Effect.succeed(
          [...versions.keys()].map((id) => ({
            id,
            type: "deployment" as const,
            url: `https://api.prisma.test/v1/deployments/${id}`,
            foundryVersionId: `foundry-${id}`,
            createdAt: "2026-01-01T00:00:00Z",
          })),
        );
      },
      deleteApp: (id: string) =>
        Effect.sync(() => {
          calls.push(["deleteApp", id]);
          versions.clear();
        }),
    } as unknown as PrismaManagementClient;

    const http = HttpClient.make((request) =>
      readHttpBodyBytes(request.body as HttpBody.HttpBody).pipe(
        Effect.as(HttpClientResponse.fromWeb(request, new Response(null))),
      ),
    );

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const first = yield* provider.reconcile({
        id: "App",
        fqn: "App",
        instanceId: "00000000000000000000000000000000",
        news: {
          project: "project-1",
          appName: "api",
          artifactPath: fixtureArtifactV1Path,
          port: 3000,
        },
        olds: undefined,
        output: undefined,
        session: undefined as never,
        bindings: [],
      });

      const callsBeforeSkip = calls.length;
      const firstWithSkip = yield* provider.reconcile({
        id: "App",
        fqn: "App",
        instanceId: "00000000000000000000000000000000",
        news: {
          project: "project-1",
          appName: "api",
          artifactPath: fixtureArtifactV1Path,
          port: 3000,
          skipPromote: true,
        },
        olds: {
          project: "project-1",
          appName: "api",
          artifactPath: fixtureArtifactV1Path,
          port: 3000,
        },
        output: first,
        session: undefined as never,
        bindings: [],
      });
      const skipCalls = calls.slice(callsBeforeSkip);
      expect(firstWithSkip.deploymentId).toBe("version-1");
      expect(firstWithSkip.promoted).toBe(true);
      expect(firstWithSkip.url).toBe("https://api.prisma.build");
      expect(skipCalls.map(([operation]) => operation)).not.toContain(
        "createAppDeployment",
      );
      expect(skipCalls.map(([operation]) => operation)).not.toContain(
        "promoteApp",
      );
      calls.splice(callsBeforeSkip);

      const second = yield* provider.reconcile({
        id: "App",
        fqn: "App",
        instanceId: "00000000000000000000000000000000",
        news: {
          project: "project-1",
          appName: "api",
          artifactPath: fixtureArtifactV2Path,
          port: 3000,
          destroyOldDeployment: true,
        },
        olds: {
          project: "project-1",
          appName: "api",
          artifactPath: fixtureArtifactV1Path,
          port: 3000,
          skipPromote: true,
        },
        output: firstWithSkip,
        session: undefined as never,
        bindings: [],
      });

      yield* provider.delete({
        id: "App",
        fqn: "App",
        instanceId: "00000000000000000000000000000000",
        olds: {
          project: "project-1",
          appName: "api",
          artifactPath: fixtureArtifactV2Path,
          port: 3000,
        },
        output: second,
        session: undefined as never,
        bindings: [],
      });

      expect(first.deploymentId).toBe("version-1");
      expect(first.promoted).toBe(true);
      expect(second.deploymentId).toBe("version-2");
      expect(second.previousDeploymentId).toBe("version-1");
      expect(second.previousDeploymentAction).toBe("destroyed");
      expect(versions.size).toBe(0);
      expect(calls).toEqual([
        ["listBranches", { projectId: "project-1", query: { limit: 100 } }],
        [
          "createApp",
          {
            projectId: "project-1",
            input: {
              displayName: "api",
              regionId: undefined,
              branchId: "branch-main",
              branchGitName: undefined,
            },
          },
        ],
        [
          "createAppDeployment",
          {
            appId: "service-1",
            input: {
              portMapping: { http: 3000 },
              skipCodeUpload: undefined,
            },
          },
        ],
        ["getDeployment", "version-1"],
        ["startDeployment", "version-1"],
        ["getDeployment", "version-1"],
        ["promoteApp", { appId: "service-1", deploymentId: "version-1" }],
        ["getApp", "service-1"],
        ["getApp", "service-1"],
        ["listBranches", { projectId: "project-1", query: { limit: 100 } }],
        ["getDeployment", "version-1"],
        [
          "createAppDeployment",
          {
            appId: "service-1",
            input: {
              portMapping: { http: 3000 },
              skipCodeUpload: undefined,
            },
          },
        ],
        ["getDeployment", "version-2"],
        ["startDeployment", "version-2"],
        ["getDeployment", "version-2"],
        ["promoteApp", { appId: "service-1", deploymentId: "version-2" }],
        ["getApp", "service-1"],
        ["getDeployment", "version-1"],
        ["getDeployment", "version-1"],
        ["stopDeployment", "version-1"],
        ["getDeployment", "version-1"],
        ["deleteDeployment", "version-1"],
        ["deleteApp", "service-1"],
      ]);
    }).pipe(
      Effect.provide(computeProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
      Effect.provide(PlatformServices),
    );
  });

  it.effect(
    "creates a no-upload version for skipCodeUpload env updates",
    () => {
      const calls: Array<[string, unknown]> = [];
      const featureEnv = {
        id: "env-feature",
        type: "environment-variable" as const,
        url: "https://api.prisma.test/v1/environment-variables/env-feature",
        projectId: "project-1",
        branchId: null,
        class: "production" as const,
        key: "FEATURE",
        valueKid: "kid-feature",
        isManagedBySystem: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };
      const client = {
        getApp: (id: string) => {
          calls.push(["getApp", id]);
          return Effect.succeed({
            id,
            type: "app" as const,
            url: "https://api.prisma.test/v1/apps/service-1",
            name: "api",
            region: { id: "us-east-1", name: "US East" },
            projectId: "project-1",
            branchId: "branch-main",
            latestDeploymentId: "version-old",
            appEndpointDomain: "api.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
        listEnvironmentVariables: (query: { key: string }) => {
          calls.push(["listEnvironmentVariables", query]);
          return Effect.succeed(query.key === "FEATURE" ? [featureEnv] : []);
        },
        updateEnvironmentVariable: (id: string, input: unknown) => {
          calls.push(["updateEnvironmentVariable", { id, input }]);
          return Effect.succeed(featureEnv);
        },
        createAppDeployment: (appId: string, input: unknown) => {
          calls.push(["createAppDeployment", { appId, input }]);
          return Effect.succeed({
            id: "version-new",
            type: "deployment" as const,
            url: "https://api.prisma.test/v1/deployments/version-new",
            foundryVersionId: "foundry-new",
            uploadUrl: null,
          });
        },
        getDeployment: (id: string) => {
          calls.push(["getDeployment", id]);
          return Effect.succeed({
            id,
            type: "deployment" as const,
            url: `https://api.prisma.test/v1/deployments/${id}`,
            foundryVersionId: "foundry-new",
            status: "new",
            previewDomain: "version-new.preview.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const output = yield* provider.reconcile({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            appName: "api",
            branchId: "branch-main",
            skipCodeUpload: true,
            start: false,
            skipPromote: true,
            env: {
              FEATURE: "on",
            },
          },
          olds: {
            project: "project-1",
            appName: "api",
            branchId: "branch-main",
            skipCodeUpload: true,
            start: false,
            skipPromote: true,
            env: {
              FEATURE: "off",
            },
          },
          output: {
            appId: "service-1",
            deploymentId: "version-old",
            projectId: "project-1",
            appName: "api",
            regionId: "us-east-1",
            deploymentEndpointDomain: "version-old.preview.prisma.build",
            deploymentUrl: "https://version-old.preview.prisma.build",
            appEndpointDomain: "api.prisma.build",
            url: "https://api.prisma.build",
            promoted: true,
            previousDeploymentId: undefined,
            previousDeploymentAction: undefined,
            environmentVariableIds: { FEATURE: "env-feature" },
            artifactHash: Redacted.make("old-hash"),
            local: false,
          },
          session: undefined as never,
          bindings: [],
        });

        expect(output.deploymentId).toBe("version-new");
        expect(output.previousDeploymentId).toBe("version-old");
        expect(output.previousDeploymentAction).toBe("still-active");
        expect(calls).toEqual([
          ["getApp", "service-1"],
          ["getDeployment", "version-old"],
          [
            "listEnvironmentVariables",
            {
              projectId: "project-1",
              class: "production",
              key: "FEATURE",
              limit: 100,
            },
          ],
          [
            "updateEnvironmentVariable",
            { id: "env-feature", input: { value: "on" } },
          ],
          [
            "createAppDeployment",
            {
              appId: "service-1",
              input: { portMapping: { http: 8080 }, skipCodeUpload: true },
            },
          ],
          ["getDeployment", "version-new"],
        ]);
      }).pipe(
        Effect.provide(computeProviderLive()),
        Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect(
    "replays promotion to repair endpoint drift for a matching deployment",
    () => {
      const calls: Array<[string, unknown]> = [];
      let latestDeploymentId: string | null = null;

      const service = () => ({
        id: "service-1",
        type: "app" as const,
        url: "https://api.prisma.test/v1/apps/service-1",
        name: "api",
        region: { id: "us-east-1", name: "US East" },
        projectId: "project-1",
        branchId: "branch-main",
        latestDeploymentId,
        appEndpointDomain: "api.prisma.build",
        createdAt: "2026-01-01T00:00:00Z",
      });

      const client = {
        listApps: (projectId: string, query: unknown) => {
          calls.push(["listApps", { projectId, query }]);
          return Effect.succeed([]);
        },
        createApp: (projectId: string, input: unknown) => {
          calls.push(["createApp", { projectId, input }]);
          return Effect.succeed(service());
        },
        getApp: (id: string) => {
          calls.push(["getApp", id]);
          return Effect.succeed(service());
        },
        createAppDeployment: (appId: string, input: unknown) => {
          calls.push(["createAppDeployment", { appId, input }]);
          return Effect.succeed({
            id: "version-1",
            type: "deployment" as const,
            url: "https://api.prisma.test/v1/deployments/version-1",
            foundryVersionId: "foundry-1",
            uploadUrl: "https://upload.prisma.test/version-1.tar.gz",
          });
        },
        getDeployment: (id: string) => {
          calls.push(["getDeployment", id]);
          return Effect.succeed({
            id,
            type: "deployment" as const,
            url: `https://api.prisma.test/v1/deployments/${id}`,
            foundryVersionId: "foundry-1",
            status: "running",
            previewDomain: "version-1.preview.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
        promoteApp: (
          appId: string,
          { deploymentId }: { deploymentId: string },
        ) =>
          Effect.sync(() => {
            calls.push(["promoteApp", { appId, deploymentId }]);
            latestDeploymentId = deploymentId;
            return { appEndpointDomain: "api.prisma.build" };
          }),
      } as unknown as PrismaManagementClient;
      const http = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null))),
      );

      const news = {
        project: "project-1",
        appName: "api",
        branchId: "branch-main",
        artifactPath: fixtureArtifactPath,
        verifyUrl: false,
      };

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const first = yield* provider.reconcile({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          news,
          olds: undefined,
          output: undefined,
          session: undefined as never,
          bindings: [],
        });

        const second = yield* provider.reconcile({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          news,
          olds: news,
          output: first,
          session: undefined as never,
          bindings: [],
        });

        expect(first.deploymentId).toBe("version-1");
        expect(second.deploymentId).toBe("version-1");
        expect(second.previousDeploymentId).toBeNull();
        expect(calls.filter(([name]) => name === "promoteApp")).toEqual([
          ["promoteApp", { appId: "service-1", deploymentId: "version-1" }],
          ["promoteApp", { appId: "service-1", deploymentId: "version-1" }],
        ]);
        expect(
          calls.filter(([name]) => name === "createAppDeployment"),
        ).toHaveLength(1);
      }).pipe(
        Effect.provide(computeProviderLive()),
        Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
        Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect(
    "persists pending cleanup when destroying the old deployment fails",
    () => {
      const calls: Array<[string, unknown]> = [];
      let latestDeploymentId = "version-1";
      const client = {
        getApp: (id: string) => {
          calls.push(["getApp", id]);
          return Effect.succeed({
            id,
            type: "app" as const,
            url: `https://api.prisma.test/v1/apps/${id}`,
            name: "api",
            region: { id: "us-east-1", name: "us-east-1" },
            projectId: "project-1",
            branchId: "branch-main",
            latestDeploymentId,
            appEndpointDomain: "api.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
        listBranches: (projectId: string, query: unknown) => {
          calls.push(["listBranches", { projectId, query }]);
          return Effect.succeed([
            {
              id: "branch-main",
              type: "branch" as const,
              url: "https://api.prisma.test/v1/branches/branch-main",
              gitName: "main",
              isDefault: true,
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
              project: {
                id: "project-1",
                url: "https://api.prisma.test/v1/projects/project-1",
                name: "project",
              },
            },
          ]);
        },
        createAppDeployment: (appId: string, input: unknown) => {
          calls.push(["createAppDeployment", { appId, input }]);
          return Effect.succeed({
            id: "version-2",
            type: "deployment" as const,
            url: "https://api.prisma.test/v1/deployments/version-2",
            foundryVersionId: "foundry-version-2",
            uploadUrl: "https://upload.prisma.test/version-2.tar.gz",
          });
        },
        getDeployment: (id: string) => {
          calls.push(["getDeployment", id]);
          return Effect.succeed({
            id,
            type: "deployment" as const,
            url: `https://api.prisma.test/v1/deployments/${id}`,
            foundryVersionId: `foundry-${id}`,
            status: id === "version-1" ? "stopped" : "running",
            previewDomain: `${id}.preview.prisma.build`,
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
        startDeployment: (id: string) =>
          Effect.sync(() => {
            calls.push(["startDeployment", id]);
            return { previewDomain: `${id}.preview.prisma.build` };
          }),
        promoteApp: (
          appId: string,
          { deploymentId }: { deploymentId: string },
        ) =>
          Effect.sync(() => {
            calls.push(["promoteApp", { appId, deploymentId }]);
            latestDeploymentId = deploymentId;
            return { appEndpointDomain: "api.prisma.build" };
          }),
        stopDeployment: (id: string) =>
          Effect.sync(() => {
            calls.push(["stopDeployment", id]);
          }),
        deleteDeployment: (id: string) =>
          Effect.gen(function* () {
            calls.push(["deleteDeployment", id]);
            return yield* Effect.fail(
              new PrismaApiError({
                method: "DELETE",
                path: `/v1/deployments/${id}`,
                status: 500,
                message: "Internal Server Error",
              }),
            );
          }),
      } as unknown as PrismaManagementClient;

      const http = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null))),
      );

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const output = yield* provider.reconcile({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          news: {
            project: "project-1",
            appName: "api",
            artifactPath: fixtureArtifactV2Path,
            port: 3000,
            destroyOldDeployment: true,
          },
          olds: {
            project: "project-1",
            appName: "api",
            artifactPath: fixtureArtifactV1Path,
            port: 3000,
          },
          output: {
            appId: "service-1",
            deploymentId: "version-1",
            projectId: "project-1",
            appName: "api",
            regionId: "us-east-1",
            deploymentEndpointDomain: "version-1.preview.prisma.build",
            deploymentUrl: "https://version-1.preview.prisma.build",
            appEndpointDomain: "api.prisma.build",
            url: "https://api.prisma.build",
            promoted: true,
            previousDeploymentId: undefined,
            previousDeploymentAction: undefined,
            artifactHash: Redacted.make("old-hash"),
            local: false,
          },
          session: undefined as never,
          bindings: [],
        });

        expect(output.deploymentId).toBe("version-2");
        expect(output.previousDeploymentAction).toBe("still-active");
        expect(output.pendingDeploymentCleanup).toEqual({
          deploymentId: "version-1",
          action: "destroy",
        });
        expect(calls).toContainEqual(["deleteDeployment", "version-1"]);
      }).pipe(
        Effect.provide(computeProviderLive()),
        Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect(
    "preserves a newly created deployment when promotion commit is ambiguous",
    () => {
      const calls: Array<[string, unknown]> = [];
      const versions = new Map([["version-new", "new"]]);
      const client = {
        getApp: (id: string) => {
          calls.push(["getApp", id]);
          return Effect.succeed({
            id,
            type: "app" as const,
            url: `https://api.prisma.test/v1/apps/${id}`,
            name: "api",
            region: { id: "us-east-1", name: "US East" },
            projectId: "project-1",
            branchId: "branch-main",
            latestDeploymentId: null,
            appEndpointDomain: "api.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
        createAppDeployment: (appId: string, input: unknown) => {
          calls.push(["createAppDeployment", { appId, input }]);
          return Effect.succeed({
            id: "version-new",
            type: "deployment" as const,
            url: "https://api.prisma.test/v1/deployments/version-new",
            foundryVersionId: "foundry-new",
            uploadUrl: "https://upload.prisma.test/version-new.tar.gz",
          });
        },
        getDeployment: (id: string) => {
          calls.push(["getDeployment", id]);
          return Effect.succeed({
            id,
            type: "deployment" as const,
            url: `https://api.prisma.test/v1/deployments/${id}`,
            foundryVersionId: "foundry-new",
            status: versions.get(id) ?? "new",
            previewDomain: `${id}.preview.prisma.build`,
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
        startDeployment: (id: string) =>
          Effect.sync(() => {
            calls.push(["startDeployment", id]);
            versions.set(id, "running");
            return { previewDomain: `${id}.preview.prisma.build` };
          }),
        promoteApp: (
          appId: string,
          { deploymentId }: { deploymentId: string },
        ) =>
          Effect.gen(function* () {
            calls.push(["promoteApp", { appId, deploymentId }]);
            return yield* Effect.fail(
              new PrismaApiError({
                method: "POST",
                path: `/v1/apps/${appId}/promote`,
                status: 500,
                message: "promote failed",
              }),
            );
          }),
        rollbackApp: () =>
          Effect.fail(
            new PrismaApiError({
              method: "POST",
              path: "/v1/apps/service-1/rollback",
              status: 500,
              message: "promotion recovery failed",
            }),
          ),
        stopDeployment: (id: string) =>
          Effect.sync(() => {
            calls.push(["stopDeployment", id]);
            versions.set(id, "stopped");
          }),
        deleteDeployment: (id: string) =>
          Effect.sync(() => {
            calls.push(["deleteDeployment", id]);
            versions.delete(id);
          }),
      } as unknown as PrismaManagementClient;

      const http = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null))),
      );

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        const error = yield* provider
          .reconcile({
            id: "App",
            fqn: "App",
            instanceId: "00000000000000000000000000000000",
            news: {
              project: "project-1",
              appName: "api",
              artifactPath: fixtureArtifactV1Path,
              branchId: "branch-main",
            },
            olds: undefined,
            output: {
              appId: "service-1",
              deploymentId: undefined,
              projectId: "project-1",
              appName: "api",
              regionId: "us-east-1",
              deploymentEndpointDomain: undefined,
              deploymentUrl: undefined,
              appEndpointDomain: "api.prisma.build",
              url: "https://api.prisma.build",
              promoted: false,
              previousDeploymentId: undefined,
              previousDeploymentAction: undefined,
              artifactHash: undefined,
              local: false,
            },
            session: undefined as never,
            bindings: [],
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).message).toContain("ambiguous");
        expect(versions.has("version-new")).toBe(true);
        expect(calls).toEqual([
          ["getApp", "service-1"],
          [
            "createAppDeployment",
            {
              appId: "service-1",
              input: {
                portMapping: { http: 8080 },
                skipCodeUpload: undefined,
              },
            },
          ],
          ["getDeployment", "version-new"],
          ["startDeployment", "version-new"],
          ["getDeployment", "version-new"],
          ["promoteApp", { appId: "service-1", deploymentId: "version-new" }],
          ["getApp", "service-1"],
          ["getApp", "service-1"],
        ]);
      }).pipe(
        Effect.provide(computeProviderLive()),
        Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
        Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect("deletes env vars removed from Compute props on update", () => {
    const calls: Array<[string, unknown]> = [];
    const byKey = new Map([
      [
        "TOKEN",
        {
          id: "env-token",
          type: "environment-variable" as const,
          url: "https://api.prisma.test/v1/environment-variables/env-token",
          projectId: "project-1",
          branchId: null,
          class: "production" as const,
          key: "TOKEN",
          valueKid: "kid-1",
          isManagedBySystem: false,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
      [
        "KEEP",
        {
          id: "env-keep",
          type: "environment-variable" as const,
          url: "https://api.prisma.test/v1/environment-variables/env-keep",
          projectId: "project-1",
          branchId: null,
          class: "production" as const,
          key: "KEEP",
          valueKid: "kid-2",
          isManagedBySystem: false,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    ]);
    const client = {
      getApp: (id: string) => {
        calls.push(["getApp", id]);
        return Effect.succeed({
          id,
          type: "app" as const,
          url: "https://api.prisma.test/v1/apps/service-1",
          name: "api",
          region: { id: "us-east-1", name: "US East" },
          projectId: "project-1",
          branchId: "branch-main",
          latestDeploymentId: "version-old",
          appEndpointDomain: "api.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      listEnvironmentVariables: (query: { key: string }) => {
        calls.push(["listEnvironmentVariables", query]);
        const variable = byKey.get(query.key);
        return Effect.succeed(variable ? [variable] : []);
      },
      deleteEnvironmentVariable: (id: string) => {
        calls.push(["deleteEnvironmentVariable", id]);
        return Effect.void;
      },
      updateEnvironmentVariable: (id: string, input: unknown) => {
        calls.push(["updateEnvironmentVariable", { id, input }]);
        return Effect.succeed(byKey.get("KEEP"));
      },
      createEnvironmentVariable: (input: unknown) => {
        calls.push(["createEnvironmentVariable", input]);
        return Effect.succeed({
          id: "env-new",
          type: "environment-variable" as const,
          url: "https://api.prisma.test/v1/environment-variables/env-new",
          projectId: "project-1",
          branchId: null,
          class: "production" as const,
          key: "NEW",
          valueKid: "kid-3",
          isManagedBySystem: false,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        });
      },
      createAppDeployment: (appId: string, input: unknown) => {
        calls.push(["createAppDeployment", { appId, input }]);
        return Effect.succeed({
          id: "version-new",
          type: "deployment" as const,
          url: "https://api.prisma.test/v1/deployments/version-new",
          foundryVersionId: "foundry-new",
          uploadUrl: "https://upload.prisma.test/version-new.tar.gz",
        });
      },
      getDeployment: (id: string) => {
        calls.push(["getDeployment", id]);
        return Effect.succeed({
          id,
          type: "deployment" as const,
          url: `https://api.prisma.test/v1/deployments/${id}`,
          foundryVersionId: "foundry-new",
          status: "new",
          previewDomain: "version-new.preview.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
    } as unknown as PrismaManagementClient;

    const http = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null))),
    );

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const output = yield* provider.reconcile({
        id: "App",
        fqn: "App",
        instanceId: "00000000000000000000000000000000",
        news: {
          project: "project-1",
          appName: "api",
          artifactPath: fixtureArtifactV2Path,
          branchId: "branch-main",
          start: false,
          skipPromote: true,
          env: {
            KEEP: "new-value",
            NEW: "created",
          },
        },
        olds: {
          project: "project-1",
          appName: "api",
          artifactPath: fixtureArtifactV1Path,
          branchId: "branch-main",
          start: false,
          skipPromote: true,
          env: {
            KEEP: "old-value",
            TOKEN: Redacted.make("secret"),
            ALREADY_ABSENT: null,
          },
        },
        output: {
          appId: "service-1",
          deploymentId: "version-old",
          projectId: "project-1",
          appName: "api",
          regionId: "us-east-1",
          deploymentEndpointDomain: "version-old.preview.prisma.build",
          deploymentUrl: "https://version-old.preview.prisma.build",
          appEndpointDomain: "api.prisma.build",
          url: "https://api.prisma.build",
          promoted: true,
          previousDeploymentId: undefined,
          previousDeploymentAction: undefined,
          environmentVariableIds: {
            KEEP: "env-keep",
            TOKEN: "env-token",
          },
          artifactHash: Redacted.make("old-hash"),
          local: false,
        },
        session: undefined as never,
        bindings: [],
      });

      expect(output.deploymentId).toBe("version-new");
      expect(calls).toEqual([
        ["getApp", "service-1"],
        ["getDeployment", "version-old"],
        [
          "listEnvironmentVariables",
          {
            projectId: "project-1",
            class: "production",
            key: "KEEP",
            limit: 100,
          },
        ],
        [
          "listEnvironmentVariables",
          {
            projectId: "project-1",
            class: "production",
            key: "NEW",
            limit: 100,
          },
        ],
        [
          "updateEnvironmentVariable",
          { id: "env-keep", input: { value: "new-value" } },
        ],
        [
          "createEnvironmentVariable",
          {
            projectId: "project-1",
            class: "production",
            key: "NEW",
            value: "created",
          },
        ],
        [
          "listEnvironmentVariables",
          {
            projectId: "project-1",
            class: "production",
            key: "TOKEN",
            limit: 100,
          },
        ],
        ["deleteEnvironmentVariable", "env-token"],
        [
          "createAppDeployment",
          {
            appId: "service-1",
            input: {
              portMapping: { http: 8080 },
              skipCodeUpload: undefined,
            },
          },
        ],
        ["getDeployment", "version-new"],
      ]);
    }).pipe(
      Effect.provide(computeProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("returns an empty tail stream before a deployment exists", () =>
    Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      const chunks = yield* Stream.runCollect(
        provider.tail!({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          props: {
            project: "project-1",
            appName: "api",
          },
          output: {
            appId: "service-1",
            deploymentId: undefined,
            projectId: "project-1",
            appName: "api",
            regionId: "us-east-1",
            deploymentEndpointDomain: undefined,
            deploymentUrl: undefined,
            appEndpointDomain: undefined,
            url: undefined,
            promoted: false,
            previousDeploymentId: undefined,
            previousDeploymentAction: undefined,
            artifactHash: undefined,
            local: false,
          },
        }),
      );

      expect(chunks).toEqual([]);
    }).pipe(
      Effect.provide(computeProviderLive()),
      Effect.provide(
        Layer.succeed(PrismaClient, {} as unknown as PrismaManagementClient),
      ),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    ),
  );

  it.effect("deletes Compute env vars on provider destroy", () => {
    const calls: Array<[string, unknown]> = [];
    const client = {
      listEnvironmentVariables: (query: unknown) => {
        calls.push(["listEnvironmentVariables", query]);
        return Effect.succeed([
          {
            id: "env-token",
            type: "environment-variable" as const,
            url: "https://api.prisma.test/v1/environment-variables/env-token",
            projectId: "project-1",
            branchId: null,
            class: "production" as const,
            key: "TOKEN",
            valueKid: "kid-1",
            isManagedBySystem: false,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ]);
      },
      deleteEnvironmentVariable: (id: string) => {
        calls.push(["deleteEnvironmentVariable", id]);
        return Effect.void;
      },
      listAppDeployments: (appId: string, query: unknown) => {
        calls.push(["listAppDeployments", { appId, query }]);
        return Effect.succeed([]);
      },
      deleteApp: (id: string) => {
        calls.push(["deleteApp", id]);
        return Effect.void;
      },
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      yield* provider.delete({
        id: "App",
        fqn: "App",
        instanceId: "00000000000000000000000000000000",
        olds: {
          project: "project-1",
          appName: "api",
          env: {
            TOKEN: Redacted.make("secret"),
            ALREADY_ABSENT: null,
            SKIP_ME: undefined,
          },
        },
        output: {
          appId: "service-1",
          deploymentId: "version-1",
          projectId: "project-1",
          appName: "api",
          regionId: "us-east-1",
          deploymentEndpointDomain: "version-1.preview.prisma.build",
          deploymentUrl: "https://version-1.preview.prisma.build",
          appEndpointDomain: "api.prisma.build",
          url: "https://api.prisma.build",
          promoted: true,
          previousDeploymentId: undefined,
          previousDeploymentAction: undefined,
          environmentVariableIds: { TOKEN: "env-token" },
          artifactHash: Redacted.make("hash-1"),
          local: false,
        },
        session: undefined as never,
        bindings: [],
      });

      expect(calls).toEqual([
        [
          "listEnvironmentVariables",
          {
            projectId: "project-1",
            class: "production",
            key: "TOKEN",
            limit: 100,
          },
        ],
        ["deleteEnvironmentVariable", "env-token"],
        ["deleteApp", "service-1"],
      ]);
    }).pipe(
      Effect.provide(computeProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("skips system-managed Compute env vars on provider destroy", () => {
    const calls: Array<[string, unknown]> = [];
    const byKey = new Map([
      [
        "TOKEN",
        {
          id: "env-token",
          type: "environment-variable" as const,
          url: "https://api.prisma.test/v1/environment-variables/env-token",
          projectId: "project-1",
          branchId: null,
          class: "production" as const,
          key: "TOKEN",
          valueKid: "kid-token",
          isManagedBySystem: false,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
      [
        "PRISMA_INTERNAL_URL",
        {
          id: "env-system",
          type: "environment-variable" as const,
          url: "https://api.prisma.test/v1/environment-variables/env-system",
          projectId: "project-1",
          branchId: null,
          class: "production" as const,
          key: "PRISMA_INTERNAL_URL",
          valueKid: "kid-system",
          isManagedBySystem: true,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    ]);
    const client = {
      listEnvironmentVariables: (query: { key: string }) => {
        calls.push(["listEnvironmentVariables", query]);
        return Effect.succeed(
          byKey.get(query.key) ? [byKey.get(query.key)] : [],
        );
      },
      deleteEnvironmentVariable: (id: string) => {
        calls.push(["deleteEnvironmentVariable", id]);
        return Effect.void;
      },
      listAppDeployments: (appId: string, query: unknown) => {
        calls.push(["listAppDeployments", { appId, query }]);
        return Effect.succeed([]);
      },
      deleteApp: (id: string) => {
        calls.push(["deleteApp", id]);
        return Effect.void;
      },
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      yield* provider.delete({
        id: "App",
        fqn: "App",
        instanceId: "00000000000000000000000000000000",
        olds: {
          project: "project-1",
          appName: "api",
          env: {
            TOKEN: Redacted.make("secret"),
            PRISMA_INTERNAL_URL: Redacted.make("prisma-owned"),
          },
        },
        output: {
          appId: "service-1",
          deploymentId: "version-1",
          projectId: "project-1",
          appName: "api",
          regionId: "us-east-1",
          deploymentEndpointDomain: "version-1.preview.prisma.build",
          deploymentUrl: "https://version-1.preview.prisma.build",
          appEndpointDomain: "api.prisma.build",
          url: "https://api.prisma.build",
          promoted: true,
          previousDeploymentId: undefined,
          previousDeploymentAction: undefined,
          environmentVariableIds: {
            TOKEN: "env-token",
            PRISMA_INTERNAL_URL: "env-system",
          },
          artifactHash: Redacted.make("hash-1"),
          local: false,
        },
        session: undefined as never,
        bindings: [],
      });

      expect(calls).toEqual([
        [
          "listEnvironmentVariables",
          {
            projectId: "project-1",
            class: "production",
            key: "TOKEN",
            limit: 100,
          },
        ],
        ["deleteEnvironmentVariable", "env-token"],
        [
          "listEnvironmentVariables",
          {
            projectId: "project-1",
            class: "production",
            key: "PRISMA_INTERNAL_URL",
            limit: 100,
          },
        ],
        ["deleteApp", "service-1"],
      ]);
    }).pipe(
      Effect.provide(computeProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("deletes Compute env vars when old props are missing", () => {
    const calls: Array<[string, unknown]> = [];
    const client = {
      listEnvironmentVariables: (query: { key: string }) => {
        calls.push(["listEnvironmentVariables", query]);
        return Effect.succeed(
          query.key === "TOKEN"
            ? [
                {
                  id: "env-token",
                  type: "environment-variable" as const,
                  url: "https://api.prisma.test/v1/environment-variables/env-token",
                  projectId: "project-1",
                  branchId: null,
                  class: "production" as const,
                  key: "TOKEN",
                  valueKid: "kid-1",
                  isManagedBySystem: false,
                  createdAt: "2026-01-01T00:00:00Z",
                  updatedAt: "2026-01-01T00:00:00Z",
                },
              ]
            : [],
        );
      },
      deleteEnvironmentVariable: (id: string) => {
        calls.push(["deleteEnvironmentVariable", id]);
        return Effect.void;
      },
      listAppDeployments: (appId: string, query: unknown) => {
        calls.push(["listAppDeployments", { appId, query }]);
        return Effect.succeed([]);
      },
      deleteApp: (id: string) => {
        calls.push(["deleteApp", id]);
        return Effect.void;
      },
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* Compute.Provider;
      yield* provider.delete({
        id: "App",
        fqn: "App",
        instanceId: "00000000000000000000000000000000",
        olds: undefined as never,
        output: {
          appId: "service-1",
          deploymentId: "version-1",
          projectId: "project-1",
          appName: "api",
          regionId: "us-east-1",
          deploymentEndpointDomain: "version-1.preview.prisma.build",
          deploymentUrl: "https://version-1.preview.prisma.build",
          appEndpointDomain: "api.prisma.build",
          url: "https://api.prisma.build",
          promoted: true,
          previousDeploymentId: undefined,
          previousDeploymentAction: undefined,
          environmentKeys: ["TOKEN"],
          environmentVariableIds: { TOKEN: "env-token" },
          environmentClass: "preview",
          artifactHash: Redacted.make("hash-1"),
          local: false,
        },
        session: undefined as never,
        bindings: [],
      });

      expect(calls).toEqual([
        [
          "listEnvironmentVariables",
          {
            projectId: "project-1",
            class: "preview",
            key: "TOKEN",
            limit: 100,
          },
        ],
        ["deleteEnvironmentVariable", "env-token"],
        ["deleteApp", "service-1"],
      ]);
    }).pipe(
      Effect.provide(computeProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect(
    "continues Compute destroy when managed env vars are already gone",
    () => {
      const calls: Array<[string, unknown]> = [];
      const client = {
        listEnvironmentVariables: (query: unknown) =>
          Effect.gen(function* () {
            calls.push(["listEnvironmentVariables", query]);
            return yield* Effect.fail(
              new PrismaApiError({
                method: "GET",
                path: "/v1/environment-variables",
                status: 404,
                message: "project not found",
              }),
            );
          }),
        listAppDeployments: (appId: string, query: unknown) => {
          calls.push(["listAppDeployments", { appId, query }]);
          return Effect.succeed([]);
        },
        deleteApp: (id: string) => {
          calls.push(["deleteApp", id]);
          return Effect.void;
        },
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* Compute.Provider;
        yield* provider.delete({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          olds: {
            project: "project-1",
            appName: "api",
            env: {
              TOKEN: Redacted.make("secret"),
            },
          },
          output: {
            appId: "service-1",
            deploymentId: "version-1",
            projectId: "project-1",
            appName: "api",
            regionId: "us-east-1",
            deploymentEndpointDomain: "version-1.preview.prisma.build",
            deploymentUrl: "https://version-1.preview.prisma.build",
            appEndpointDomain: "api.prisma.build",
            url: "https://api.prisma.build",
            promoted: true,
            previousDeploymentId: undefined,
            previousDeploymentAction: undefined,
            environmentVariableIds: { TOKEN: "env-token" },
            artifactHash: Redacted.make("hash-1"),
            local: false,
          },
          session: undefined as never,
          bindings: [],
        });

        expect(calls).toEqual([
          [
            "listEnvironmentVariables",
            {
              projectId: "project-1",
              class: "production",
              key: "TOKEN",
              limit: 100,
            },
          ],
          ["deleteApp", "service-1"],
        ]);
      }).pipe(
        Effect.provide(computeProviderLive()),
        Effect.provide(Layer.succeed(PrismaClient, withDefaultBranch(client))),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect("tails Compute logs through the provider", () =>
    withWebSocketServer((server) =>
      Effect.gen(function* () {
        const url = yield* listenUrl(server);
        const calls: Array<[string, unknown]> = [];
        let authorization: string | undefined;

        server.on("connection", (socket, request) => {
          authorization = request.headers.authorization;
          socket.send(
            JSON.stringify({
              type: "log",
              text: "compute app log",
              byteStart: 0,
              byteEnd: 15,
            }),
          );
          socket.send(
            JSON.stringify({
              type: "terminal",
              kind: "end",
              code: "vm_stopped",
              message: "done",
              retryable: false,
              cursor: null,
            }),
          );
        });

        const client = {
          getDeploymentLogsRequest: (deploymentId: string, query: unknown) =>
            Effect.sync(() => {
              calls.push(["getDeploymentLogsRequest", { deploymentId, query }]);
              return {
                url: `${url}/v1/deployments/${deploymentId}/logs`,
                headers: {
                  Authorization: Redacted.make("Bearer app-token"),
                },
              };
            }),
        } as unknown as PrismaManagementClient;

        const provider = yield* Compute.Provider.pipe(
          Effect.provide(computeProviderLive()),
          Effect.provide(
            Layer.succeed(PrismaClient, withDefaultBranch(client)),
          ),
        );
        const lines = yield* provider.tail!({
          id: "App",
          fqn: "App",
          instanceId: "00000000000000000000000000000000",
          props: {
            project: "project-1",
            appName: "api",
          },
          output: {
            appId: "service-1",
            deploymentId: "version-1",
            projectId: "project-1",
            appName: "api",
            regionId: "us-east-1",
            deploymentEndpointDomain: "version-1.preview.prisma.build",
            deploymentUrl: "https://version-1.preview.prisma.build",
            appEndpointDomain: "api.prisma.build",
            url: "https://api.prisma.build",
            promoted: true,
            previousDeploymentId: undefined,
            previousDeploymentAction: undefined,
            artifactHash: Redacted.make("hash-1"),
            local: false,
          },
        }).pipe(Stream.runCollect);

        expect(lines.map((line) => line.message)).toEqual(["compute app log"]);
        expect(authorization).toBe("Bearer app-token");
        expect(calls).toEqual([
          [
            "getDeploymentLogsRequest",
            { deploymentId: "version-1", query: undefined },
          ],
        ]);
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      ),
    ),
  );
});

const withWebSocketServer = <A, E, R>(
  f: (server: WebSocketServer) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new WebSocketServer({ host: "127.0.0.1", port: 0 })),
    f,
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }).pipe(Effect.ignore),
  );

const listenUrl = (server: WebSocketServer) =>
  Effect.callback<string, Error>((resume) => {
    const complete = () => {
      cleanup();
      const address = server.address();
      if (address && typeof address === "object") {
        resume(Effect.succeed(`ws://127.0.0.1:${address.port}`));
      } else {
        resume(Effect.fail(new Error("WebSocket server has no TCP address")));
      }
    };
    const fail = (cause: unknown) => {
      cleanup();
      resume(
        Effect.fail(cause instanceof Error ? cause : new Error(String(cause))),
      );
    };
    const cleanup = () => {
      server.off("listening", complete);
      server.off("error", fail);
    };

    if (server.address()) {
      complete();
      return;
    }

    server.once("listening", complete);
    server.once("error", fail);
    return Effect.sync(cleanup);
  });
