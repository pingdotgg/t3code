import { Credentials } from "@distilled.cloud/gcp/Credentials";
import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

/** Image name {@link pushDockerVersion} pushes into a repository. */
export const IMAGE = "hello";

const sha256 = (bytes: Uint8Array) =>
  Effect.sync(
    () => `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  );

const header = (
  response: HttpClientResponse.HttpClientResponse,
  name: string,
) => {
  const headers = response.headers as {
    get?: (key: string) => string | undefined;
  } & Record<string, string | undefined>;
  return (
    headers.get?.(name) ?? headers[name] ?? headers[name.toLowerCase()] ?? ""
  );
};

const failHttp = (
  label: string,
  response: HttpClientResponse.HttpClientResponse,
) =>
  Effect.gen(function* () {
    const body = yield* response.text.pipe(
      Effect.catch(() => Effect.succeed("")),
    );
    return yield* Effect.fail(
      new Error(`${label} failed: ${response.status} ${body}`),
    );
  });

/**
 * Push a minimal (layerless) Docker image tagged `marker` into `repository`
 * over the registry v2 API, as the deploying principal. Returns the
 * version's full resource name.
 */
export const pushDockerVersion = (
  repository: {
    name: string;
    repositoryId: string;
    project: string;
    location: string;
  },
  marker: string,
) =>
  Effect.gen(function* () {
    const creds = yield* yield* Credentials;
    const client = yield* HttpClient.HttpClient;
    const token = Redacted.value(creds.accessToken);
    const host = `https://${repository.location}-docker.pkg.dev`;
    const imagePath = `${repository.project}/${repository.repositoryId}/${IMAGE}`;
    const auth = (request: HttpClientRequest.HttpClientRequest) =>
      request.pipe(
        HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
      );

    const config = yield* Effect.sync(() =>
      new TextEncoder().encode(
        JSON.stringify({
          architecture: "amd64",
          os: "linux",
          rootfs: { type: "layers", diff_ids: [] },
          config: { Env: [`MARKER=${marker}`] },
        }),
      ),
    );
    const configDigest = yield* sha256(config);

    const start = yield* client.execute(
      auth(HttpClientRequest.post(`${host}/v2/${imagePath}/blobs/uploads/`)),
    );
    if (start.status !== 202) {
      return yield* failHttp("blob upload start", start);
    }
    let location = header(start, "location");
    if (location.startsWith("/")) location = `${host}${location}`;
    const sep = location.includes("?") ? "&" : "?";
    const uploaded = yield* client.execute(
      auth(
        HttpClientRequest.put(`${location}${sep}digest=${configDigest}`).pipe(
          HttpClientRequest.bodyUint8Array(config, "application/octet-stream"),
        ),
      ),
    );
    if (uploaded.status < 200 || uploaded.status >= 300) {
      return yield* failHttp("blob upload", uploaded);
    }

    const manifest = yield* Effect.sync(() =>
      new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 2,
          mediaType: "application/vnd.docker.distribution.manifest.v2+json",
          config: {
            mediaType: "application/vnd.docker.container.image.v1+json",
            size: config.byteLength,
            digest: configDigest,
          },
          layers: [],
        }),
      ),
    );
    const manifestDigest = yield* sha256(manifest);
    const published = yield* client.execute(
      auth(
        HttpClientRequest.put(
          `${host}/v2/${imagePath}/manifests/${marker}`,
        ).pipe(
          HttpClientRequest.bodyUint8Array(
            manifest,
            "application/vnd.docker.distribution.manifest.v2+json",
          ),
        ),
      ),
    );
    if (published.status < 200 || published.status >= 300) {
      return yield* failHttp("manifest put", published);
    }

    return `${repository.name}/packages/${IMAGE}/versions/${manifestDigest}`;
  }).pipe(
    Effect.retry({
      times: 5,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );
