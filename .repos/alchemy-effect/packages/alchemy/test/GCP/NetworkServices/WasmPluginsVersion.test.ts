import * as GCP from "@/GCP";
import * as Output from "@/Output";
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
  networkservices.getProjectsLocationsWasmPluginsVersions({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const imageUriOf = (repo: { name: any }) =>
  Output.interpolate`${repo.name}/genericArtifacts/plugin:v1`;

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
  "getProjectsLocationsWasmPluginsVersions on a missing version fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project } = yield* GcpEnvironment.current;
      const error = yield* Effect.flip(
        networkservices.getProjectsLocationsWasmPluginsVersions({
          name: `projects/${project}/locations/global/wasmPlugins/alchemy-missing/versions/missing`,
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

test.provider.skipIf(!!process.env.FAST)(
  "create and delete a wasm plugin version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const repo = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ArtifactRegistry.Repository("WasmVer", {
            location: "us-central1",
            format: "GENERIC",
            description: "wasm version artifacts",
          });
        }),
      );

      yield* uploadPluginWasm(repo.name);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const artifacts = yield* GCP.ArtifactRegistry.Repository("WasmVer", {
            repositoryId: repo.repositoryId,
            location: "us-central1",
            format: "GENERIC",
            description: "wasm version artifacts",
          });
          const plugin = yield* GCP.NetworkServices.WasmPlugin("Edge", {
            location: "global",
            description: "version parent",
            labels: { env: "test" },
            mainVersionId: "v1",
            versions: {
              v1: {
                description: "inline v1",
                imageUri: imageUriOf(artifacts),
              },
            },
          });
          const version = yield* GCP.NetworkServices.WasmPluginsVersion("V2", {
            wasmPlugin: plugin.name,
            location: "global",
            wasmPluginVersionId: "v2",
            description: "wasm version a",
            labels: { env: "test" },
            imageUri: imageUriOf(artifacts),
          });
          return { artifacts, plugin, version };
        }),
      );

      expect(created.version.name).toContain("/versions/");
      expect(created.version.wasmPlugin).toEqual(created.plugin.name);
      expect(created.version.wasmPluginVersionId).toEqual("v2");
      expect(created.version.description).toEqual("wasm version a");
      expect(created.version.labels).toMatchObject({ env: "test" });
      expect(created.version.createTime).toEqual(expect.any(String));

      const fetched =
        yield* networkservices.getProjectsLocationsWasmPluginsVersions({
          name: created.version.name,
        });
      expect(fetched.name).toEqual(created.version.name);
      expect(fetched.description).toEqual("wasm version a");
      expect(fetched.labels?.env).toEqual("test");
      expect(
        Object.keys(fetched.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ).toEqual(true);

      const serving = yield* stack.deploy(
        Effect.gen(function* () {
          const artifacts = yield* GCP.ArtifactRegistry.Repository("WasmVer", {
            repositoryId: repo.repositoryId,
            location: "us-central1",
            format: "GENERIC",
            description: "wasm version artifacts",
          });
          const plugin = yield* GCP.NetworkServices.WasmPlugin("Edge", {
            wasmPluginId: created.plugin.wasmPluginId,
            location: "global",
            description: "version parent",
            labels: { env: "test" },
            mainVersionId: "v2",
          });
          const version = yield* GCP.NetworkServices.WasmPluginsVersion("V2", {
            wasmPlugin: plugin.name,
            wasmPluginVersionId: created.version.wasmPluginVersionId,
            location: "global",
            description: "wasm version a",
            labels: { env: "test" },
            imageUri: imageUriOf(artifacts),
          });
          return { artifacts, plugin, version };
        }),
      );

      expect(serving.plugin.name).toEqual(created.plugin.name);
      expect(serving.plugin.mainVersionId).toEqual("v2");
      expect(serving.version.name).toEqual(created.version.name);

      const refetched = yield* networkservices.getProjectsLocationsWasmPlugins({
        name: created.plugin.name,
      });
      expect(refetched.mainVersionId).toEqual("v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.version.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:networkservices", "live"],
    timeout: 120_000,
  },
);
