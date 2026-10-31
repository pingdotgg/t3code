import { it } from "@effect/vitest";
import { EnvironmentId, SandboxProviderError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { describe, expect } from "vite-plus/test";

import * as SandboxProvisioner from "./SandboxProvisioner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SandboxRecords from "../persistence/SandboxRecords.ts";
import type { SandboxRecord } from "@t3tools/contracts";
import { boatDriver } from "./providers/boat.ts";
import { daytonaDriver } from "./providers/daytona.ts";

const boatSandboxId = "bx_abcdefgh";
const testEnvironmentId = EnvironmentId.make("11111111-1111-4111-8111-111111111111");
const descriptor = {
  environmentId: testEnvironmentId,
  label: "Boat live test",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.1.6",
  orchestrationProtocolVersion: 2,
  capabilities: {},
};

const recordRepository = Layer.succeed(
  SandboxRecords.SandboxRecordRepository,
  SandboxRecords.SandboxRecordRepository.of({
    list: Effect.succeed([]),
    get: () => Effect.succeedNone,
    put: () => Effect.void,
    remove: () => Effect.void,
  }),
);

const testLayer = SandboxProvisioner.layer.pipe(
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(recordRepository),
);

const boatResponse = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClientResponse.fromWeb(
    request,
    Response.json({
      ok: true,
      type: "sandbox.created",
      sandbox: { id: boatSandboxId, name: "Boat sandbox" },
      hostedPorts: [{ port: 3773, url: "https://boat.example/t3" }],
    }),
  );

describe("boatDriver", () => {
  it.effect("creates a sandbox with a public T3 port and reads its URL", () =>
    Effect.gen(function* () {
      const requests: Array<{ method: string; url: string; authorization: string | undefined }> =
        [];
      const client = HttpClient.make((request) => {
        requests.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
        });
        return Effect.succeed(boatResponse(request));
      });

      const created = yield* boatDriver
        .create({
          config: { apiKey: "boat_test" },
          name: "Boat sandbox",
          size: "default",
        })
        .pipe(Effect.provideService(HttpClient.HttpClient, client));

      expect(created).toEqual({
        id: boatSandboxId,
        name: "Boat sandbox",
        publicUrl: "https://boat.example/t3",
      });
      expect(requests).toEqual([
        {
          method: "POST",
          url: "https://boat.dev/api/v1/sandboxes",
          authorization: "Bearer boat_test",
        },
      ]);
    }),
  );

  it.effect("turns a failed command into a provider error that keeps stderr", () => {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ exitCode: 2, stdout: "", stderr: "t3 CLI did not install" }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const error = yield* boatDriver
        .execute({
          config: { apiKey: "boat_test" },
          sandboxId: boatSandboxId,
          command: "install",
          timeoutSeconds: 60,
        })
        .pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.flip);

      expect(error).toBeInstanceOf(SandboxProviderError);
      expect(error.stage).toBe("install");
      expect(error.detail).toContain("t3 CLI did not install");
    });
  });
});

describe("daytonaDriver", () => {
  it.effect("starts a sandbox, runs through the toolbox proxy, and reads a preview URL", () =>
    Effect.gen(function* () {
      const requests: Array<{ method: string; url: string }> = [];
      const client = HttpClient.make((request) => {
        requests.push({ method: request.method, url: request.url });
        if (request.url.endsWith("/sandbox")) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ id: "sandbox_1", name: "Daytona sandbox", state: "creating" }),
            ),
          );
        }
        if (request.url.endsWith("/sandbox/sandbox_1/toolbox-proxy-url")) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ url: "https://toolbox.example/toolbox" }),
            ),
          );
        }
        if (request.url.endsWith("/process/execute")) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ exitCode: 0, result: "Token: pair_xyz" }),
            ),
          );
        }
        if (request.url.endsWith("/ports/3773/preview-url")) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ url: "https://3773-sandbox_1.proxy.daytona.works" }),
            ),
          );
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ id: "sandbox_1", name: "Daytona sandbox", state: "started" }),
          ),
        );
      });

      const created = yield* daytonaDriver
        .create({ config: { apiKey: "dtn_test" }, name: "Daytona sandbox", size: "daytona-medium" })
        .pipe(Effect.provideService(HttpClient.HttpClient, client));
      const executed = yield* daytonaDriver
        .execute({
          config: { apiKey: "dtn_test" },
          sandboxId: created.id,
          command: "t3 pair",
          timeoutSeconds: 30,
        })
        .pipe(Effect.provideService(HttpClient.HttpClient, client));
      const preview = yield* daytonaDriver
        .exposePort({ config: { apiKey: "dtn_test" }, sandboxId: created.id, port: 3773 })
        .pipe(Effect.provideService(HttpClient.HttpClient, client));

      expect(created).toEqual({ id: "sandbox_1", name: "Daytona sandbox" });
      expect(executed.stdout).toContain("Token: pair_xyz");
      expect(preview).toBe("https://3773-sandbox_1.proxy.daytona.works");
      expect(requests.map((request) => request.url)).toContain(
        "https://toolbox.example/toolbox/sandbox_1/process/execute",
      );
    }),
  );
});

describe("boat credential environments", () => {
  it.effect("lists only credential flags and never returns environment secrets", () => {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            environments: [
              {
                name: "base",
                isDefault: true,
                safeForThirdParties: false,
                passGithub: true,
                passSecrets: true,
                passSandboxCredentials: true,
                passAgentsCredentials: true,
                proxyAiCredentials: false,
                envContents: "OPENAI_API_KEY=sk-live-secret",
                secretFiles: [{ path: ".env", contents: "TOKEN=secret" }],
              },
            ],
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const environments = yield* boatDriver.listEnvironments!({
        config: { apiKey: "boat_test" },
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));

      expect(environments).toEqual([
        {
          name: "base",
          isDefault: true,
          safeForThirdParties: false,
          passGithub: true,
          passSecrets: true,
          passSandboxCredentials: true,
          passAgentsCredentials: true,
          proxyAiCredentials: false,
        },
      ]);
      expect(JSON.stringify(environments)).not.toContain("sk-live-secret");
      expect(JSON.stringify(environments)).not.toContain("TOKEN=secret");
    });
  });

  it.effect("refuses a credential environment until the caller confirms it", () => {
    const requests: Array<string> = [];
    const client = HttpClient.make((request) => {
      requests.push(`${request.method} ${request.url}`);
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({})));
    });

    return Effect.gen(function* () {
      const error = yield* SandboxProvisioner.SandboxProvisioner.pipe(
        Effect.flatMap((provisioner) =>
          provisioner.create({
            provider: "boat",
            apiKey: "boat_test",
            environment: "base",
          }),
        ),
        Effect.provide(testLayer),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
      );

      expect(error._tag).toBe("SandboxProviderError");
      if (error._tag !== "SandboxProviderError") return;
      expect(error.stage).toBe("config");
      expect(requests).toEqual([]);
    });
  });
});

describe("SandboxProvisioner lifecycle", () => {
  const memoryRepository = (initial: ReadonlyArray<SandboxRecord> = []) => {
    const records = new Map(initial.map((record) => [record.environmentId, record]));
    const layer = Layer.succeed(
      SandboxRecords.SandboxRecordRepository,
      SandboxRecords.SandboxRecordRepository.of({
        list: Effect.sync(() => [...records.values()]),
        get: (environmentId) =>
          Effect.sync(() => Option.fromUndefinedOr(records.get(environmentId))),
        put: (record) =>
          Effect.sync(() => {
            records.set(record.environmentId, record);
          }),
        remove: (environmentId) =>
          Effect.sync(() => {
            records.delete(environmentId);
          }),
      }),
    );
    return { layer, records };
  };

  const lifecycleClient = (requests: Array<string>) =>
    HttpClient.make((request) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.url.endsWith("/.well-known/t3/environment")) {
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(descriptor)));
      }
      if (request.url.endsWith("/commands")) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(
              requests.filter((entry) => entry.endsWith("/commands")).length === 1
                ? { exitCode: 0, stdout: "", stderr: "" }
                : { exitCode: 0, stdout: "Token: pair_lifecycle\n", stderr: "" },
            ),
          ),
        );
      }
      if (request.url.endsWith("/stop") || request.url.endsWith("/resume")) {
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ ok: true })));
      }
      if (request.url.endsWith(`/sandboxes/${boatSandboxId}`)) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ sandbox: { id: boatSandboxId, state: "ready", error: null } }),
          ),
        );
      }
      return Effect.succeed(boatResponse(request));
    });

  it.effect("stores a record, stops it, and resumes it", () => {
    const requests: Array<string> = [];
    const repository = memoryRepository();
    return Effect.gen(function* () {
      const result = yield* SandboxProvisioner.SandboxProvisioner.pipe(
        Effect.flatMap((provisioner) =>
          Effect.gen(function* () {
            const created = yield* provisioner.create({
              provider: "boat",
              apiKey: "boat_test",
              label: "Lifecycle sandbox",
            });
            const listed = yield* provisioner.list;
            const stopped = yield* provisioner.stop({
              environmentId: created.environmentId,
            });
            const resumed = yield* provisioner.resume({
              environmentId: created.environmentId,
            });
            return { created, listed, stopped, resumed };
          }),
        ),
        Effect.provide(
          SandboxProvisioner.layer.pipe(
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(repository.layer),
          ),
        ),
        Effect.provideService(HttpClient.HttpClient, lifecycleClient(requests)),
      );

      expect(result.created.environmentId).toBe(testEnvironmentId);
      expect(result.listed.sandboxes).toHaveLength(1);
      expect(result.listed.sandboxes[0]?.state).toBe("running");
      expect(result.listed.sandboxes[0]?.ttlMinutes).toBe(480);
      expect(result.listed.sandboxes[0]?.hardDeadlineAt).not.toBeNull();
      expect(result.stopped.sandbox.state).toBe("stopped");
      expect(result.stopped.sandbox.hardDeadlineAt).toBeNull();
      expect(result.resumed.sandbox.state).toBe("running");
      expect(result.resumed.sandbox.hardDeadlineAt).not.toBeNull();
      expect(requests.some((request) => request.endsWith("/stop"))).toBe(true);
      expect(requests.some((request) => request.endsWith("/resume"))).toBe(true);
    });
  });

  it.effect("stops a running sandbox when its hard deadline passes", () => {
    const expired: SandboxRecord = {
      environmentId: testEnvironmentId,
      provider: "boat",
      sandboxId: boatSandboxId,
      label: "Expired sandbox",
      size: "small",
      state: "running",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      httpBaseUrl: "https://boat.example/t3",
      hardDeadlineAt: "1960-01-01T00:00:00.000Z",
      ttlMinutes: 480,
    };
    const repository = memoryRepository([expired]);
    const requests: Array<string> = [];
    return Effect.gen(function* () {
      yield* SandboxProvisioner.SandboxProvisioner.pipe(
        Effect.flatMap((provisioner) => provisioner.sweepDeadlines),
        Effect.provide(
          SandboxProvisioner.layer.pipe(
            Layer.provide(
              ServerSettings.layerTest({
                sandboxProviders: { boat: { apiKey: "boat_test" } },
              }),
            ),
            Layer.provide(repository.layer),
          ),
        ),
        Effect.provideService(HttpClient.HttpClient, lifecycleClient(requests)),
      );

      expect(repository.records.get(testEnvironmentId)?.state).toBe("stopped");
      expect(requests.some((request) => request.endsWith("/stop"))).toBe(true);
    });
  });
});

describe("SandboxProvisioner", () => {
  it.effect("pairs a freshly created Boat sandbox and saves the API key", () => {
    let commandCall = 0;
    const requests: Array<string> = [];
    const client = HttpClient.make((request) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.method === "POST" && request.url.endsWith("/sandboxes")) {
        return Effect.succeed(boatResponse(request));
      }
      if (request.url.endsWith("/.well-known/t3/environment")) {
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(descriptor)));
      }
      if (request.url.endsWith("/commands")) {
        commandCall += 1;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(
              commandCall === 1
                ? { exitCode: 0, stdout: "t3 is running", stderr: "" }
                : {
                    exitCode: 0,
                    stdout: "Pairing URL: http://127.0.0.1:3773/pair#token=abc\nToken: pair_abc\n",
                    stderr: "",
                  },
            ),
          ),
        );
      }
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({})));
    });

    return Effect.gen(function* () {
      const { result, providers } = yield* SandboxProvisioner.SandboxProvisioner.pipe(
        Effect.flatMap((provisioner) =>
          Effect.gen(function* () {
            const created = yield* provisioner.create({
              provider: "boat",
              apiKey: "boat_saved",
              label: "My sandbox",
            });
            return { result: created, providers: yield* provisioner.providers };
          }),
        ),
        Effect.provide(testLayer),
        Effect.provideService(HttpClient.HttpClient, client),
      );

      expect(result).toEqual({
        provider: "boat",
        sandboxId: boatSandboxId,
        environmentId: testEnvironmentId,
        label: "My sandbox",
        httpBaseUrl: "https://boat.example/t3",
        pairingCode: "pair_abc",
      });
      expect(providers.providers.find((provider) => provider.kind === "boat")?.configured).toBe(
        true,
      );
      expect(requests).toEqual([
        "POST https://boat.dev/api/v1/sandboxes",
        `POST https://boat.dev/api/v1/sandboxes/${boatSandboxId}/commands`,
        `POST https://boat.dev/api/v1/sandboxes/${boatSandboxId}/commands`,
        "GET https://boat.example/t3/.well-known/t3/environment",
      ]);
    });
  });

  it.effect("deletes the sandbox when pairing fails", () => {
    const requests: Array<string> = [];
    const client = HttpClient.make((request) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.method === "POST" && request.url.endsWith("/sandboxes")) {
        return Effect.succeed(boatResponse(request));
      }
      if (request.url.endsWith("/commands")) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ exitCode: 0, stdout: "", stderr: "" }),
          ),
        );
      }
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({})));
    });

    return Effect.gen(function* () {
      const error = yield* SandboxProvisioner.SandboxProvisioner.pipe(
        Effect.flatMap((provisioner) =>
          provisioner.create({ provider: "boat", apiKey: "boat_test" }),
        ),
        Effect.provide(testLayer),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
      );

      expect(error._tag).toBe("SandboxProviderError");
      if (error._tag !== "SandboxProviderError") return;
      expect(error.stage).toBe("pair");
      expect(requests.at(-1)).toBe(`DELETE https://boat.dev/api/v1/sandboxes/${boatSandboxId}`);
    });
  });
});
