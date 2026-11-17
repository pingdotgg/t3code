import * as NodeHttp from "node:http";
import type * as NodeStream from "node:stream";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  CONTAINER_LOOPBACK_ALIAS,
  containerIdFromPath,
  ensureLoopbackUnixSockets,
  isContainerStartPath,
  loopbackPortsFromEnv,
  mergeSidecarLoopbackHostConfig,
} from "./DockerLoopback.ts";
import { makeDockerLoopbackForwarders } from "./internal/docker-loopback-forwarders.ts";
import { makeDockerUpgradeRouter } from "./internal/docker-upgrade-router.ts";
import { listenOnLoopback } from "./internal/listen-on-loopback.ts";
import { ConfigError, SystemError } from "./RuntimeError.shared.ts";
import type * as WorkerdConfig from "./workerd/Config.ts";

export { CONTAINER_LOOPBACK_ALIAS };

export class Docker extends Context.Service<
  Docker,
  {
    readonly getWorkerdDockerConfiguration: Effect.Effect<
      WorkerdConfig.Worker_ContainerEngine,
      SystemError
    >;
    /** Docker privileges for every local container (see {@link FUSE_CONTAINER_PRIVILEGES}). */
    readonly getContainerPrivileges: Effect.Effect<WorkerdConfig.Worker_DurableObjectNamespace_ContainerOptions_ContainerPrivileges>;
    readonly generateImageTag: (className: string, suffix?: string) => string;
    readonly registerImageEnv: (
      className: string,
      tag: string,
      env: Record<string, string>,
    ) => Effect.Effect<string, never, Scope.Scope>;
    readonly build: (tag: string, image: ContainerImage.Build) => Effect.Effect<void, SystemError>;
    readonly pull: (tag: string, image: ContainerImage.Pull) => Effect.Effect<void, SystemError>;
    readonly validate: (tag: string) => Effect.Effect<void, ConfigError>;
    readonly removeImageTag: (tag: string) => Effect.Effect<void>;
    readonly removeContainer: (tag: string) => Effect.Effect<void, SystemError>;
  }
>()("cloudflare-runtime/Docker") {}

export type ContainerImage = ContainerImage.Build | ContainerImage.Pull | ContainerImage.Ref;

export declare namespace ContainerImage {
  interface Base {
    readonly env?: Record<string, string>;
  }
  export interface Build extends Base {
    readonly dockerfile: string;
    readonly context?: string;
    readonly buildArgs?: Record<string, string>;
    /** BuildKit secrets by id, handed to `docker build` through its environment. */
    readonly buildSecrets?: Record<string, string>;
  }
  export interface Pull extends Base {
    readonly imageUri: string;
  }
  export interface Ref extends Base {
    readonly tag: string;
  }
}

const DEFAULT_DOCKER_HOST =
  process.platform === "win32" ? "//./pipe/docker_engine" : "unix:///var/run/docker.sock";
const DEV_CONTAINER_PREFIX = "alchemy-dev";

const DockerHost = Config.String("DOCKER_HOST");
const DockerBin = Config.String("DOCKER_BIN").pipe(Config.orElse(() => Config.succeed("docker")));
const ContainerEgressInterceptorImage = Config.String("CONTAINER_EGRESS_INTERCEPTOR_IMAGE").pipe(
  Config.orElse(() =>
    Config.succeed(
      "cloudflare/proxy-everything:3cb1195@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8",
    ),
  ),
);

/**
 * The Docker privileges FUSE filesystems (s3fs, tigrisfs, …) need to mount
 * inside a container. Deployed Containers can always mount FUSE, so every
 * local container gets them too.
 */
export const FUSE_CONTAINER_PRIVILEGES = {
  capabilities: ["SYS_ADMIN"],
  devices: [{ pathOnHost: "/dev/fuse", pathInContainer: "/dev/fuse", cgroupPermissions: "rwm" }],
  securityOpt: ["apparmor:unconfined"],
} satisfies WorkerdConfig.Worker_DurableObjectNamespace_ContainerOptions_ContainerPrivileges;

/**
 * Docker's containerd image store rejects combined `repo:tag@digest` pull
 * refs ("cannot overwrite digest"); the digest fully pins the image, so the
 * tag is dropped when both are present.
 */
export const toPullRef = (imageUri: string) => imageUri.replace(/:[^@/]+(?=@sha256:)/, "");

/**
 * Stderr signatures of a docker CLI that cannot run our build. Image builds
 * use BuildKit flags (`--load`, `--provenance=false`), which a CLI without
 * the buildx plugin rejects outright. Its stderr names the flag rather than
 * the missing component, and several distros package the two separately
 * (Arch/CachyOS `docker` vs `docker-buildx`, Debian `docker.io` vs
 * `docker-buildx`), so this is a first-run trap rather than a broken setup.
 */
const BUILDKIT_MISSING_MARKERS = [
  "unknown flag: --load",
  "unknown flag: --provenance",
  "'buildx' is not a docker command",
  "buildx component is missing",
];

/**
 * What to do when a Container `image` can be neither pulled nor found in the
 * local Docker.
 */
export const imageUnavailableHint = (imageUri: string) =>
  `If "${imageUri}" is in a registry, check the name and tag, and run \`docker login\` for a private registry. ` +
  `If it is built on this machine, build or load it before starting: ` +
  `\`docker build --platform linux/amd64 -t ${imageUri} .\` or \`docker load\`.`;

/** Names the missing buildx plugin when docker's own stderr only names the flag. */
export const buildFailureHint = (stderr: string): string | undefined =>
  BUILDKIT_MISSING_MARKERS.some((marker) => stderr.includes(marker))
    ? "This docker CLI has no BuildKit (buildx) plugin, which building container images requires. Install it and retry — e.g. `pacman -S docker-buildx` (Arch/CachyOS), `apt install docker-buildx` (Debian/Ubuntu), or Docker Desktop, which bundles it."
    : undefined;

/**
 * Matches a loopback host (`localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]`)
 * where it denotes a connection target inside an env value: at the start of
 * the value, after a `scheme://` (with optional userinfo), after `=` (DSN
 * keyword form, `host=localhost`), or after whitespace/comma/semicolon
 * delimiters — and followed by a port, path, delimiter, or the end.
 */
const LOOPBACK_HOST =
  /(^|[\s,;=]|\/\/(?:[^/\s@]*@)?)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?=[:/?#]|[\s,;]|$)/g;

/**
 * Rewrite loopback hosts in a container env value to
 * {@link CONTAINER_LOOPBACK_ALIAS} so the value keeps meaning "the developer's
 * machine" from inside the container. Prisma's `prisma+postgres://` client
 * only speaks plain HTTP when the host looks local (contains `localhost`).
 * Applied at container create; production URLs are cloud hosts, so this
 * only fires against local emulators.
 *
 * Native Linux: the alias is `/etc/hosts`-mapped to `127.0.0.1` in the
 * sidecar netns, and a unix-socket tunnel reaches the host process — a
 * SYN to Docker's bridge IP would hit UFW INPUT. Docker Desktop: mapped
 * to `host-gateway`, which already forwards to host loopback.
 */
export const rewriteLoopbackHosts = (value: string) =>
  value.replace(LOOPBACK_HOST, `$1${CONTAINER_LOOPBACK_ALIAS}`);

/**
 * Merge workerd's create-body `Env` with the deployment env alchemy injects,
 * rewriting loopback hosts and **replacing by name**.
 *
 * Appending would leave the original `DATABASE_URL=…127.0.0.1…` in place and
 * add a rewritten copy. glibc/`os.Getenv` (Go, C, Python, Node on Linux)
 * return the first match, so the container would still dial `127.0.0.1`
 * inside its own netns.
 */
export const mergeContainerCreateEnv = (
  originalEnv: ReadonlyArray<string> | undefined,
  imageEnv: Record<string, string> | undefined,
): string[] => {
  const order: string[] = [];
  const values = new Map<string, string | undefined>();
  const set = (name: string, value: string | undefined) => {
    if (!values.has(name)) order.push(name);
    values.set(name, value);
  };
  for (const entry of originalEnv ?? []) {
    const eq = entry.indexOf("=");
    if (eq === -1) {
      set(entry, undefined);
    } else {
      set(entry.slice(0, eq), rewriteLoopbackHosts(entry.slice(eq + 1)));
    }
  }
  for (const [name, value] of Object.entries(imageEnv ?? {})) {
    set(name, rewriteLoopbackHosts(value));
  }
  return order.map((name) => {
    const value = values.get(name);
    return value === undefined ? name : `${name}=${value}`;
  });
};

export const DockerLive = Layer.effect(
  Docker,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runFork = yield* FiberSet.makeRuntime();

    const bin = yield* DockerBin;
    const containerEgressInterceptorImage = yield* ContainerEgressInterceptorImage;
    const registeredImages = new Map<string, { tag: string; env: Record<string, string> }>();
    // Every container created through the proxy carries this runtime's label.
    // Native containers can start from images nobody prepared (snapshots,
    // managed `cloudflare/*` images), so per-image cleanup cannot find them.
    const runtimeLabels = { [RUNTIME_LABEL]: crypto.randomUUID() };
    // Set once workerd asks the proxy to create a container. A runtime that
    // never did has nothing to remove and must not wait on the daemon.
    let createdContainers = false;

    const registeredLoopbackPorts = () => {
      const ports = new Set<number>();
      for (const { env } of registeredImages.values()) {
        for (const port of loopbackPortsFromEnv(env)) ports.add(port);
      }
      return [...ports];
    };

    const getSocketPathFromContext = () =>
      ChildProcess.make(bin, ["context", "ls", "--format", "json"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: false,
      }).pipe(
        (command) => spawner.spawn(command),
        Effect.flatMap((child) =>
          child.stdout.pipe(
            Stream.decodeText,
            Stream.splitLines,
            Stream.filter((line) => line.trim() !== ""),
            Stream.map(
              (line) =>
                JSON.parse(line) as {
                  Current: boolean;
                  DockerEndpoint: string;
                },
            ),
            Stream.runCollect,
            Effect.flatMap((items) => {
              const endpoint = items.find((item) => item.Current)?.DockerEndpoint;
              return endpoint
                ? Effect.succeed(endpoint)
                : Effect.fail(
                    ConfigError.make({
                      subtag: "DockerHostNotFound",
                      message: "Docker host not found",
                    }),
                  );
            }),
          ),
        ),
        Effect.scoped,
      );

    const makeDockerProxyServer = (
      socketPath: string,
      forwarders: Effect.Success<ReturnType<typeof makeDockerLoopbackForwarders>>,
    ) => {
      const forward = (
        req: NodeHttp.IncomingMessage,
        res: NodeHttp.ServerResponse,
        options: { body?: string; afterStart?: Effect.Effect<void, SystemError> } = {},
      ) =>
        Effect.gen(function* () {
          const upstream = yield* sendDockerRequest(socketPath, req, options.body);
          const status = upstream.statusCode ?? 500;
          // Docker answers a repeated start with 304; attaching again repairs
          // forwarding when an earlier start succeeded but its helper failed.
          if (options.afterStart === undefined || (status >= 300 && status !== 304)) {
            res.writeHead(status, upstream.headers);
            upstream.pipe(res, { end: true });
            return;
          }
          const body = yield* readBody(upstream);
          yield* options.afterStart;
          res.writeHead(status, upstream.headers);
          res.end(status === 204 || status === 304 || body.length === 0 ? undefined : body);
        });

      const handle = (req: NodeHttp.IncomingMessage, res: NodeHttp.ServerResponse) =>
        Effect.gen(function* () {
          const isCreateRequest =
            req.method === "POST" && req.url?.startsWith("/containers/create");
          if (isCreateRequest) createdContainers = true;
          if (isCreateRequest && !req.url!.endsWith("-proxy")) {
            const original = yield* readJson<{
              Image: string;
              Env: Array<string>;
              Labels?: Record<string, string>;
            }>(req);
            const image = registeredImages.get(original.Image);
            // A native `start({ image })` can name an image that was never
            // prepared (e.g. a managed `cloudflare/*` image): pull it on demand.
            const pulled = yield* Effect.exit(
              Cache.get(ensuredImages, image?.tag ?? original.Image),
            );
            if (Exit.isFailure(pulled)) return sendError(res, 500, Cause.pretty(pulled.cause));
            return yield* forward(req, res, {
              body: JSON.stringify({
                ...original,
                Image: image?.tag ?? original.Image,
                Env: mergeContainerCreateEnv(original.Env, image?.env),
                Labels: { ...original.Labels, ...runtimeLabels },
              }),
            });
          }
          if (isCreateRequest) {
            // workerd creates two containers per instance: the user container
            // and a `<name>-proxy` networking sidecar whose namespace the user
            // container joins (`NetworkMode: container:<sidecar>`) — so the
            // sidecar's /etc/hosts is what the user container resolves against.
            // Docker Desktop maps the alias through host-gateway (reaches host
            // 127.0.0.1). Native Linux maps it to 127.0.0.1 in this netns and
            // bind-mounts unix sockets; a SYN to the bridge IP is host INPUT (UFW).
            const original = yield* readJson<{
              Labels?: Record<string, string>;
              HostConfig?: {
                ExtraHosts?: Array<string>;
                Binds?: Array<string>;
                Sysctls?: Record<string, string>;
              };
            }>(req);
            const ports = registeredLoopbackPorts();
            ensureLoopbackUnixSockets(ports);
            return yield* forward(req, res, {
              body: JSON.stringify({
                ...original,
                Labels: { ...original.Labels, ...runtimeLabels },
                HostConfig: {
                  ...mergeSidecarLoopbackHostConfig(original.HostConfig, ports),
                  Sysctls: {
                    ...original.HostConfig?.Sysctls,
                    // Hosts such as Tailscale routers enable src_valid_mark.
                    // The sidecar marks inbound TCP packets for transparent proxying;
                    // including that mark in reverse-path validation drops their ACKs.
                    // Override only the sidecar's network namespace, never the host.
                    "net.ipv4.conf.all.src_valid_mark": "0",
                  },
                },
              }),
            });
          }
          const id = containerIdFromPath(req.url);
          if (req.method === "POST" && isContainerStartPath(req.url) && id !== undefined) {
            return yield* forward(req, res, {
              afterStart: forwarders.attach(id, registeredLoopbackPorts()),
            });
          }
          if (req.method === "DELETE" && id !== undefined) {
            yield* forwarders.detach(id);
          }
          return yield* forward(req, res);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              if (res.headersSent) res.destroy();
              else sendError(res, 502, Cause.pretty(cause));
            }),
          ),
        );

      return NodeHttp.createServer((req, res) => {
        runFork(handle(req, res));
      });
    };

    const run = (
      args: Array<string>,
      stdin: ChildProcess.CommandInput = "ignore",
      env?: Record<string, string>,
    ) =>
      ChildProcess.make(bin, args, {
        stdin,
        stdout: "pipe",
        stderr: "pipe",
        detached: false,
        ...(env === undefined ? {} : { env, extendEnv: true }),
      }).pipe(
        (command) => spawner.spawn(command),
        Effect.flatMap((child) =>
          Effect.all(
            {
              exitCode: child.exitCode,
              stdout: child.stdout.pipe(
                Stream.decodeText,
                Stream.tap(Effect.logDebug),
                Stream.mkString,
              ),
              stderr: child.stderr.pipe(
                Stream.decodeText,
                Stream.tap(Effect.logDebug),
                Stream.mkString,
              ),
            },
            { concurrency: "unbounded" },
          ),
        ),
        Effect.scoped,
      );

    /**
     * `run` resolves with the command's exit code instead of failing on it
     * (some callers, e.g. `inspect`, treat a non-zero exit as a legitimate
     * "not present" answer). Every command whose failure actually matters
     * therefore has to check the code itself: without this, a `docker build`
     * that exits 1 is indistinguishable from a successful build, the image
     * is never created, and the only symptom the user ever sees is workerd
     * reporting `Container exited while waiting for port <port>` on a loop.
     */
    const ensureExitZero = <E>(
      result: { exitCode: number; stdout: string; stderr: string },
      onNonZero: (result: { exitCode: number; stdout: string; stderr: string }) => E,
    ): Effect.Effect<void, E> =>
      result.exitCode === 0 ? Effect.void : Effect.fail(onNonZero(result));

    /**
     * `platform` is omitted for the egress interceptor: it is a host-side
     * sidecar, not a deployable image, so Docker must resolve the
     * host-native variant. Forcing `linux/amd64` there runs it under
     * emulation on arm64 hosts, where its transparent-proxy setup dies at
     * startup with `Fatal error: setsockoptint: protocol not available`.
     * Deployable user images pass `linux/amd64` explicitly, because that is
     * the architecture Cloudflare's container runtime executes.
     */
    const pull = ({ imageUri, platform }: ContainerImage.Pull & { readonly platform?: string }) =>
      run(["pull", toPullRef(imageUri), ...(platform ? ["--platform", platform] : [])]).pipe(
        Effect.mapError((cause) =>
          SystemError.make({
            subtag: "DockerPullFailed",
            message: `Failed to pull image "${imageUri}".`,
            hint: "Ensure Docker is running and the image is available.",
            detail: { bin, imageUri },
            cause,
          }),
        ),
        Effect.flatMap((result) => {
          if (result.exitCode !== 0) {
            return Effect.fail(
              SystemError.make({
                subtag: "DockerPullFailed",
                message: `Failed to pull image "${imageUri}".`,
                hint: "Ensure Docker is running and the image is available.",
                detail: {
                  bin,
                  imageUri,
                  exitCode: result.exitCode,
                  stdout: result.stdout,
                  stderr: result.stderr,
                },
              }),
            );
          }
          return Effect.succeed(result.stdout);
        }),
      );

    const inspect = (tag: string, format: string) =>
      Effect.map(run(["image", "inspect", tag, "--format", format]), (result) => result.stdout);

    // `docker image inspect` prints the image id when present and empty
    // stdout when absent, so only pull when the image is genuinely missing.
    const pullIfMissing = (imageUri: string, platform?: string) =>
      inspect(imageUri, "{{.Id}}").pipe(
        Effect.orElseSucceed(() => undefined),
        Effect.flatMap((id) =>
          id?.trim() ? Effect.void : Effect.asVoid(pull({ imageUri, platform })),
        ),
      );
    // workerd may create a container from an image nobody prepared, such as a
    // managed `cloudflare/*` image. Failed pulls are forgotten and retried.
    const ensuredImages = yield* Cache.makeWith(
      (image: string) => pullIfMissing(image, "linux/amd64"),
      {
        capacity: Number.MAX_SAFE_INTEGER,
        timeToLive: (exit) => (Exit.isFailure(exit) ? 0 : Infinity),
      },
    );

    const list = (ancestor: string) =>
      run([
        "ps",
        "-a",
        "--no-trunc",
        "--filter",
        `ancestor=${ancestor}`,
        "--format",
        "{{.ID}} {{.Names}} {{.Image}}",
      ]).pipe(
        Effect.map((result) =>
          result.stdout
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line) => {
              const [id, name, image] = line.split(" ");
              return { id, name, image };
            })
            .filter((container) => container.image === ancestor),
        ),
      );

    const removeRuntimeContainers = run([
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `label=${RUNTIME_LABEL}=${runtimeLabels[RUNTIME_LABEL]}`,
    ]).pipe(
      Effect.flatMap(({ stdout }) => {
        const ids = stdout.split("\n").filter((id) => id.trim() !== "");
        return ids.length === 0 ? Effect.void : Effect.asVoid(run(["rm", "--force", ...ids]));
      }),
      Effect.timeout("30 seconds"),
      Effect.withLogSpan("docker: remove runtime containers"),
      Effect.ignore,
    );
    // Runs after the runtime (and its workerd) has shut down.
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => (createdContainers ? removeRuntimeContainers : Effect.void)),
    );

    // Connect to the daemon on first use. Only Workers with containers ask for
    // the engine configuration, so every other runtime never touches Docker.
    // It runs in the layer's scope, so it outlives the caller that started it.
    const context = yield* Effect.context<Scope.Scope | ChildProcessSpawner.ChildProcessSpawner>();
    const startDocker = Effect.zipWith(
      DockerHost.pipe(
        Effect.catchTag("ConfigError", getSocketPathFromContext),
        Effect.orElseSucceed(() => DEFAULT_DOCKER_HOST),
        Effect.flatMap(
          Effect.fnUntraced(function* (socketPath) {
            const forwarders = yield* makeDockerLoopbackForwarders({ bin, socketPath });
            const httpProxyPort = yield* listenOnLoopback(
              makeDockerProxyServer(socketPath, forwarders),
            );
            // workerd connects to the router, which forwards `docker exec`
            // streams to Docker directly and everything else to the proxy.
            const router = yield* makeDockerUpgradeRouter({
              dockerSocketPath: socketPath,
              httpProxyPort,
            });
            return `127.0.0.1:${yield* listenOnLoopback(router)}`;
          }),
        ),
      ),
      // Skip the eager pull when the interceptor image is already present
      // locally. `CONTAINER_EGRESS_INTERCEPTOR_IMAGE` can point at a
      // local-only tag that exists in the Docker daemon but resolves in no
      // registry (e.g. a locally-built dev image) — an unconditional
      // `docker pull` there fails, this startup fiber dies, and every
      // caller of `getWorkerdDockerConfiguration` (joined on first use)
      // fails with it. `docker image inspect` prints the image id when
      // present and empty stdout when absent (`run` reports the non-zero
      // exit rather than failing the effect), so only pull when the image
      // is genuinely missing. The sidecar needs the host-native image.
      pullIfMissing(containerEgressInterceptorImage),
      (socketPath) => ({
        localDocker: {
          socketPath,
          containerEgressInterceptorImage,
        },
      }),
      { concurrent: true },
    ).pipe(Effect.provide(context), Effect.forkIn(Context.get(context, Scope.Scope)));
    const docker = yield* Effect.cached(startDocker);

    // Docker refuses to create a container whose device is missing on the
    // host, so a Linux host without /dev/fuse gets the capability alone.
    // VM-based engines (macOS, Windows) always have /dev/fuse in the VM.
    const getContainerPrivileges = yield* Effect.cached(
      Effect.gen(function* () {
        const platform = yield* Effect.sync(() => process.platform);
        const hasFuse =
          platform !== "linux" ||
          (yield* fs.exists("/dev/fuse").pipe(Effect.orElseSucceed(() => false)));
        return hasFuse ? FUSE_CONTAINER_PRIVILEGES : { ...FUSE_CONTAINER_PRIVILEGES, devices: [] };
      }),
    );

    return Docker.of({
      getWorkerdDockerConfiguration: Effect.flatMap(docker, Fiber.join),
      getContainerPrivileges,
      registerImageEnv: (className, tag, env) => {
        const alias = generateImageTag(className);
        return Effect.acquireRelease(
          Effect.sync(() => {
            registeredImages.set(alias, { tag, env });
            ensureLoopbackUnixSockets(loopbackPortsFromEnv(env));
          }),
          () => Effect.sync(() => registeredImages.delete(alias)),
        ).pipe(Effect.as(alias));
      },
      generateImageTag,
      build: (tag, image) =>
        Effect.suspend(() => {
          // Values ride in generated variables: a secret id is the
          // Dockerfile's choice and may shadow one Docker reads itself.
          const secrets = Object.entries(image.buildSecrets ?? {}).map(([id, value], index) => ({
            id,
            variable: `ALCHEMY_BUILD_SECRET_${index}`,
            value,
          }));
          const args = [
            "build",
            "--load",
            "-t",
            tag,
            "--platform",
            "linux/amd64",
            "--provenance=false",
            ...Object.entries(image.buildArgs ?? {}).flatMap(([name, value]) => [
              "--build-arg",
              `${name}=${value}`,
            ]),
            ...secrets.flatMap(({ id, variable }) => ["--secret", `id=${id},env=${variable}`]),
            "-f",
            "-",
            path.resolve(image.context ?? path.dirname(image.dockerfile)),
          ];
          return run(
            args,
            fs.stream(
              image.context
                ? path.resolve(image.context, image.dockerfile)
                : path.resolve(image.dockerfile),
            ),
            secrets.length === 0
              ? undefined
              : Object.fromEntries(secrets.map(({ variable, value }) => [variable, value])),
          ).pipe(
            Effect.withLogSpan(`docker: build ${tag}`),
            Effect.mapError((cause) =>
              SystemError.make({
                subtag: "DockerBuildFailed",
                message: `Failed to build image "${tag}".`,
                cause,
              }),
            ),
            Effect.flatMap((result) =>
              ensureExitZero(result, ({ exitCode, stdout, stderr }) =>
                SystemError.make({
                  subtag: "DockerBuildFailed",
                  message: `Failed to build image "${tag}".`,
                  hint: buildFailureHint(stderr),
                  detail: { bin, tag, exitCode, stdout, stderr },
                }),
              ),
            ),
          );
        }),
      // Pull every time so a mutable tag picks up a newly pushed image and
      // the `linux/amd64` variant replaces any native build under the tag.
      // An image that exists only locally (built on the machine or
      // `docker load`ed) has nothing to pull from, so when the pull fails
      // and the image is present, use the local copy.
      pull: (tag, image) =>
        pull({ ...image, platform: "linux/amd64" }).pipe(
          Effect.catchTag("SystemError", (error) =>
            inspect(image.imageUri, "{{.Id}}").pipe(
              Effect.orElseSucceed(() => ""),
              Effect.flatMap((id) =>
                id.trim()
                  ? Effect.logDebug(
                      `docker: pull ${image.imageUri} failed, using the local image ${id.trim()}`,
                    )
                  : Effect.fail(
                      SystemError.make({
                        subtag: "DockerPullFailed",
                        message: `Image "${image.imageUri}" could not be pulled and is not in the local Docker.`,
                        hint: imageUnavailableHint(image.imageUri),
                        detail: error.detail,
                        cause: error,
                      }),
                    ),
              ),
            ),
          ),
          Effect.andThen(
            run(["tag", image.imageUri, tag]).pipe(
              Effect.mapError((cause) =>
                SystemError.make({
                  subtag: "DockerTagFailed",
                  message: `Failed to tag image "${image.imageUri}" as "${tag}".`,
                  cause,
                }),
              ),
              Effect.flatMap((result) =>
                ensureExitZero(result, ({ exitCode, stdout, stderr }) =>
                  SystemError.make({
                    subtag: "DockerTagFailed",
                    message: `Failed to tag image "${image.imageUri}" as "${tag}".`,
                    detail: {
                      bin,
                      imageUri: image.imageUri,
                      tag,
                      exitCode,
                      stdout,
                      stderr,
                    },
                  }),
                ),
              ),
            ),
          ),
          Effect.withLogSpan(`docker: pull ${image.imageUri}`),
          Effect.asVoid,
        ),
      validate: (tag) =>
        inspect(tag, "{{ len .Config.ExposedPorts }}").pipe(
          Effect.withLogSpan(`docker: inspect ${tag} for exposed ports`),
          Effect.orElseSucceed(() => "0"),
          Effect.flatMap((output) =>
            output === "0"
              ? Effect.fail(
                  ConfigError.make({
                    subtag: "ContainerNoExposedPorts",
                    message: `The container for "${tag}" does not expose any ports.`,
                    hint: "Add an EXPOSE instruction to the Dockerfile for any ports you intend to connect to.",
                  }),
                )
              : Effect.void,
          ),
        ),
      // Untag ONLY the given tag (used by each runtime start's finalizer for
      // the tag it created). Deliberately does not guess at sibling
      // "<name>:<otherSuffix>" tags: concurrent/successive dev sessions of
      // the same container class each hold their own random-suffix tag on
      // the same underlying image, and pruning siblings untags an image a
      // live workerd still needs (its container creates then fail forever).
      removeImageTag: (tag) =>
        Effect.asVoid(run(["rmi", tag])).pipe(
          Effect.withLogSpan(`docker: remove image tag ${tag}`),
          Effect.ignore,
        ),
      removeContainer: (tag) =>
        list(tag).pipe(
          Effect.flatMap((containers) => {
            if (containers.length === 0) return Effect.void;
            return Effect.asVoid(
              run([
                "rm",
                "--force",
                ...containers.flatMap((container) => [container.id, `${container.name}-proxy`]),
              ]),
            );
          }),
          Effect.withLogSpan(`docker: remove containers for ${tag}`),
          Effect.mapError((cause) =>
            SystemError.make({
              subtag: "DockerRemoveContainerFailed",
              message: `Failed to remove containers for "${tag}".`,
              cause,
            }),
          ),
        ),
    });
  }),
);

/** Label identifying the runtime that created a container through the proxy. */
export const RUNTIME_LABEL = "alchemy.runtime";

const generateImageTag = (className: string, suffix?: string) =>
  `${DEV_CONTAINER_PREFIX}/${className.toLowerCase()}:${suffix ?? crypto.randomUUID().slice(0, 8)}`;

const dockerProxyError = (subtag: string, message: string) => (cause: unknown) =>
  SystemError.make({ subtag, message, cause });

/** Forward `req` to the Docker socket, replacing its body when one is given. */
const sendDockerRequest = (
  socketPath: string,
  req: NodeHttp.IncomingMessage,
  body: string | undefined,
) =>
  Effect.callback<NodeHttp.IncomingMessage, SystemError>((resume) => {
    const headers: NodeHttp.OutgoingHttpHeaders = { ...req.headers };
    // `transfer-encoding` is a hop-by-hop header and must not be forwarded
    // verbatim. workerd sends its `DELETE /containers/<name>-proxy?force=true`
    // cleanup request with `transfer-encoding: chunked` and an empty body;
    // Bun's `node:http` client hangs indefinitely on such a request to a
    // unix socket (it never flushes the terminating zero-chunk), so the
    // docker daemon never responds and workerd blocks forever before it can
    // create the container. Strip the header and let the runtime derive the
    // framing from the body we actually write. (Node tolerates it, Bun does
    // not — and Alchemy dev runs the runtime under Bun.)
    delete headers["transfer-encoding"];
    if (body !== undefined) headers["content-length"] = Buffer.byteLength(body).toString();
    const upstream = NodeHttp.request(
      {
        socketPath: socketPath.replace(/^unix:/, ""),
        path: req.url,
        method: req.method,
        headers,
      },
      (res) => {
        delete res.headers["transfer-encoding"];
        resume(Effect.succeed(res));
      },
    );
    upstream.on("error", (cause) =>
      resume(Effect.fail(dockerProxyError("DockerProxyRequest", "Docker request failed.")(cause))),
    );
    if (body === undefined) req.pipe(upstream, { end: true });
    else upstream.end(body);
    return Effect.sync(() => upstream.destroy());
  });

const readBody = (stream: NodeStream.Readable) =>
  Stream.fromAsyncIterable<Uint8Array, SystemError>(
    stream,
    dockerProxyError("DockerProxyBody", "Failed to read a Docker proxy body."),
  ).pipe(
    Stream.runCollect,
    Effect.map((chunks) => Buffer.concat(chunks)),
  );

const readJson = <T>(req: NodeHttp.IncomingMessage) =>
  Effect.flatMap(readBody(req), (body) =>
    Effect.try({
      try: () => JSON.parse(body.toString()) as T,
      catch: dockerProxyError("DockerProxyBody", "Docker request body is not valid JSON."),
    }),
  );

const sendError = (res: NodeHttp.ServerResponse, status: number, message: string) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ message }));
};
