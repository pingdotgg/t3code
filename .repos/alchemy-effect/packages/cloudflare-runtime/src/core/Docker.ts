import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as NodeHttp from "node:http";
import * as NodeStream from "node:stream";
import {
  attachLoopbackNetnsForwarder,
  CONTAINER_LOOPBACK_ALIAS,
  containerIdFromPath,
  detachLoopbackNetnsForwarder,
  ensureLoopbackUnixSockets,
  isContainerStartPath,
  loopbackPortsFromEnv,
  mergeSidecarLoopbackHostConfig,
  ufwAllowHint,
  usesUnixSocketLoopback,
} from "./DockerLoopback.ts";
import { getAddress } from "./internal/get-address.ts";
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
    readonly generateImageTag: (className: string, suffix?: string) => string;
    readonly registerImageEnv: (
      className: string,
      tag: string,
      env: Record<string, string>,
    ) => Effect.Effect<string, never, Scope.Scope>;
    readonly build: (
      tag: string,
      image: ContainerImage.Build,
    ) => Effect.Effect<void, SystemError>;
    readonly pull: (
      tag: string,
      image: ContainerImage.Pull,
    ) => Effect.Effect<void, SystemError>;
    readonly validate: (tag: string) => Effect.Effect<void, ConfigError>;
    readonly removeImageTag: (tag: string) => Effect.Effect<void>;
    readonly removeContainer: (tag: string) => Effect.Effect<void, SystemError>;
  }
>()("cloudflare-runtime/Docker") {}

export type ContainerImage =
  | ContainerImage.Build
  | ContainerImage.Pull
  | ContainerImage.Ref;

export declare namespace ContainerImage {
  interface Base {
    readonly env?: Record<string, string>;
  }
  export interface Build extends Base {
    readonly dockerfile: string;
    readonly context?: string;
    readonly buildArgs?: Record<string, string>;
  }
  export interface Pull extends Base {
    readonly imageUri: string;
  }
  export interface Ref extends Base {
    readonly tag: string;
  }
}

const DEFAULT_DOCKER_HOST =
  process.platform === "win32"
    ? "//./pipe/docker_engine"
    : "unix:///var/run/docker.sock";
const DEV_CONTAINER_PREFIX = "alchemy-dev";

const DockerHost = Config.string("DOCKER_HOST");
const DockerBin = Config.string("DOCKER_BIN").pipe(
  Config.orElse(() => Config.succeed("docker")),
);
const ContainerEgressInterceptorImage = Config.string(
  "CONTAINER_EGRESS_INTERCEPTOR_IMAGE",
).pipe(
  Config.orElse(() =>
    Config.succeed(
      "cloudflare/proxy-everything:3cb1195@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8",
    ),
  ),
);

/**
 * Docker's containerd image store rejects combined `repo:tag@digest` pull
 * refs ("cannot overwrite digest"); the digest fully pins the image, so the
 * tag is dropped when both are present.
 */
export const toPullRef = (imageUri: string) =>
  imageUri.replace(/:[^@/]+(?=@sha256:)/, "");

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

    const bin = yield* DockerBin;
    const containerEgressInterceptorImage =
      yield* ContainerEgressInterceptorImage;
    const registeredImages = new Map<
      string,
      { tag: string; env: Record<string, string> }
    >();

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
        spawner.spawn,
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
              const endpoint = items.find(
                (item) => item.Current,
              )?.DockerEndpoint;
              return endpoint
                ? Effect.succeed(endpoint)
                : Effect.fail(
                    new ConfigError({
                      subtag: "DockerHostNotFound",
                      message: "Docker host not found",
                    }),
                  );
            }),
          ),
        ),
        Effect.scoped,
      );

    const makeDockerProxyServer = (socketPath: string) =>
      NodeHttp.createServer(async (req, res) => {
        const isCreateRequest =
          req.method === "POST" && req.url?.startsWith("/containers/create");
        // workerd creates two containers per instance: the user container and
        // a `<name>-proxy` networking sidecar whose namespace the user
        // container joins (`NetworkMode: container:<sidecar>`) — so the
        // sidecar's /etc/hosts is what the user container resolves against.
        const isSidecarCreateRequest =
          isCreateRequest && req.url!.endsWith("-proxy");
        if (isCreateRequest && !isSidecarCreateRequest) {
          const original = await extractJsonBody<{
            Image: string;
            Env: Array<string>;
          }>(req);
          const image = registeredImages.get(original.Image);
          const transformed = JSON.stringify({
            ...original,
            Image: image?.tag ?? original.Image,
            Env: mergeContainerCreateEnv(original.Env, image?.env),
          });
          const proxy = sendProxyRequest({
            socketPath,
            path: req.url,
            method: req.method,
            headers: {
              ...req.headers,
              "content-length": Buffer.byteLength(transformed).toString(),
            },
            res,
          });
          proxy.end(transformed);
        } else if (isSidecarCreateRequest) {
          // Shared netns with the user container. Docker Desktop maps the
          // alias through host-gateway (reaches host 127.0.0.1). Native
          // Linux maps it to 127.0.0.1 in this netns and bind-mounts unix
          // sockets; a SYN to the bridge IP is host INPUT (UFW).
          const original = await extractJsonBody<{
            HostConfig?: { ExtraHosts?: Array<string>; Binds?: Array<string> };
          }>(req);
          const ports = registeredLoopbackPorts();
          ensureLoopbackUnixSockets(ports);
          const transformed = JSON.stringify({
            ...original,
            HostConfig: mergeSidecarLoopbackHostConfig(
              original.HostConfig,
              ports,
            ),
          });
          const proxy = sendProxyRequest({
            socketPath,
            path: req.url,
            method: req.method,
            headers: {
              ...req.headers,
              "content-length": Buffer.byteLength(transformed).toString(),
            },
            res,
          });
          proxy.end(transformed);
        } else if (req.method === "POST" && isContainerStartPath(req.url)) {
          const id = containerIdFromPath(req.url);
          const proxy = sendProxyRequest({
            socketPath,
            path: req.url,
            method: req.method,
            headers: req.headers,
            res,
            afterSuccess:
              id === undefined
                ? undefined
                : () =>
                    attachSidecarLoopback(
                      socketPath,
                      id,
                      registeredLoopbackPorts(),
                    ),
          });
          req.pipe(proxy, { end: true });
        } else if (req.method === "DELETE") {
          const id = containerIdFromPath(req.url);
          if (id !== undefined) detachLoopbackNetnsForwarder(id);
          const proxy = sendProxyRequest({
            socketPath,
            path: req.url,
            method: req.method,
            headers: req.headers,
            res,
          });
          req.pipe(proxy, { end: true });
        } else {
          const proxy = sendProxyRequest({
            socketPath,
            path: req.url,
            method: req.method,
            headers: req.headers,
            res,
          });
          req.pipe(proxy, { end: true });
        }
      });

    const run = (
      args: Array<string>,
      stdin: ChildProcess.CommandInput = "ignore",
    ) =>
      ChildProcess.make(bin, args, {
        stdin,
        stdout: "pipe",
        stderr: "pipe",
        detached: false,
      }).pipe(
        spawner.spawn,
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
      onNonZero: (result: {
        exitCode: number;
        stdout: string;
        stderr: string;
      }) => E,
    ): Effect.Effect<void, E> =>
      result.exitCode === 0 ? Effect.void : Effect.fail(onNonZero(result));

    const pull = ({ imageUri }: ContainerImage.Pull) =>
      run(["pull", toPullRef(imageUri), "--platform", "linux/amd64"]).pipe(
        Effect.mapError(
          (cause) =>
            new SystemError({
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
              new SystemError({
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
      Effect.map(
        run(["image", "inspect", tag, "--format", format]),
        (result) => result.stdout,
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

    const docker = yield* Effect.zipWith(
      DockerHost.pipe(
        Effect.catchTag("ConfigError", getSocketPathFromContext),
        Effect.orElseSucceed(() => DEFAULT_DOCKER_HOST),
        Effect.flatMap((socketPath) => {
          const server = makeDockerProxyServer(socketPath);
          server.listen(0);
          return getAddress(server);
        }),
      ),
      // Skip the eager pull when the interceptor image is already present
      // locally. `CONTAINER_EGRESS_INTERCEPTOR_IMAGE` can point at a
      // local-only tag that exists in the Docker daemon but resolves in no
      // registry (e.g. a locally-built dev image) — an unconditional
      // `docker pull` there fails, this detached fiber dies, and every
      // caller of `getWorkerdDockerConfiguration` (joined on first use)
      // fails with it. `docker image inspect` prints the image id when
      // present and empty stdout when absent (`run` reports the non-zero
      // exit rather than failing the effect), so only pull when the image
      // is genuinely missing. Any failure to even run `inspect` (unlike
      // `pull`, it doesn't normalize its error channel) falls back to the
      // pre-existing pull behavior rather than failing here.
      inspect(containerEgressInterceptorImage, "{{.Id}}").pipe(
        Effect.orElseSucceed(() => undefined),
        Effect.flatMap((imageId) =>
          imageId?.trim()
            ? Effect.void
            : pull({ imageUri: containerEgressInterceptorImage }),
        ),
      ),
      (socketPath) => ({
        localDocker: {
          socketPath,
          containerEgressInterceptorImage,
        },
      }),
      { concurrent: true },
    ).pipe(
      Effect.forkDetach({ startImmediately: false, uninterruptible: true }),
    );

    return Docker.of({
      getWorkerdDockerConfiguration: Fiber.join(docker),
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
          const args = [
            "build",
            "--load",
            "-t",
            tag,
            "--platform",
            "linux/amd64",
            "--provenance=false",
            ...Object.entries(image.buildArgs ?? {}).map(
              ([name, value]) => `--build-arg ${name}=${value}`,
            ),
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
          ).pipe(
            Effect.withLogSpan(`docker: build ${tag}`),
            Effect.mapError(
              (cause) =>
                new SystemError({
                  subtag: "DockerBuildFailed",
                  message: `Failed to build image "${tag}".`,
                  cause,
                }),
            ),
            Effect.flatMap((result) =>
              ensureExitZero(
                result,
                ({ exitCode, stdout, stderr }) =>
                  new SystemError({
                    subtag: "DockerBuildFailed",
                    message: `Failed to build image "${tag}".`,
                    hint: buildFailureHint(stderr),
                    detail: { bin, tag, exitCode, stdout, stderr },
                  }),
              ),
            ),
          );
        }),
      pull: (tag, image) =>
        pull(image).pipe(
          Effect.andThen(
            run(["tag", image.imageUri, tag]).pipe(
              Effect.mapError(
                (cause) =>
                  new SystemError({
                    subtag: "DockerTagFailed",
                    message: `Failed to tag image "${image.imageUri}" as "${tag}".`,
                    cause,
                  }),
              ),
              Effect.flatMap((result) =>
                ensureExitZero(
                  result,
                  ({ exitCode, stdout, stderr }) =>
                    new SystemError({
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
                  new ConfigError({
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
                ...containers.flatMap((container) => [
                  container.id,
                  `${container.name}-proxy`,
                ]),
              ]),
            );
          }),
          Effect.withLogSpan(`docker: remove containers for ${tag}`),
          Effect.mapError(
            (cause) =>
              new SystemError({
                subtag: "DockerRemoveContainerFailed",
                message: `Failed to remove containers for "${tag}".`,
                cause,
              }),
          ),
        ),
    });
  }),
);

const generateImageTag = (className: string, suffix?: string) =>
  `${DEV_CONTAINER_PREFIX}/${className.toLowerCase()}:${suffix ?? crypto.randomUUID().slice(0, 8)}`;

const sendProxyRequest = (input: {
  socketPath: string;
  path: string | undefined;
  method: string | undefined;
  headers: NodeHttp.OutgoingHttpHeaders;
  res: NodeHttp.ServerResponse;
  afterSuccess?: () => Promise<void>;
}) => {
  // `transfer-encoding` is a hop-by-hop header and must not be forwarded
  // verbatim. workerd sends its `DELETE /containers/<name>-proxy?force=true`
  // cleanup request with `transfer-encoding: chunked` and an empty body;
  // Bun's `node:http` client hangs indefinitely on such a request to a
  // unix socket (it never flushes the terminating zero-chunk), so the
  // docker daemon never responds and workerd blocks forever before it can
  // create the container. Strip the header and let the runtime derive the
  // framing from the body we actually write. (Node tolerates it, Bun does
  // not — and Alchemy dev runs the runtime under Bun.)
  delete input.headers["transfer-encoding"];
  const req = NodeHttp.request(
    {
      socketPath: input.socketPath.replace(/^unix:/, ""),
      path: input.path,
      method: input.method,
      headers: input.headers,
    },
    (res) => {
      delete res.headers["transfer-encoding"];
      const succeed =
        (res.statusCode ?? 500) < 300 && input.afterSuccess !== undefined;
      if (!succeed) {
        input.res.writeHead(res.statusCode || 500, res.headers);
        res.pipe(input.res, { end: true });
        return;
      }
      const chunks: Array<Buffer> = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        void input.afterSuccess!().finally(() => {
          const status = res.statusCode || 500;
          input.res.writeHead(status, res.headers);
          if (status === 204 || chunks.length === 0) input.res.end();
          else input.res.end(Buffer.concat(chunks));
        });
      });
    },
  );
  req.on("error", (err) => {
    input.res.writeHead(502, { "content-type": "text/plain" });
    input.res.end(`Proxy error: ${(err && err.message) || err}`);
  });
  return req;
};

const attachSidecarLoopback = async (
  socketPath: string,
  containerId: string,
  ports: readonly number[],
) => {
  if (!usesUnixSocketLoopback() || ports.length === 0) return;
  let inspect: {
    Id?: string;
    Name?: string;
    State?: { Pid?: number };
  };
  try {
    inspect = await dockerApiJson(
      socketPath,
      "GET",
      `/containers/${containerId}/json`,
    );
  } catch (error) {
    console.warn(
      `alchemy: could not inspect ${containerId} for loopback forwards (${String(error)})`,
    );
    return;
  }
  const name = inspect.Name?.replace(/^\//, "") ?? "";
  if (!name.endsWith("-proxy")) return;
  const result = attachLoopbackNetnsForwarder({
    keys: [containerId, inspect.Id ?? "", name],
    pid: inspect.State?.Pid ?? 0,
    ports,
  });
  if (!result.ok) {
    console.warn(
      `alchemy: could not attach loopback unix-socket forwards in container netns (${result.error}). ` +
        `A SYN to host-gateway is host INPUT and UFW may drop it. Do not set DEFAULT_INPUT_POLICY=ACCEPT. ` +
        `If you must punch a hole: ${ufwAllowHint(ports)}`,
    );
  }
};

const dockerApiJson = <T>(
  socketPath: string,
  method: string,
  path: string,
): Promise<T> =>
  new Promise((resolve, reject) => {
    const req = NodeHttp.request(
      {
        socketPath: socketPath.replace(/^unix:/, ""),
        path,
        method,
      },
      (res) => {
        const chunks: Array<Buffer> = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString();
          if ((res.statusCode ?? 500) >= 300) {
            reject(new Error(`docker ${method} ${path}: ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body) as T);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });

const extractJsonBody = <T>(req: NodeHttp.IncomingMessage) => {
  const promise = Promise.withResolvers<T>();
  const chunks: Array<Buffer> = [];
  req.pipe(
    new NodeStream.Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
      final(callback) {
        promise.resolve(JSON.parse(Buffer.concat(chunks).toString()));
        callback();
      },
    }),
    { end: true },
  );
  return promise.promise;
};
