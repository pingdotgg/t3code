import {
  Deployment as PrismaDeployment,
  DeploymentProvider,
  MAX_DEPLOYMENT_ARTIFACT_BYTES,
  readUploadArtifact,
  uploadArtifact,
  validateDeploymentArtifactBytes,
} from "@/Prisma/Deployment";
import * as Output from "@/Output";
import {
  PrismaApiError,
  PrismaClient,
  type PrismaManagementClient,
} from "@/Prisma/Client";
import { executeArtifactUpload } from "@/Prisma/Internal/ArtifactUpload";
import { PrismaHttpClientLive } from "@/Prisma/Internal/HttpClient";
import { PlatformServices } from "@/Util/PlatformServices";
import { sha256, sha256Object } from "@/Util/sha256";
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
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {
  createServer as createHttpServer,
  type RequestListener,
  type Server as NodeHttpServer,
} from "node:http";
import { WebSocketServer } from "ws";
import { AlchemyContext } from "@/AlchemyContext";
import { encodeState } from "@/State/StateEncoding";

const currentClient = <T extends object>(client: T): PrismaManagementClient => {
  return client as unknown as PrismaManagementClient;
};

const fixtureArtifactPath = `${import.meta.dirname}/fixtures/artifact-archive.bin`;
const sameArtifactPath = `${import.meta.dirname}/fixtures/artifact-same-version.bin`;

const liveProviderContext = Layer.succeed(AlchemyContext, {
  dotAlchemy: ".alchemy-test",
  dev: false,
  adopt: false,
});

const deploymentProviderLive = () =>
  DeploymentProvider().pipe(Layer.provide(liveProviderContext));

describe("Prisma Deployment", () => {
  it.effect("redacts signed upload URLs from transport failures", () => {
    const secret = "SIGNED_QUERY_SECRET_SENTINEL";
    const http = HttpClient.make((request) =>
      Effect.fail(new Error(`transport failed for ${request.url}`) as never),
    );

    return Effect.gen(function* () {
      const error = yield* uploadArtifact(
        `https://upload.prisma.test/artifact?signature=${secret}`,
        new Uint8Array([1]),
        "application/octet-stream",
      ).pipe(Effect.flip);

      expect(error.message).toContain("transport failed");
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain("upload.prisma.test");
      expect(JSON.stringify(error)).not.toContain(secret);
    }).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, http)));
  });

  it.effect("rejects final artifacts above the upload byte limit", () =>
    Effect.gen(function* () {
      const error = yield* validateDeploymentArtifactBytes(
        new Uint8Array(9),
        8,
      ).pipe(Effect.flip);

      expect((error as Error).message).toContain(
        "exceeds the 8 byte upload safety limit",
      );
    }),
  );

  it.effect("does not allow callers to raise the upload hard limit", () =>
    Effect.gen(function* () {
      const error = yield* validateDeploymentArtifactBytes(
        new Uint8Array(1),
        MAX_DEPLOYMENT_ARTIFACT_BYTES + 1,
      ).pipe(Effect.flip);

      expect((error as Error).message).toContain("hard limit");
    }),
  );

  it.effect("rejects symbolic-link artifact paths", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-artifact-symlink-",
      });
      const target = path.join(root, "artifact.tar.gz");
      const link = path.join(root, "artifact-link.tar.gz");
      yield* fs.writeFileString(target, "archive");
      yield* fs.symlink(target, link);

      const error = yield* readUploadArtifact({
        artifactPath: link,
        output: "file",
      }).pipe(Effect.flip);

      expect(error.message).toContain("symbolic link");
    }).pipe(Effect.provide(PlatformServices)),
  );

  it.effect("refuses to upload a file changed after validation", () => {
    const http = HttpClient.make((request) => {
      const body = request.body as HttpBody.HttpBody;
      const consume =
        body._tag === "Stream" ? Stream.runDrain(body.stream) : Effect.void;
      return consume.pipe(
        Effect.mapError(
          (cause) =>
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause,
                description: "test request body stream failed",
              }),
            }),
        ),
        Effect.as(HttpClientResponse.fromWeb(request, new Response(null))),
      );
    });

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-artifact-mutation-",
      });
      const artifactPath = path.join(root, "artifact.tar.gz");
      yield* fs.writeFileString(artifactPath, "first!!");
      const artifact = yield* readUploadArtifact({
        artifactPath,
        output: "file",
      });
      yield* fs.writeFileString(artifactPath, "second!");

      const error = yield* uploadArtifact(
        "https://upload.prisma.test/artifact.tar.gz?signature=secret",
        artifact!,
        "application/gzip",
      ).pipe(Effect.flip);

      expect(error.message).toContain("transport failed");
      expect(String(error)).not.toContain("signature=secret");
    }).pipe(
      Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("streams file-backed artifacts with a fixed Content-Length", () => {
    let contentLength: string | undefined;
    let uploadedBytes = 0;

    return withHttpServer(
      (request, response) => {
        contentLength = request.headers["content-length"];
        request.on("data", (chunk: Buffer) => {
          uploadedBytes += chunk.byteLength;
        });
        request.on("end", () => {
          response.statusCode = contentLength === undefined ? 411 : 204;
          response.end();
        });
      },
      (uploadUrl) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectory({
            prefix: "alchemy-prisma-fixed-length-upload-",
          });
          const artifactPath = path.join(root, "artifact.tar.gz");
          yield* fs.writeFileString(artifactPath, "fixed-length-archive");
          const artifact = yield* readUploadArtifact({
            artifactPath,
            output: "file",
          });

          yield* executeArtifactUpload(
            uploadUrl,
            artifact!,
            "application/gzip",
          );

          expect(contentLength).toBe(String(artifact!.size));
          expect(uploadedBytes).toBe(artifact!.size);
        }).pipe(
          Effect.provide(PrismaHttpClientLive),
          Effect.provide(PlatformServices),
          Effect.scoped,
        ),
    );
  });

  it.effect(
    "fails when Prisma omits an upload URL for version artifacts",
    () => {
      const calls: Array<[string, unknown?]> = [];
      const client = {
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
        const provider = yield* PrismaDeployment.Provider;
        const error = yield* provider
          .reconcile({
            id: "Version",
            fqn: "Version",
            instanceId: "00000000000000000000000000000000",
            news: {
              app: "service-1",
              artifactPath: fixtureArtifactPath,
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
      }).pipe(
        Effect.provide(deploymentProviderLive()),
        Effect.provide(Layer.succeed(PrismaClient, currentClient(client))),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect("deletes created deployment when artifact upload fails", () => {
    const calls: Array<[string, unknown?]> = [];
    const client = {
      createAppDeployment: () => {
        calls.push(["createAppDeployment"]);
        return Effect.succeed({
          id: "version-1",
          type: "deployment" as const,
          url: "https://api.prisma.test/v1/deployments/version-1",
          foundryVersionId: "foundry-1",
          uploadUrl: "https://upload.prisma.test/version.tar.gz",
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
          new Response("SIGNED_UPLOAD_SECRET_SENTINEL", { status: 500 }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const provider = yield* PrismaDeployment.Provider;
      const error = yield* provider
        .reconcile({
          id: "Version",
          fqn: "Version",
          instanceId: "00000000000000000000000000000000",
          news: {
            app: "service-1",
            artifactPath: fixtureArtifactPath,
          },
          olds: undefined,
          output: undefined,
          session: undefined as never,
          bindings: [],
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("artifact upload failed");
      expect((error as Error).message).toContain("HTTP 500");
      expect((error as Error).message).toContain("29 bytes");
      expect((error as Error).message).not.toContain(
        "SIGNED_UPLOAD_SECRET_SENTINEL",
      );
      expect(calls).toContainEqual(["deleteDeployment", "version-1"]);
    }).pipe(
      Effect.provide(deploymentProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, currentClient(client))),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
      Effect.provide(PlatformServices),
    );
  });

  it.effect(
    "preserves reconcile and cleanup failures for an orphaned deployment",
    () => {
      const startError = new PrismaApiError({
        method: "POST",
        path: "/v1/deployments/version-1/start",
        status: 500,
        message: "start failed",
      });
      const deleteError = new PrismaApiError({
        method: "DELETE",
        path: "/v1/deployments/version-1",
        status: 500,
        message: "cleanup failed",
      });
      const client = {
        createAppDeployment: () =>
          Effect.succeed({
            id: "version-1",
            type: "deployment" as const,
            url: "https://api.prisma.test/v1/deployments/version-1",
            foundryVersionId: "foundry-1",
            uploadUrl: null,
          }),
        getDeployment: (id: string) =>
          Effect.succeed({
            id,
            type: "deployment" as const,
            url: `https://api.prisma.test/v1/deployments/${id}`,
            foundryVersionId: "foundry-1",
            status: "new",
            previewDomain: null,
            createdAt: "2026-01-01T00:00:00Z",
          }),
        startDeployment: () => Effect.fail(startError),
        deleteDeployment: () => Effect.fail(deleteError),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* PrismaDeployment.Provider;
        const error = yield* provider
          .reconcile({
            id: "Version",
            fqn: "Version",
            instanceId: "00000000000000000000000000000000",
            news: {
              app: "service-1",
              skipCodeUpload: true,
              start: true,
            },
            olds: undefined,
            output: undefined,
            session: undefined as never,
            bindings: [],
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).message).toContain("version-1");
        expect((error as AggregateError).message).toContain(
          "DELETE /v1/deployments/version-1",
        );
        expect((error as AggregateError).errors).toHaveLength(2);
        expect((error as AggregateError).errors[0]).toBe(startError);
        expect(
          ((error as AggregateError).errors[1] as Error).message,
        ).toContain("cleanup failed");
      }).pipe(
        Effect.provide(deploymentProviderLive()),
        Effect.provide(Layer.succeed(PrismaClient, currentClient(client))),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect("deletes created deployment when start fails", () => {
    const calls: Array<[string, unknown?]> = [];
    const client = {
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

    return Effect.gen(function* () {
      const provider = yield* PrismaDeployment.Provider;
      const error = yield* provider
        .reconcile({
          id: "Version",
          fqn: "Version",
          instanceId: "00000000000000000000000000000000",
          news: {
            app: "service-1",
            skipCodeUpload: true,
            start: true,
          },
          olds: undefined,
          output: undefined,
          session: undefined as never,
          bindings: [],
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(PrismaApiError);
      expect((error as PrismaApiError).message).toBe("start failed");
      expect(calls).toContainEqual(["deleteDeployment", "version-1"]);
    }).pipe(
      Effect.provide(deploymentProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, currentClient(client))),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect(
    "preserves a deployment when promotion commit state is ambiguous",
    () => {
      const calls: Array<[string, unknown?]> = [];
      let status = "new";
      const client = {
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
            status,
            previewDomain: "version-1.preview.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
        listAppDeployments: () =>
          Effect.succeed([
            {
              id: "version-1",
              type: "deployment" as const,
              url: "https://api.prisma.test/v1/deployments/version-1",
              foundryVersionId: "foundry-1",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ]),
        startDeployment: (id: string) =>
          Effect.sync(() => {
            calls.push(["startDeployment", id]);
            status = "running";
            return { previewDomain: "version-1.preview.prisma.build" };
          }),
        getApp: (id: string) => {
          calls.push(["getApp", id]);
          return Effect.succeed({
            id,
            type: "app" as const,
            url: `https://api.prisma.test/v1/apps/${id}`,
            name: "api",
            region: { id: "us-east-1", name: "US East" },
            projectId: "project-1",
            branchId: null,
            latestDeploymentId: null,
            appEndpointDomain: "api.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          });
        },
        promoteApp: (
          appId: string,
          { deploymentId }: { deploymentId: string },
        ) => {
          calls.push(["promoteApp", { appId, deploymentId }]);
          return Effect.fail(
            new PrismaApiError({
              method: "POST",
              path: `/v1/apps/${appId}/promote`,
              status: 500,
              message: "promote failed",
            }),
          );
        },
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
            status = "stopped";
          }),
        deleteDeployment: (id: string) => {
          calls.push(["deleteDeployment", id]);
          return Effect.void;
        },
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* PrismaDeployment.Provider;
        const error = yield* provider
          .reconcile({
            id: "Version",
            fqn: "Version",
            instanceId: "00000000000000000000000000000000",
            news: {
              app: "service-1",
              skipCodeUpload: true,
              promote: true,
            },
            olds: undefined,
            output: undefined,
            session: undefined as never,
            bindings: [],
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).message).toContain("commit state");
        expect(calls).not.toContainEqual(["deleteDeployment", "version-1"]);
      }).pipe(
        Effect.provide(deploymentProviderLive()),
        Effect.provide(Layer.succeed(PrismaClient, currentClient(client))),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect("uploads version artifact bytes from artifactPath", () => {
    let uploaded:
      | { url: string; contentType: string | undefined; bytes: Uint8Array }
      | undefined;
    const client = {
      createAppDeployment: (_appId: string, input: unknown) =>
        Effect.succeed({
          id: "version-1",
          type: "deployment" as const,
          url: "https://api.prisma.test/v1/deployments/version-1",
          foundryVersionId: "foundry-1",
          uploadUrl: "https://upload.prisma.test/version.tar.gz",
          input,
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
        const bytes =
          body._tag === "Uint8Array"
            ? body.body
            : body._tag === "Stream"
              ? yield* Stream.runCollect(body.stream).pipe(
                  Effect.orDie,
                  Effect.map((chunks) => {
                    const output = new Uint8Array(
                      chunks.reduce(
                        (total, chunk) => total + chunk.byteLength,
                        0,
                      ),
                    );
                    let offset = 0;
                    for (const chunk of chunks) {
                      output.set(chunk, offset);
                      offset += chunk.byteLength;
                    }
                    return output;
                  }),
                )
              : new Uint8Array();
        uploaded = {
          url: request.url,
          contentType:
            body._tag === "Uint8Array" || body._tag === "Stream"
              ? body.contentType
              : undefined,
          bytes,
        };
        return HttpClientResponse.fromWeb(request, new Response(null));
      }),
    );

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-version-artifact-",
      });
      const artifactPath = path.join(root, "version.tar.gz");
      yield* fs.writeFileString(artifactPath, "version-archive");

      const provider = yield* PrismaDeployment.Provider;
      const output = yield* provider.reconcile({
        id: "Version",
        fqn: "Version",
        instanceId: "00000000000000000000000000000000",
        news: {
          app: "service-1",
          artifactPath,
        },
        olds: undefined,
        output: undefined,
        session: undefined as never,
        bindings: [],
      });

      expect(output.deploymentId).toBe("version-1");
      expect(output.artifactHash).toBeDefined();
      expect(uploaded?.url).toBe("https://upload.prisma.test/version.tar.gz");
      expect(uploaded?.contentType).toBe("application/octet-stream");
      expect(new TextDecoder().decode(uploaded?.bytes)).toBe("version-archive");
    }).pipe(
      Effect.provide(deploymentProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, currentClient(client))),
      Effect.provide(Layer.succeed(HttpClient.HttpClient, http)),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("reads a saved deployment through the canonical route", () => {
    const calls: Array<[string, unknown?]> = [];
    const client = {
      listAppDeployments: (appId: string) =>
        Effect.sync(() => {
          calls.push(["listAppDeployments", appId]);
          return [
            {
              id: "version-1",
              type: "deployment" as const,
              url: "https://api.prisma.test/v1/deployments/version-1",
              foundryVersionId: "foundry-1",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ];
        }),
      getDeployment: (id: string) =>
        Effect.sync(() => {
          calls.push(["getDeployment", id]);
          return {
            id,
            type: "deployment" as const,
            url: `https://api.prisma.test/v1/deployments/${id}`,
            foundryVersionId: "foundry-1",
            status: "stopped",
            previewDomain: "version-1.preview.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          };
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* PrismaDeployment.Provider;
      const output = yield* provider.read!({
        id: "Version",
        fqn: "Version",
        instanceId: "00000000000000000000000000000000",
        olds: {
          app: "service-1",
        },
        output: {
          deploymentId: "version-1",
          appId: "service-1",
          foundryVersionId: "foundry-1",
          status: "running",
          previewDomain: undefined,
          artifactHash: undefined,
          appEndpointDomain: undefined,
          createdAt: "2026-01-01T00:00:00Z",
        },
      });

      expect(output?.deploymentId).toBe("version-1");
      expect(output?.status).toBe("stopped");
      expect(calls).toEqual([
        ["getDeployment", "version-1"],
        ["listAppDeployments", "service-1"],
      ]);
    }).pipe(
      Effect.provide(deploymentProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, currentClient(client))),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect(
    "does not adopt an unrelated latest deployment on a cold read",
    () => {
      const client = {
        listAppDeployments: () =>
          Effect.die("cold reads must not enumerate or adopt deployments"),
        getDeployment: () =>
          Effect.die("cold reads have no persisted deployment identity"),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* PrismaDeployment.Provider;
        const output = yield* provider.read!({
          id: "Deployment",
          fqn: "Deployment",
          instanceId: "00000000000000000000000000000000",
          olds: { app: "app-1" },
          output: undefined,
        });

        expect(output).toBeUndefined();
      }).pipe(
        Effect.provide(deploymentProviderLive()),
        Effect.provide(Layer.succeed(PrismaClient, client)),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect("uses the output App ID when reading a saved deployment", () => {
    const calls: Array<[string, unknown?]> = [];
    const client = {
      listAppDeployments: (appId: string) =>
        Effect.sync(() => {
          calls.push(["listAppDeployments", appId]);
          return [
            {
              id: "version-1",
              type: "deployment" as const,
              url: "https://api.prisma.test/v1/deployments/version-1",
              foundryVersionId: "foundry-1",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ];
        }),
      getDeployment: (id: string) =>
        Effect.sync(() => {
          calls.push(["getDeployment", id]);
          return {
            id,
            type: "deployment" as const,
            url: `https://api.prisma.test/v1/deployments/${id}`,
            foundryVersionId: "foundry-1",
            status: "running",
            previewDomain: "version-1.preview.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          };
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* PrismaDeployment.Provider;
      const output = yield* provider.read!({
        id: "Version",
        fqn: "Version",
        instanceId: "00000000000000000000000000000000",
        olds: {
          app: "service-from-olds",
        },
        output: {
          deploymentId: "version-1",
          appId: "service-from-output",
          foundryVersionId: "foundry-1",
          status: "stopped",
          previewDomain: undefined,
          artifactHash: undefined,
          appEndpointDomain: undefined,
          createdAt: "2026-01-01T00:00:00Z",
        },
      });

      expect(output?.appId).toBe("service-from-output");
      expect(output?.status).toBe("running");
      expect(calls).toEqual([
        ["getDeployment", "version-1"],
        ["listAppDeployments", "service-from-output"],
      ]);
    }).pipe(
      Effect.provide(deploymentProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, currentClient(client))),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect(
    "falls back to the foundry version ID when the saved deployment is gone",
    () => {
      const calls: Array<[string, unknown?]> = [];
      const notFound = (path: string) =>
        new PrismaApiError({
          method: "GET",
          path,
          status: 404,
          message: "not found",
        });
      const client = {
        listAppDeployments: (appId: string, query: unknown) =>
          Effect.sync(() => {
            calls.push(["listAppDeployments", { appId, query }]);
            return [
              {
                id: "version-new",
                type: "deployment" as const,
                url: "https://api.prisma.test/v1/deployments/version-new",
                foundryVersionId: "foundry-1",
                createdAt: "2026-01-01T00:00:00Z",
              },
            ];
          }),
        getDeployment: (id: string) =>
          Effect.gen(function* () {
            calls.push(["getDeployment", id]);
            if (id === "version-old") {
              return yield* Effect.fail(notFound(`/v1/deployments/${id}`));
            }
            return {
              id,
              type: "deployment" as const,
              url: `https://api.prisma.test/v1/deployments/${id}`,
              foundryVersionId: "foundry-1",
              status: "running",
              previewDomain: "version-new.preview.prisma.build",
              createdAt: "2026-01-01T00:00:00Z",
            };
          }),
      } as unknown as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* PrismaDeployment.Provider;
        const output = yield* provider.read!({
          id: "Version",
          fqn: "Version",
          instanceId: "00000000000000000000000000000000",
          olds: {
            app: "service-from-olds",
          },
          output: {
            deploymentId: "version-old",
            appId: "service-from-output",
            foundryVersionId: "foundry-1",
            status: "stopped",
            previewDomain: undefined,
            artifactHash: undefined,
            appEndpointDomain: undefined,
            createdAt: "2026-01-01T00:00:00Z",
          },
        });

        expect(output?.deploymentId).toBe("version-new");
        expect(output?.appId).toBe("service-from-output");
        expect(calls).toEqual([
          ["getDeployment", "version-old"],
          [
            "listAppDeployments",
            { appId: "service-from-output", query: { limit: 100 } },
          ],
          ["getDeployment", "version-new"],
        ]);
      }).pipe(
        Effect.provide(deploymentProviderLive()),
        Effect.provide(Layer.succeed(PrismaClient, currentClient(client))),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect("rejects ambiguous Foundry-version recovery matches", () => {
    const client = {
      getDeployment: (id: string) =>
        Effect.fail(
          new PrismaApiError({
            method: "GET",
            path: `/v1/deployments/${id}`,
            status: 404,
            message: "not found",
          }),
        ),
      listAppDeployments: () =>
        Effect.succeed([
          {
            id: "deployment-a",
            type: "deployment" as const,
            url: "https://api.prisma.test/v1/deployments/deployment-a",
            foundryVersionId: "foundry-1",
            createdAt: "2026-01-01T00:00:00Z",
          },
          {
            id: "deployment-b",
            type: "deployment" as const,
            url: "https://api.prisma.test/v1/deployments/deployment-b",
            foundryVersionId: "foundry-1",
            createdAt: "2026-01-01T00:00:01Z",
          },
        ]),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* PrismaDeployment.Provider;
      const error = yield* provider.read!({
        id: "Deployment",
        fqn: "Deployment",
        instanceId: "00000000000000000000000000000000",
        olds: { app: "app-1" },
        output: {
          deploymentId: "deployment-missing",
          appId: "app-1",
          foundryVersionId: "foundry-1",
          status: "new",
          previewDomain: null,
          appEndpointDomain: undefined,
          createdAt: undefined,
        },
      }).pipe(Effect.flip);

      expect((error as Error).message).toContain("ambiguous recovery match");
    }).pipe(
      Effect.provide(deploymentProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, currentClient(client))),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("replaces when artifactPath contents change", () => {
    const client = {} as PrismaManagementClient;

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-version-diff-",
      });
      const artifactPath = path.join(root, "version.tar.gz");
      yield* fs.writeFileString(artifactPath, "new-version");

      const provider = yield* PrismaDeployment.Provider;
      const diff = yield* provider.diff!({
        id: "Version",
        fqn: "Version",
        instanceId: "00000000000000000000000000000000",
        olds: {
          app: "service-1",
          artifactPath,
        },
        news: {
          app: "service-1",
          artifactPath,
        },
        oldBindings: [],
        newBindings: [],
        output: {
          deploymentId: "version-1",
          appId: "service-1",
          foundryVersionId: "foundry-1",
          status: "new",
          previewDomain: null,
          artifactHash: "old-hash",
          appEndpointDomain: undefined,
          createdAt: "2026-01-01T00:00:00Z",
        },
      } as never);

      expect(diff).toEqual({ action: "replace" });
    }).pipe(
      Effect.provide(deploymentProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, currentClient(client))),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("replaces changed artifacts even when app is unresolved", () => {
    const client = {} as PrismaManagementClient;

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-prisma-version-unresolved-diff-",
      });
      const artifactPath = path.join(root, "version.tar.gz");
      yield* fs.writeFileString(artifactPath, "new-version");

      const provider = yield* PrismaDeployment.Provider;
      const diff = yield* provider.diff!({
        id: "Version",
        fqn: "Version",
        instanceId: "00000000000000000000000000000000",
        olds: {
          app: "service-1",
          artifactPath,
        },
        news: {
          app: Output.asOutput("service-1"),
          artifactPath,
        },
        oldBindings: [],
        newBindings: [],
        output: {
          deploymentId: "version-1",
          appId: "service-1",
          foundryVersionId: "foundry-1",
          status: "new",
          previewDomain: null,
          artifactHash: "old-hash",
          appEndpointDomain: undefined,
          createdAt: "2026-01-01T00:00:00Z",
        },
      } as never);

      expect(diff).toEqual({ action: "replace" });
    }).pipe(
      Effect.provide(deploymentProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, currentClient(client))),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect(
    "replaces when the persisted App changes from an unresolved old prop",
    () => {
      const client = {} as PrismaManagementClient;

      return Effect.gen(function* () {
        const artifact = new TextEncoder().encode("same-version\n");
        const artifactHash = yield* sha256Object({
          artifact: yield* sha256(artifact),
          contentType: "application/octet-stream",
        });
        const provider = yield* PrismaDeployment.Provider;
        const diff = yield* provider.diff!({
          id: "Deployment",
          fqn: "Deployment",
          instanceId: "00000000000000000000000000000000",
          olds: {
            app: Output.asOutput("app-old"),
            artifactPath: sameArtifactPath,
          },
          news: {
            app: "app-new",
            artifactPath: sameArtifactPath,
          },
          oldBindings: [],
          newBindings: [],
          output: {
            deploymentId: "deployment-1",
            appId: "app-old",
            foundryVersionId: "foundry-1",
            status: "new",
            previewDomain: null,
            artifactHash,
            appEndpointDomain: undefined,
            createdAt: "2026-01-01T00:00:00Z",
          },
        } as never);

        expect(diff).toEqual({ action: "replace" });
      }).pipe(
        Effect.provide(deploymentProviderLive()),
        Effect.provide(Layer.succeed(PrismaClient, currentClient(client))),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect("does not replace when artifact bytes are unchanged", () => {
    const client = {} as PrismaManagementClient;

    return Effect.gen(function* () {
      const artifact = new TextEncoder().encode("same-version\n");
      const artifactHash = yield* sha256Object({
        artifact: yield* sha256(artifact),
        contentType: "application/octet-stream",
      });

      const provider = yield* PrismaDeployment.Provider;
      const diff = yield* provider.diff!({
        id: "Version",
        fqn: "Version",
        instanceId: "00000000000000000000000000000000",
        olds: {
          app: "service-1",
          artifactPath: sameArtifactPath,
        },
        news: {
          app: "service-1",
          artifactPath: sameArtifactPath,
        },
        oldBindings: [],
        newBindings: [],
        output: {
          deploymentId: "version-1",
          appId: "service-1",
          foundryVersionId: "foundry-1",
          status: "new",
          previewDomain: null,
          artifactHash,
          appEndpointDomain: undefined,
          createdAt: "2026-01-01T00:00:00Z",
        },
      } as never);

      expect(diff).toBeUndefined();
    }).pipe(
      Effect.provide(deploymentProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, currentClient(client))),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("replays promotion to repair Compute endpoint drift", () => {
    const calls: Array<[string, unknown?]> = [];
    let latestDeploymentId: string | null = null;
    let status = "new";

    const service = () => ({
      id: "service-1",
      type: "app" as const,
      url: "https://api.prisma.test/v1/apps/service-1",
      name: "api",
      region: { id: "us-east-1", name: "US East" },
      projectId: "project-1",
      branchId: null,
      latestDeploymentId,
      appEndpointDomain: "api.prisma.build",
      createdAt: "2026-01-01T00:00:00Z",
    });

    const client = {
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
          url: `https://api.prisma.test/v1/deployments/${id}`,
          foundryVersionId: "foundry-1",
          status,
          previewDomain: "version-1.preview.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      listAppDeployments: () =>
        Effect.succeed([
          {
            id: "version-1",
            type: "deployment" as const,
            url: "https://api.prisma.test/v1/deployments/version-1",
            foundryVersionId: "foundry-1",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ]),
      startDeployment: (id: string) =>
        Effect.sync(() => {
          calls.push(["startDeployment", id]);
          status = "running";
          return { previewDomain: "version-1.preview.prisma.build" };
        }),
      getApp: (id: string) => {
        calls.push(["getApp", id]);
        return Effect.succeed(service());
      },
      promoteApp: (appId: string, { deploymentId }: { deploymentId: string }) =>
        Effect.sync(() => {
          calls.push(["promoteApp", { appId, deploymentId }]);
          latestDeploymentId = deploymentId;
          return { appEndpointDomain: "api.prisma.build" };
        }),
    } as unknown as PrismaManagementClient;

    const news = {
      app: "service-1",
      skipCodeUpload: true,
      promote: true,
    };

    return Effect.gen(function* () {
      const provider = yield* PrismaDeployment.Provider;
      const first = yield* provider.reconcile({
        id: "Version",
        fqn: "Version",
        instanceId: "00000000000000000000000000000000",
        news,
        olds: undefined,
        output: undefined,
        session: undefined as never,
        bindings: [],
      });

      // Simulate an out-of-band stop between deployments. Reconcile must
      // restore both running state and App routing even though props match.
      status = "stopped";

      const second = yield* provider.reconcile({
        id: "Version",
        fqn: "Version",
        instanceId: "00000000000000000000000000000000",
        news,
        olds: news,
        output: first,
        session: undefined as never,
        bindings: [],
      });

      expect(first.deploymentId).toBe("version-1");
      expect(second.deploymentId).toBe("version-1");
      expect(second.appEndpointDomain).toBe("api.prisma.build");
      expect(calls.filter(([name]) => name === "startDeployment")).toEqual([
        ["startDeployment", "version-1"],
        ["startDeployment", "version-1"],
      ]);
      expect(calls.filter(([name]) => name === "promoteApp")).toEqual([
        ["promoteApp", { appId: "service-1", deploymentId: "version-1" }],
        ["promoteApp", { appId: "service-1", deploymentId: "version-1" }],
      ]);
      expect(
        calls.filter(([name]) => name === "createAppDeployment"),
      ).toHaveLength(1);
    }).pipe(
      Effect.provide(deploymentProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, currentClient(client))),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect(
    "replaces a terminal failed deployment before deleting the failed generation",
    () => {
      const calls: Array<[string, unknown?]> = [];
      let latestDeploymentId: string | null = "version-failed";
      const deployments = new Map<
        string,
        {
          id: string;
          type: "deployment";
          url: string;
          foundryVersionId: string;
          status: string;
          previewDomain: string | null;
          createdAt: string;
        }
      >([
        [
          "version-failed",
          {
            id: "version-failed",
            type: "deployment",
            url: "https://api.prisma.test/v1/deployments/version-failed",
            foundryVersionId: "foundry-failed",
            status: "failed",
            previewDomain: "version-failed.preview.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      ]);
      const client = {
        createAppDeployment: (appId: string, input: unknown) =>
          Effect.sync(() => {
            calls.push(["createAppDeployment", { appId, input }]);
            deployments.set("version-replacement", {
              id: "version-replacement",
              type: "deployment",
              url: "https://api.prisma.test/v1/deployments/version-replacement",
              foundryVersionId: "foundry-replacement",
              status: "new",
              previewDomain: "version-replacement.preview.prisma.build",
              createdAt: "2026-01-02T00:00:00Z",
            });
            return {
              id: "version-replacement",
              type: "deployment" as const,
              url: "https://api.prisma.test/v1/deployments/version-replacement",
              foundryVersionId: "foundry-replacement",
              uploadUrl: null,
            };
          }),
        getDeployment: (id: string) =>
          Effect.sync(() => {
            calls.push(["getDeployment", id]);
            return deployments.get(id)!;
          }),
        listAppDeployments: () =>
          Effect.succeed(
            Array.from(deployments.values()).map(
              ({ id, type, url, foundryVersionId, createdAt }) => ({
                id,
                type,
                url,
                foundryVersionId,
                createdAt,
              }),
            ),
          ),
        startDeployment: (id: string) =>
          Effect.sync(() => {
            calls.push(["startDeployment", id]);
            deployments.get(id)!.status = "running";
            return {
              previewDomain: deployments.get(id)!.previewDomain!,
            };
          }),
        promoteApp: (
          appId: string,
          { deploymentId }: { deploymentId: string },
        ) =>
          Effect.sync(() => {
            calls.push(["promoteApp", { appId, deploymentId }]);
            expect(deployments.has("version-failed")).toBe(true);
            latestDeploymentId = deploymentId;
            return {
              appEndpointDomain: "api.prisma.build",
              reassignedDomains: 0,
            };
          }),
        getApp: (appId: string) =>
          Effect.succeed({
            id: appId,
            type: "app" as const,
            url: `https://api.prisma.test/v1/apps/${appId}`,
            name: "api",
            region: { id: "us-east-1", name: "US East" },
            projectId: "project-1",
            branchId: "branch-main",
            latestDeploymentId,
            appEndpointDomain: "api.prisma.build",
            createdAt: "2026-01-01T00:00:00Z",
          }),
        deleteDeployment: (id: string) =>
          Effect.sync(() => {
            calls.push(["deleteDeployment", id]);
            deployments.delete(id);
          }),
      } as unknown as PrismaManagementClient;
      const news = {
        app: "service-1",
        skipCodeUpload: true,
        promote: true,
      } as const;
      const failedOutput: PrismaDeployment["Attributes"] = {
        deploymentId: "version-failed",
        appId: "service-1",
        foundryVersionId: "foundry-failed",
        status: "failed",
        previewDomain: "version-failed.preview.prisma.build",
        artifactHash: undefined,
        appEndpointDomain: "api.prisma.build",
        createdAt: "2026-01-01T00:00:00Z",
      };

      return Effect.gen(function* () {
        const provider = yield* PrismaDeployment.Provider;
        const action = yield* provider.diff!({
          id: "Version",
          fqn: "Version",
          instanceId: "00000000000000000000000000000000",
          olds: news,
          news,
          oldBindings: [],
          newBindings: [],
          output: failedOutput,
        } as never);
        expect(action).toEqual({ action: "replace" });

        // The engine executes replacement create-before-delete. Reconcile the
        // replacement to its requested running/promoted state before invoking
        // delete for the failed generation.
        const replacement = yield* provider.reconcile({
          id: "Version",
          fqn: "Version",
          instanceId: "11111111111111111111111111111111",
          news,
          olds: undefined,
          output: undefined,
          session: undefined as never,
          bindings: [],
        });
        expect(replacement.deploymentId).toBe("version-replacement");
        expect(replacement.status).toBe("running");
        expect(deployments.has("version-failed")).toBe(true);

        yield* provider.delete({
          id: "Version",
          fqn: "Version",
          instanceId: "00000000000000000000000000000000",
          olds: news,
          output: failedOutput,
          session: undefined as never,
          bindings: [],
        });

        const createIndex = calls.findIndex(
          ([operation]) => operation === "createAppDeployment",
        );
        const promoteIndex = calls.findIndex(
          ([operation]) => operation === "promoteApp",
        );
        const deleteIndex = calls.findIndex(
          ([operation, id]) =>
            operation === "deleteDeployment" && id === "version-failed",
        );
        expect(createIndex).toBeGreaterThanOrEqual(0);
        expect(createIndex).toBeLessThan(promoteIndex);
        expect(promoteIndex).toBeLessThan(deleteIndex);
        expect(deployments.has("version-failed")).toBe(false);
        expect(deployments.get("version-replacement")?.status).toBe("running");
        expect(calls).not.toContainEqual(["startDeployment", "version-failed"]);
      }).pipe(
        Effect.provide(deploymentProviderLive()),
        Effect.provide(Layer.succeed(PrismaClient, currentClient(client))),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect("rejects promotion when start is explicitly disabled", () => {
    const client = {} as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* PrismaDeployment.Provider;
      const error = yield* provider
        .reconcile({
          id: "Version",
          fqn: "Version",
          instanceId: "00000000000000000000000000000000",
          news: {
            app: "service-1",
            skipCodeUpload: true,
            start: false,
            promote: true,
          },
          olds: undefined,
          output: undefined,
          session: undefined as never,
          bindings: [],
        })
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "promote cannot be combined with start: false",
      );
    }).pipe(
      Effect.provide(deploymentProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, currentClient(client))),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("rejects invalid deployment HTTP ports", () => {
    const client = {} as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* PrismaDeployment.Provider;
      for (const http of [0, 65_536, 1.5]) {
        const error = yield* provider
          .reconcile({
            id: "Deployment",
            fqn: "Deployment",
            instanceId: "00000000000000000000000000000000",
            news: {
              app: "app-1",
              skipCodeUpload: true,
              portMapping: { http },
            },
            olds: undefined,
            output: undefined,
            session: undefined as never,
            bindings: [],
          })
          .pipe(Effect.flip);
        expect((error as Error).message).toContain(
          "portMapping.http must be an integer between 1 and 65535",
        );
      }
    }).pipe(
      Effect.provide(deploymentProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, currentClient(client))),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("allows null HTTP port to request the Foundry 8080 default", () => {
    const calls: Array<[string, unknown?]> = [];
    const client = {
      createAppDeployment: (appId: string, input: unknown) =>
        Effect.sync(() => {
          calls.push(["createAppDeployment", { appId, input }]);
          return {
            id: "deployment-1",
            type: "deployment" as const,
            url: "https://api.prisma.test/v1/deployments/deployment-1",
            foundryVersionId: "foundry-1",
            uploadUrl: null,
          };
        }),
      getDeployment: () =>
        Effect.succeed({
          id: "deployment-1",
          type: "deployment" as const,
          url: "https://api.prisma.test/v1/deployments/deployment-1",
          foundryVersionId: "foundry-1",
          status: "new",
          previewDomain: null,
          createdAt: "2026-01-01T00:00:00Z",
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* PrismaDeployment.Provider;
      const output = yield* provider.reconcile({
        id: "Deployment",
        fqn: "Deployment",
        instanceId: "00000000000000000000000000000000",
        news: {
          app: "app-1",
          skipCodeUpload: true,
          portMapping: { http: null },
        },
        olds: undefined,
        output: undefined,
        session: undefined as never,
        bindings: [],
      });

      expect(output.deploymentId).toBe("deployment-1");
      expect(calls).toEqual([
        [
          "createAppDeployment",
          {
            appId: "app-1",
            input: { portMapping: { http: null }, skipCodeUpload: true },
          },
        ],
      ]);
    }).pipe(
      Effect.provide(deploymentProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, currentClient(client))),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("forces reconcile while start or promotion is asserted", () => {
    const client = {} as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* PrismaDeployment.Provider;
      const base = {
        id: "Deployment",
        fqn: "Deployment",
        instanceId: "00000000000000000000000000000000",
        oldBindings: [],
        newBindings: [],
        output: {
          deploymentId: "deployment-1",
          appId: "app-1",
          foundryVersionId: "foundry-1",
          status: "running",
          previewDomain: null,
          appEndpointDomain: undefined,
          createdAt: undefined,
        },
      };
      const start = yield* provider.diff!({
        ...base,
        olds: { app: "app-1", skipCodeUpload: true, start: true },
        news: { app: "app-1", skipCodeUpload: true, start: true },
      } as never);
      const promote = yield* provider.diff!({
        ...base,
        olds: { app: "app-1", skipCodeUpload: true, promote: true },
        news: { app: "app-1", skipCodeUpload: true, promote: true },
      } as never);

      expect(start).toEqual({ action: "update" });
      expect(promote).toEqual({ action: "update" });
    }).pipe(
      Effect.provide(deploymentProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, currentClient(client))),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("rejects a deployment with no artifact source", () => {
    const client = {} as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* PrismaDeployment.Provider;
      const error = yield* provider
        .reconcile({
          id: "Deployment",
          fqn: "Deployment",
          instanceId: "00000000000000000000000000000000",
          news: { app: "app-1" },
          olds: undefined,
          output: undefined,
          session: undefined as never,
          bindings: [],
        })
        .pipe(Effect.flip);

      expect((error as Error).message).toContain(
        "requires artifactPath or skipCodeUpload: true",
      );
    }).pipe(
      Effect.provide(deploymentProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, currentClient(client))),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("starts a deployment through the canonical route", () => {
    const calls: Array<[string, unknown?]> = [];
    let status = "new";
    const client = {
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
          url: `https://api.prisma.test/v1/deployments/${id}`,
          foundryVersionId: "foundry-1",
          status,
          previewDomain: "version-1.preview.prisma.build",
          createdAt: "2026-01-01T00:00:00Z",
        });
      },
      startDeployment: (id: string) =>
        Effect.sync(() => {
          calls.push(["startDeployment", id]);
          status = "running";
          return { previewDomain: "version-1.preview.prisma.build" };
        }),
    } as unknown as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* PrismaDeployment.Provider;
      const output = yield* provider.reconcile({
        id: "Version",
        fqn: "Version",
        instanceId: "00000000000000000000000000000000",
        news: {
          app: "service-1",
          skipCodeUpload: true,
          start: true,
        },
        olds: undefined,
        output: undefined,
        session: undefined as never,
        bindings: [],
      });

      expect(output.status).toBe("running");
      expect(calls).toEqual([
        [
          "createAppDeployment",
          {
            appId: "service-1",
            input: { portMapping: undefined, skipCodeUpload: true },
          },
        ],
        ["getDeployment", "version-1"],
        ["startDeployment", "version-1"],
        ["getDeployment", "version-1"],
      ]);
    }).pipe(
      Effect.provide(deploymentProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, currentClient(client))),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect("tails Deployment logs through the provider", () =>
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
              text: "direct version log",
              byteStart: 0,
              byteEnd: 18,
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
                  Authorization: Redacted.make("Bearer version-token"),
                },
              };
            }),
        } as unknown as PrismaManagementClient;

        const provider = yield* PrismaDeployment.Provider.pipe(
          Effect.provide(deploymentProviderLive()),
          Effect.provide(Layer.succeed(PrismaClient, currentClient(client))),
          Effect.provide(PlatformServices),
        );
        const lines = yield* provider.tail!({
          id: "Deployment",
          fqn: "Deployment",
          instanceId: "00000000000000000000000000000000",
          props: {
            app: "service-1",
          },
          output: {
            deploymentId: "version-1",
            appId: "service-1",
            foundryVersionId: "foundry-1",
            status: "running",
            previewDomain: "version-1.preview.prisma.build",
            appEndpointDomain: undefined,
            createdAt: "2026-01-01T00:00:00Z",
          },
        }).pipe(Stream.runCollect);

        expect(lines.map((line) => line.message)).toEqual([
          "direct version log",
        ]);
        expect(authorization).toBe("Bearer version-token");
        expect(calls).toEqual([
          [
            "getDeploymentLogsRequest",
            { deploymentId: "version-1", query: undefined },
          ],
        ]);
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  );
  it.effect(
    "records a redacted triggers fingerprint and replaces when a value changes",
    () => {
      const secret = "REDEPLOY_SECRET_SENTINEL";
      const client = redeployClient();

      return Effect.gen(function* () {
        const provider = yield* PrismaDeployment.Provider;
        const output = yield* provider.reconcile({
          id: "Deployment",
          fqn: "Deployment",
          instanceId: "00000000000000000000000000000000",
          news: {
            app: "app-1",
            skipCodeUpload: true,
            triggers: { DATABASE_URL: Redacted.make(secret) },
          },
          olds: undefined,
          output: undefined,
          session: undefined as never,
          bindings: [],
        });

        expect(Redacted.isRedacted(output.triggersHash!)).toBe(true);
        const fingerprint = Redacted.value(output.triggersHash!);
        expect(fingerprint).not.toBe(secret);
        expect(fingerprint).not.toContain(secret);
        // encodeState unwraps Redacted, so this is what a state store writes.
        expect(JSON.stringify(encodeState(output))).not.toContain(secret);

        const unchanged = yield* provider.diff!({
          ...triggersDiffBase(output.triggersHash),
          olds: {
            app: "app-1",
            skipCodeUpload: true,
            triggers: { DATABASE_URL: Redacted.make(secret) },
          },
          news: {
            app: "app-1",
            skipCodeUpload: true,
            triggers: { DATABASE_URL: Redacted.make(secret) },
          },
        } as never);
        const changed = yield* provider.diff!({
          ...triggersDiffBase(output.triggersHash),
          olds: {
            app: "app-1",
            skipCodeUpload: true,
            triggers: { DATABASE_URL: Redacted.make(secret) },
          },
          news: {
            app: "app-1",
            skipCodeUpload: true,
            triggers: { DATABASE_URL: Redacted.make(`${secret}-rotated`) },
          },
        } as never);

        expect(unchanged).toBeUndefined();
        expect(changed).toEqual({ action: "replace" });
      }).pipe(
        Effect.provide(deploymentProviderLive()),
        Effect.provide(Layer.succeed(PrismaClient, currentClient(client))),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect("replaces when a plain triggers value changes", () => {
    const client = {} as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* PrismaDeployment.Provider;
      const diff = yield* provider.diff!({
        ...triggersDiffBase(Redacted.make("recorded-fingerprint")),
        olds: {
          app: "app-1",
          skipCodeUpload: true,
          triggers: { FEATURE_FLAG: "off" },
        },
        news: {
          app: "app-1",
          skipCodeUpload: true,
          triggers: { FEATURE_FLAG: "on" },
        },
      } as never);

      expect(diff).toEqual({ action: "replace" });
    }).pipe(
      Effect.provide(deploymentProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, currentClient(client))),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });

  it.effect(
    "keeps a deployment recorded before triggers existed when nothing changed",
    () => {
      const client = {} as PrismaManagementClient;

      return Effect.gen(function* () {
        const provider = yield* PrismaDeployment.Provider;
        const diff = yield* provider.diff!({
          ...triggersDiffBase(undefined),
          olds: {
            app: "app-1",
            skipCodeUpload: true,
            triggers: { FEATURE_FLAG: "on" },
          },
          news: {
            app: "app-1",
            skipCodeUpload: true,
            triggers: { FEATURE_FLAG: "on" },
          },
        } as never);

        expect(diff).toBeUndefined();
      }).pipe(
        Effect.provide(deploymentProviderLive()),
        Effect.provide(Layer.succeed(PrismaClient, currentClient(client))),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(PlatformServices),
      );
    },
  );

  it.effect("replaces when triggers cannot be resolved while planning", () => {
    const client = {} as PrismaManagementClient;

    return Effect.gen(function* () {
      const provider = yield* PrismaDeployment.Provider;
      const recorded = yield* provider.diff!({
        ...triggersDiffBase(Redacted.make("recorded-fingerprint")),
        olds: {
          app: "app-1",
          skipCodeUpload: true,
          triggers: { DATABASE_URL: "postgres://old" },
        },
        news: {
          app: "app-1",
          skipCodeUpload: true,
          triggers: { DATABASE_URL: Output.asOutput("postgres://new") },
        },
      } as never);
      const neverRecorded = yield* provider.diff!({
        ...triggersDiffBase(undefined),
        olds: {
          app: "app-1",
          skipCodeUpload: true,
          triggers: { DATABASE_URL: "postgres://old" },
        },
        news: {
          app: "app-1",
          skipCodeUpload: true,
          triggers: { DATABASE_URL: Output.asOutput("postgres://new") },
        },
      } as never);

      expect(recorded).toEqual({ action: "replace" });
      expect(neverRecorded).toBeUndefined();
    }).pipe(
      Effect.provide(deploymentProviderLive()),
      Effect.provide(Layer.succeed(PrismaClient, currentClient(client))),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(PlatformServices),
    );
  });
});

const redeployClient = () =>
  ({
    createAppDeployment: () =>
      Effect.succeed({
        id: "deployment-1",
        type: "deployment" as const,
        url: "https://api.prisma.test/v1/deployments/deployment-1",
        foundryVersionId: "foundry-1",
      }),
    getDeployment: (id: string) =>
      Effect.succeed({
        id,
        type: "deployment" as const,
        url: "https://api.prisma.test/v1/deployments/deployment-1",
        foundryVersionId: "foundry-1",
        status: "new",
        previewDomain: null,
        createdAt: "2026-01-01T00:00:00Z",
      }),
  }) as unknown as PrismaManagementClient;

const triggersDiffBase = (
  triggersHash: Redacted.Redacted<string> | undefined,
) => ({
  id: "Deployment",
  fqn: "Deployment",
  instanceId: "00000000000000000000000000000000",
  oldBindings: [],
  newBindings: [],
  output: {
    deploymentId: "deployment-1",
    appId: "app-1",
    foundryVersionId: "foundry-1",
    status: "new",
    previewDomain: null,
    artifactHash: undefined,
    triggersHash,
    appEndpointDomain: undefined,
    createdAt: "2026-01-01T00:00:00Z",
  },
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

const withHttpServer = <A, E, R>(
  handler: RequestListener,
  f: (url: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => createHttpServer(handler)),
    (server) => Effect.flatMap(listenHttpServerUrl(server), f),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }).pipe(Effect.ignore),
  );

const listenHttpServerUrl = (server: NodeHttpServer) =>
  Effect.callback<string, Error>((resume) => {
    const complete = () => {
      cleanup();
      const address = server.address();
      if (address && typeof address === "object") {
        resume(Effect.succeed(`http://127.0.0.1:${address.port}`));
      } else {
        resume(Effect.fail(new Error("HTTP server has no TCP address")));
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

    server.once("listening", complete);
    server.once("error", fail);
    server.listen(0, "127.0.0.1");
    return Effect.sync(cleanup);
  });
