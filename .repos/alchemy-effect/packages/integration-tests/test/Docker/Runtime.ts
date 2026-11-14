import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import { Docker } from "@alchemy.run/docker";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const swarmLocalNodeState = (): string | undefined => {
  const result = NodeChildProcess.spawnSync(
    "docker",
    ["info", "--format", "{{.Swarm.LocalNodeState}}"],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  return result.status === 0 ? String(result.stdout).trim() : undefined;
};

/**
 * Idempotently provision the local single-node swarm the `Docker.Service`
 * tests deploy to. A single-node manager on the local engine is harmless —
 * regular (non-swarm) docker usage is unaffected — and stays active across
 * runs so repeated invocations are a no-op. Deactivate manually with
 * `docker swarm leave --force`.
 *
 * Concurrent test files race the init; the loser's "already part of a swarm"
 * error is folded into success by re-checking the node state.
 */
export const ensureDockerSwarm: Effect.Effect<void, Error> = Effect.suspend(() => {
  if (swarmLocalNodeState() === "active") return Effect.void;
  const init = NodeChildProcess.spawnSync(
    "docker",
    // 127.0.0.1 keeps init deterministic on hosts with several network
    // interfaces (init otherwise refuses to pick an advertise address).
    ["swarm", "init", "--advertise-addr", "127.0.0.1"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  if (init.status === 0 || swarmLocalNodeState() === "active") {
    return Effect.void;
  }
  return Effect.fail(new Error(`docker swarm init failed: ${String(init.stderr).trim()}`));
});

export const findAvailablePort = () =>
  Effect.callback<number, Error>((resume) => {
    const server = NodeNet.createServer();
    server.unref();
    server.on("error", (error) => resume(Effect.fail(error)));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => {
        if (error) {
          resume(Effect.fail(error));
        } else if (port) {
          resume(Effect.succeed(port));
        } else {
          resume(Effect.fail(new Error("Failed to allocate a free host port")));
        }
      });
    });
  });

// bcrypt htpasswd entry for alchemy:alchemy-test-password (`htpasswd -Bbn`).
const REGISTRY_HTPASSWD = "alchemy:$2y$05$7OoaHcebvt.2oLcNt7oRsOOALGNXUWi8IHUxTMRu9BWyXWDgM/3BK";

/**
 * Run an htpasswd-protected `registry:2` on a free localhost port for the
 * current scope. Anonymous requests get `401`, and nothing on the host holds
 * a `docker login` for the ephemeral port, so every pull/push must carry the
 * returned `credentials`.
 */
export const authenticatedRegistry = Effect.fn(function* () {
  const docker = yield* Docker;
  const client = yield* HttpClient.HttpClient;
  const port = yield* findAvailablePort();
  const host = `localhost:${port}`;
  const name = `alchemy-test-registry-${port}`;
  yield* Effect.addFinalizer(() => docker.run(["rm", "-f", name]).pipe(Effect.ignore));
  yield* docker.run([
    "run",
    "-d",
    "--name",
    name,
    "-p",
    `${port}:5000`,
    "-e",
    `HTPASSWD=${REGISTRY_HTPASSWD}`,
    "-e",
    "REGISTRY_AUTH=htpasswd",
    "-e",
    "REGISTRY_AUTH_HTPASSWD_REALM=alchemy-test",
    "-e",
    "REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd",
    "--entrypoint",
    "/bin/sh",
    "registry:2",
    "-c",
    'mkdir -p /auth && echo "$HTPASSWD" > /auth/htpasswd && exec registry serve /etc/docker/registry/config.yml',
  ]);
  // Any HTTP response (an anonymous 401) means the registry is serving.
  yield* client
    .get(`http://${host}/v2/`)
    .pipe(Effect.retry({ schedule: Schedule.exponential("250 millis"), times: 20 }));

  const credentials = {
    server: host,
    username: "alchemy",
    password: Redacted.make("alchemy-test-password"),
  };
  const basic = Buffer.from("alchemy:alchemy-test-password").toString("base64");

  /** Whether `repository:tag` was published, checked over the registry API. */
  const hasManifest = (repository: string, tag: string) =>
    client
      .execute(
        HttpClientRequest.head(`http://${host}/v2/${repository}/manifests/${tag}`).pipe(
          HttpClientRequest.setHeaders({
            authorization: `Basic ${basic}`,
            accept: [
              "application/vnd.oci.image.index.v1+json",
              "application/vnd.oci.image.manifest.v1+json",
              "application/vnd.docker.distribution.manifest.list.v2+json",
              "application/vnd.docker.distribution.manifest.v2+json",
            ].join(", "),
          }),
        ),
      )
      .pipe(Effect.map((response) => response.status === 200));

  return { host, credentials, hasManifest };
});

/**
 * Run an anonymous `registry:2` on a free localhost port for the current
 * scope, so plain `docker pull` (no credentials) can fetch what was pushed.
 */
export const localRegistry = Effect.fn(function* () {
  const docker = yield* Docker;
  const client = yield* HttpClient.HttpClient;
  const port = yield* findAvailablePort();
  const host = `localhost:${port}`;
  const name = `alchemy-test-registry-${port}`;
  yield* Effect.addFinalizer(() => docker.run(["rm", "-f", name]).pipe(Effect.ignore));
  yield* docker.run(["run", "-d", "--name", name, "-p", `${port}:5000`, "registry:2"]);
  yield* client
    .get(`http://${host}/v2/`)
    .pipe(Effect.retry({ schedule: Schedule.exponential("250 millis"), times: 7 }));

  const credentials = {
    server: host,
    username: "alchemy",
    password: Redacted.make("ignored-by-insecure-registry"),
  };

  /** The published manifest digest of `repository:tag`, read over the registry API. */
  const manifestDigest = (repository: string, tag: string) =>
    client
      .execute(
        HttpClientRequest.head(`http://${host}/v2/${repository}/manifests/${tag}`).pipe(
          HttpClientRequest.setHeader(
            "accept",
            [
              "application/vnd.oci.image.index.v1+json",
              "application/vnd.oci.image.manifest.v1+json",
              "application/vnd.docker.distribution.manifest.list.v2+json",
              "application/vnd.docker.distribution.manifest.v2+json",
            ].join(", "),
          ),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.map((response) => response.headers["docker-content-digest"]),
      );

  return { host, credentials, manifestDigest };
});

const buildxAsset = (version: string) =>
  Effect.sync(() => {
    const os = process.platform === "win32" ? "windows" : process.platform;
    const arch = process.arch === "x64" ? "amd64" : process.arch;
    return `buildx-${version}.${os}-${arch}${os === "windows" ? ".exe" : ""}`;
  });

/**
 * Point the Docker CLI at a scratch `DOCKER_CONFIG` for the current scope so
 * the version-dependent publish path runs against a real Buildx plugin of
 * the given release — or against no plugin at all when `version` is
 * `undefined`. The release binary is downloaded once into
 * `.alchemy/cache/buildx`. The daemon is unchanged: `DOCKER_HOST` pins the
 * current context's endpoint, which the scratch config would otherwise lose.
 *
 * Mutates `process.env`; tests using it must be `exclusive`.
 */
export const scopedBuildx = Effect.fn(function* (version: string | undefined) {
  const docker = yield* Docker;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = yield* HttpClient.HttpClient;

  const endpoint = (yield* docker.run([
    "context",
    "inspect",
    "--format",
    "{{.Endpoints.docker.Host}}",
  ])).stdout.trim();
  const config = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-test-docker-config-" });

  if (version !== undefined) {
    const asset = yield* buildxAsset(version);
    const cwd = yield* Effect.sync(() => process.cwd());
    const cached = path.join(cwd, ".alchemy", "cache", "buildx", asset);
    if (!(yield* fs.exists(cached))) {
      const response = yield* client
        .get(`https://github.com/docker/buildx/releases/download/${version}/${asset}`)
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
      const bytes = new Uint8Array(yield* response.arrayBuffer);
      yield* fs.makeDirectory(path.dirname(cached), { recursive: true });
      yield* fs.writeFile(`${cached}.partial`, bytes);
      yield* fs.chmod(`${cached}.partial`, 0o755);
      yield* fs.rename(`${cached}.partial`, cached);
    }
    yield* fs.makeDirectory(path.join(config, "cli-plugins"));
    yield* fs.symlink(cached, path.join(config, "cli-plugins", "docker-buildx"));
  }

  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const previous = {
        DOCKER_CONFIG: process.env.DOCKER_CONFIG,
        DOCKER_HOST: process.env.DOCKER_HOST,
      };
      process.env.DOCKER_CONFIG = config;
      process.env.DOCKER_HOST = endpoint;
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }),
  );

  // Verify the pin took: the CLI now reports exactly this plugin (or none).
  const probe = yield* docker.run(["buildx", "version"]).pipe(Effect.option);
  if (
    version === undefined
      ? probe._tag === "Some"
      : probe._tag === "None" || !probe.value.stdout.includes(` ${version} `)
  ) {
    return yield* Effect.die(
      new Error(
        version === undefined
          ? "A system-wide Buildx plugin is installed; cannot exercise the no-Buildx path on this host."
          : `Expected Buildx ${version} from ${config}/cli-plugins`,
      ),
    );
  }
  return { config };
});
