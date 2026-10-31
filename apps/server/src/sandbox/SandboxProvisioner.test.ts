import { it } from "@effect/vitest";
import { SandboxProviderError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { describe, expect } from "vite-plus/test";

import * as SandboxProvisioner from "./SandboxProvisioner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { boatDriver } from "./providers/boat.ts";
import { daytonaDriver } from "./providers/daytona.ts";

const boatSandboxId = "bx_abcdefgh";

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

describe("SandboxProvisioner", () => {
  it.effect("pairs a freshly created Boat sandbox and saves the API key", () => {
    let commandCall = 0;
    const requests: Array<string> = [];
    const client = HttpClient.make((request) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.method === "POST" && request.url.endsWith("/sandboxes")) {
        return Effect.succeed(boatResponse(request));
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
        Effect.provide(SandboxProvisioner.layer.pipe(Layer.provide(ServerSettings.layerTest()))),
        Effect.provideService(HttpClient.HttpClient, client),
      );

      expect(result).toEqual({
        provider: "boat",
        sandboxId: boatSandboxId,
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
        Effect.provide(SandboxProvisioner.layer.pipe(Layer.provide(ServerSettings.layerTest()))),
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
