import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as networkservices from "@distilled.cloud/gcp/networkservices_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

const waitUntilGone = (name: string) =>
  networkservices.getProjectsLocationsWasmPlugins({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const imageUriOf = (repo: { name: string }) =>
  `${repo.name}/genericArtifacts/plugin:v1`;

const uploadPluginWasm = (repositoryName: string) =>
  Effect.gen(function* () {
    const creds = yield* yield* Credentials;
    const client = yield* HttpClient.HttpClient;
    const url =
      `https://artifactregistry.googleapis.com/upload/v1/${repositoryName}/genericArtifacts:create` +
      `?uploadType=media&filename=plugin.wasm&packageId=plugin&versionId=v1`;
    const response = yield* client.execute(
      HttpClientRequest.post(url).pipe(
        HttpClientRequest.setHeader(
          "Authorization",
          `Bearer ${Redacted.value(creds.accessToken)}`,
        ),
        HttpClientRequest.bodyUint8Array(WASM, "application/octet-stream"),
      ),
    );
    if (response.status === 409) return;
    if (response.status < 200 || response.status >= 300) {
      const body = yield* response.text.pipe(
        Effect.catch(() => Effect.succeed("")),
      );
      return yield* Effect.fail(
        new Error(`generic artifact upload failed: ${response.status} ${body}`),
      );
    }
  }).pipe(
    Effect.retry({
      times: 5,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

test.provider(
  "getProjectsLocationsWasmPlugins on a missing plugin fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        networkservices.getProjectsLocationsWasmPlugins({
          name: `projects/${project}/locations/global/wasmPlugins/alchemy-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkservices", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete a wasm plugin",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const repo = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ArtifactRegistry.Repository("Wasm", {
            location: "us-central1",
            format: "GENERIC",
            description: "wasm plugin artifacts",
          });
        }),
      );

      yield* uploadPluginWasm(repo.name);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const artifacts = yield* GCP.ArtifactRegistry.Repository("Wasm", {
            repositoryId: repo.repositoryId,
            location: "us-central1",
            format: "GENERIC",
            description: "wasm plugin artifacts",
          });
          const plugin = yield* GCP.NetworkServices.WasmPlugin("Edge", {
            location: "global",
            description: "wasm plugin a",
            labels: { env: "test" },
            mainVersionId: "v1",
            logConfig: {
              enable: true,
              sampleRate: 1,
              minLogLevel: "WARN",
            },
            versions: {
              v1: {
                description: "v1",
                imageUri: imageUriOf(repo),
              },
            },
          });
          return { artifacts, plugin };
        }),
      );

      expect(created.plugin.name).toContain("/wasmPlugins/");
      expect(created.plugin.wasmPluginId).toEqual(expect.any(String));
      expect(created.plugin.location).toEqual("global");
      expect(created.plugin.description).toEqual("wasm plugin a");
      expect(created.plugin.labels).toMatchObject({ env: "test" });
      expect(created.plugin.mainVersionId).toEqual("v1");
      expect(created.plugin.logConfig?.enable).toEqual(true);
      expect(created.plugin.createTime).toEqual(expect.any(String));

      const fetched = yield* networkservices.getProjectsLocationsWasmPlugins({
        name: created.plugin.name,
        view: "WASM_PLUGIN_VIEW_FULL",
      });
      expect(fetched.name).toEqual(created.plugin.name);
      expect(fetched.description).toEqual("wasm plugin a");
      expect(fetched.mainVersionId).toEqual("v1");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);
      expect(fetched.versions?.v1).toBeDefined();

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const artifacts = yield* GCP.ArtifactRegistry.Repository("Wasm", {
            repositoryId: repo.repositoryId,
            location: "us-central1",
            format: "GENERIC",
            description: "wasm plugin artifacts",
          });
          const plugin = yield* GCP.NetworkServices.WasmPlugin("Edge", {
            wasmPluginId: created.plugin.wasmPluginId,
            location: "global",
            description: "wasm plugin b",
            labels: { env: "prod", role: "edge" },
            mainVersionId: "v1",
            logConfig: {
              enable: true,
              sampleRate: 0.5,
              minLogLevel: "ERROR",
            },
          });
          return { artifacts, plugin };
        }),
      );

      expect(updated.plugin.name).toEqual(created.plugin.name);
      expect(updated.plugin.description).toEqual("wasm plugin b");
      expect(updated.plugin.labels).toMatchObject({
        env: "prod",
        role: "edge",
      });
      expect(updated.plugin.mainVersionId).toEqual("v1");
      expect(updated.plugin.logConfig?.minLogLevel).toEqual("ERROR");

      const refetched = yield* networkservices.getProjectsLocationsWasmPlugins({
        name: created.plugin.name,
      });
      expect(refetched.description).toEqual("wasm plugin b");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("edge");
      expect(refetched.logConfig?.minLogLevel).toEqual("ERROR");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.plugin.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkservices", "live"],
    timeout: 120_000,
  },
);
