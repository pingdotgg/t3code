import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { flow } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import {
  PlatformError,
  SystemError,
  type SystemErrorTag,
} from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type { ScopedPlanStatusSession } from "../Cli/Cli.ts";
import { createPhysicalName } from "../PhysicalName.ts";

export class Docker extends Context.Service<
  Docker,
  {
    /** Runs a Docker command and returns the output. Use this to run a command that doesn't have a dedicated method. */
    readonly run: (
      args: Array<string>,
    ) => Effect.Effect<CommandOutput, PlatformError>;
    /** Writes build files and an inline Dockerfile to the given context directory. */
    readonly materialize: (options: {
      context: string;
      dockerfile: string;
      files: ReadonlyArray<{
        path: string;
        content: string | Uint8Array;
      }>;
    }) => Effect.Effect<void, PlatformError>;
    readonly container: {
      /** Creates a new container. */
      readonly create: (options: {
        name: string;
        image: string;
        volume: Array<string> | undefined;
        env: Record<string, string> | undefined;
        restart: "no" | "always" | "on-failure" | "unless-stopped";
        rm: boolean;
        "health-cmd": string | undefined;
        "health-interval": string | undefined;
        "health-timeout": string | undefined;
        "health-retries": number | undefined;
        "health-start-period": string | undefined;
        "health-start-interval": string | undefined;
        "stop-timeout": string | undefined;
        p: Array<string> | undefined;
        /** `--add-host` entries, each `hostname:address`. */
        "add-host"?: Array<string> | undefined;
        command: Array<string> | undefined;
        label?: Record<string, string>;
        context?: string;
      }) => Effect.Effect<CommandOutput, PlatformError>;
      /** Inspects a container. */
      readonly inspect: (
        name: string,
        context?: string,
      ) => Effect.Effect<Docker.Container, PlatformError>;
      /** Removes a container. */
      readonly remove: (
        name: string,
        force?: boolean,
        context?: string,
      ) => Effect.Effect<CommandOutput, PlatformError>;
      /** Starts a container. */
      readonly start: (
        name: string,
        context?: string,
      ) => Effect.Effect<CommandOutput, PlatformError>;
      /** Stops a container. */
      readonly stop: (
        name: string,
        context?: string,
      ) => Effect.Effect<CommandOutput, PlatformError>;
    };
    readonly image: {
      /** Builds a new image. If a session is provided, build logs will be emitted as session notes. */
      readonly build: (
        options: {
          context: string;
          tag: string;
          file?: string;
          platform?: string;
          target?: string;
          "build-arg"?: Record<string, string>;
          "cache-from"?: Array<string>;
          "cache-to"?: Array<string>;
          args?: Array<string>;
          engineContext?: string;
        },
        session?: ScopedPlanStatusSession,
      ) => Effect.Effect<CommandOutput, PlatformError>;
      /** Pulls an image. */
      readonly pull: (
        ref: string,
        platform?: string,
        context?: string,
      ) => Effect.Effect<CommandOutput, PlatformError>;
      /**
       * Pushes an image to a registry. When `platform` is given, only that
       * platform's manifest is pushed (`docker push --platform`) — with the
       * containerd image store, a bare push sends every locally-present
       * variant of a multi-arch tag, so a stale other-arch variant in the
       * local cache would otherwise reach the registry. Engines whose store
       * doesn't support the flag fall back to a plain push (their local tag
       * is already narrowed by `pull --platform`).
       */
      readonly push: (
        ref: string,
        credentials: {
          server: string;
          username: string;
          password: string | Redacted.Redacted<string>;
        },
        platform?: string,
        context?: string,
      ) => Effect.Effect<CommandOutput, PlatformError>;
      /** Tags an image. */
      readonly tag: (
        source: string,
        target: string,
        context?: string,
      ) => Effect.Effect<CommandOutput, PlatformError>;
      /** Inspects an image. */
      readonly inspect: (
        ref: string,
        context?: string,
      ) => Effect.Effect<Docker.Image, PlatformError>;
      /** Removes an image. */
      readonly remove: (
        ref: string | Array<string>,
        force?: boolean,
        context?: string,
      ) => Effect.Effect<CommandOutput, PlatformError>;
    };
    readonly volume: {
      /** Creates a new volume. */
      readonly create: (options: {
        name: string;
        driver?: string;
        opt?: Record<string, string>;
        label?: Record<string, string>;
        context?: string;
      }) => Effect.Effect<CommandOutput, PlatformError>;
      /** Removes a volume. */
      readonly remove: (
        name: string,
        context?: string,
      ) => Effect.Effect<CommandOutput, PlatformError>;
      /** Inspects a volume. */
      readonly inspect: (
        name: string,
        context?: string,
      ) => Effect.Effect<Docker.Volume, PlatformError>;
    };
    readonly context: {
      /** Creates a new Docker context. */
      readonly create: (options: {
        name: string;
        description?: string;
        /** Raw value for `--docker`, for example `host=ssh://user@host`. */
        docker?: string;
      }) => Effect.Effect<CommandOutput, PlatformError>;
      /** Updates an existing Docker context. */
      readonly update: (options: {
        name: string;
        description?: string;
        /** Raw value for `--docker`, for example `host=ssh://user@host`. */
        docker?: string;
      }) => Effect.Effect<CommandOutput, PlatformError>;
      /** Inspects a Docker context. */
      readonly inspect: (
        name: string,
      ) => Effect.Effect<Docker.Context, PlatformError>;
      /** Removes a Docker context. */
      readonly remove: (
        name: string,
        force?: boolean,
      ) => Effect.Effect<CommandOutput, PlatformError>;
    };
    readonly network: {
      /** Creates a new network. */
      readonly create: (options: {
        name: string;
        driver: string;
        ipv6?: boolean;
        label?: Record<string, string>;
        context?: string;
      }) => Effect.Effect<CommandOutput, PlatformError>;
      /** Connects a container to a network. */
      readonly connect: (options: {
        network: string;
        container: string;
        alias?: string[];
        context?: string;
      }) => Effect.Effect<CommandOutput, PlatformError>;
      /** Disconnects a container from a network. */
      readonly disconnect: (options: {
        network: string;
        container: string;
        context?: string;
      }) => Effect.Effect<CommandOutput, PlatformError>;
      /** Inspects a network. */
      readonly inspect: (
        name: string,
        context?: string,
      ) => Effect.Effect<Docker.Network, PlatformError>;
      /** Removes a network. */
      readonly remove: (
        id: string,
        context?: string,
      ) => Effect.Effect<CommandOutput, PlatformError>;
    };
    readonly swarm: {
      /** Initializes swarm mode on the engine (`docker swarm init`). */
      readonly init: (options: {
        context?: string;
        "advertise-addr"?: string;
        "listen-addr"?: string;
        "default-addr-pool"?: string[];
        "default-addr-pool-mask-length"?: number;
      }) => Effect.Effect<CommandOutput, PlatformError>;
      /** Reads the engine's swarm state (`docker info --format '{{json .Swarm}}'`). */
      readonly info: (
        context?: string,
      ) => Effect.Effect<Docker.SwarmInfo, PlatformError>;
      /** Leaves the swarm (`docker swarm leave`). */
      readonly leave: (
        force?: boolean,
        context?: string,
      ) => Effect.Effect<CommandOutput, PlatformError>;
    };
    readonly service: {
      /** Creates a new service. */
      readonly create: (options: {
        name: string;
        image: string;
        context?: string;
        replicas?: number;
        "endpoint-mode"?: "vip" | "dnsrr";
        network?: string[];
        constraint?: string[];
        "replicas-max-per-node"?: number;
        "placement-pref"?: string[];
        "update-parallelism"?: number;
        "update-delay"?: string;
        "update-monitor"?: string;
        "update-failure-action"?: "pause" | "continue" | "rollback";
        "update-max-failure-ratio"?: number;
        "update-order"?: "stop-first" | "start-first";
        "rollback-parallelism"?: number;
        "rollback-delay"?: string;
        "rollback-monitor"?: string;
        "rollback-failure-action"?: "pause" | "continue" | "rollback";
        "rollback-max-failure-ratio"?: number;
        "rollback-order"?: "stop-first" | "start-first";
        "restart-condition"?: "none" | "on-failure" | "any";
        "restart-delay"?: string;
        "restart-max-attempts"?: number;
        "restart-window"?: string;
        "health-cmd"?: string;
        "health-interval"?: string;
        "health-timeout"?: string;
        "health-retries"?: number;
        "health-start-period"?: string;
        "stop-grace-period"?: string;
        mount?: string[];
        secret?: string[];
        config?: string[];
        "read-only"?: boolean;
        publish?: string[];
        label?: Record<string, string>;
        env?: Record<string, string>;
        command?: string[];
        args?: string[];
      }) => Effect.Effect<CommandOutput, PlatformError>;
      /** Updates an existing service. */
      readonly update: (options: {
        id: string;
        image: string;
        context?: string;
        replicas?: number;
        "endpoint-mode"?: "vip" | "dnsrr";
        "constraint-add"?: string[];
        "constraint-rm"?: string[];
        "replicas-max-per-node"?: number;
        "placement-pref"?: string[];
        "update-parallelism"?: number;
        "update-delay"?: string;
        "update-monitor"?: string;
        "update-failure-action"?: "pause" | "continue" | "rollback";
        "update-max-failure-ratio"?: number;
        "update-order"?: "stop-first" | "start-first";
        "rollback-parallelism"?: number;
        "rollback-delay"?: string;
        "rollback-monitor"?: string;
        "rollback-failure-action"?: "pause" | "continue" | "rollback";
        "rollback-max-failure-ratio"?: number;
        "rollback-order"?: "stop-first" | "start-first";
        "restart-condition"?: "none" | "on-failure" | "any";
        "restart-delay"?: string;
        "restart-max-attempts"?: number;
        "restart-window"?: string;
        "health-cmd"?: string;
        "health-interval"?: string;
        "health-timeout"?: string;
        "health-retries"?: number;
        "health-start-period"?: string;
        "stop-grace-period"?: string;
        "mount-add"?: string[];
        "secret-add"?: string[];
        "config-add"?: string[];
        "read-only"?: boolean;
        "publish-add"?: string[];
        "label-add"?: Record<string, string>;
        "label-rm"?: string[];
        "env-add"?: Record<string, string>;
        args?: string;
      }) => Effect.Effect<CommandOutput, PlatformError>;
      /** Inspects a service. */
      readonly inspect: (
        id: string,
        context?: string,
      ) => Effect.Effect<CommandOutput, PlatformError>;
      /** Removes a service. */
      readonly remove: (
        id: string,
        context?: string,
      ) => Effect.Effect<CommandOutput, PlatformError>;
    };
  }
>()("@alchemy/Docker") {}

export declare namespace Docker {
  export type ContextRef = string | { name: string };

  /**
   * A reference to the Docker engine an operation runs against: a context
   * name, a `Docker.Context` resource, or a `Docker.Swarm` resource
   * (narrowed structurally by its `nodeId` attribute) — passing the swarm
   * also orders the operation after the swarm is initialized.
   */
  export type EngineRef = ContextRef | { nodeId: string; context?: string };

  export interface SwarmInfo {
    NodeID: string;
    LocalNodeState:
      | "inactive"
      | "pending"
      | "active"
      | "error"
      | "locked"
      | (string & {});
    ControlAvailable: boolean;
    Cluster?: { ID: string; CreatedAt?: string } | null;
    RemoteManagers?: Array<{ NodeID: string; Addr: string }> | null;
    Managers?: number;
    Nodes?: number;
  }

  export type ContainerStatus =
    | "created"
    | "running"
    | "paused"
    | "restarting"
    | "removing"
    | "exited"
    | "dead";

  export interface Container {
    Id: string;
    Name?: string;
    State: { Status: ContainerStatus };
    Created: string;
    Config: {
      Image: string;
      Cmd: string[] | null;
      Env: string[] | null;
      Labels: Record<string, string> | null;
      StopTimeout?: number;
      Healthcheck?: {
        Test: string[] | null;
        Interval?: number;
        Timeout?: number;
        Retries?: number;
        StartPeriod?: number;
        StartInterval?: number;
      } | null;
    };
    HostConfig: {
      PortBindings: Record<
        string,
        Array<{ HostIp: string; HostPort: string }> | null
      > | null;
      Binds: string[] | null;
      ExtraHosts: string[] | null;
      RestartPolicy: {
        Name: string;
        MaximumRetryCount: number;
      };
      AutoRemove: boolean;
    };
    NetworkSettings: {
      Networks: Record<
        string,
        {
          NetworkID: string;
          Aliases: string[] | null;
        }
      > | null;
      Ports?: Record<
        string,
        Array<{ HostIp: string; HostPort: string }> | null
      > | null;
    };
  }

  export interface Image {
    Id: string;
    Created?: string;
    RepoTags?: string[] | null;
    RepoDigests?: string[] | null;
  }

  export interface Volume {
    CreatedAt: string;
    Driver: string;
    Labels: Record<string, string> | null;
    Mountpoint: string;
    Name: string;
    Options: Record<string, string> | null;
    Scope: string;
  }

  export interface Context {
    Name: string;
    Metadata?: {
      Description?: string;
    };
    Endpoints?: {
      docker?: string;
    };
  }

  export interface Network {
    Name: string;
    Id: string;
    Created: string;
    Scope: string;
    Driver: string;
    EnableIPv6: boolean;
    Labels: Record<string, string> | null;
  }
}

export interface CommandOutput {
  exitCode: ChildProcessSpawner.ExitCode;
  stdout: string;
  stderr: string;
}

const DockerBin = Config.string("DOCKER_BIN").pipe(
  Effect.orElseSucceed(() => "docker"),
);

export const DockerLive = Layer.effect(
  Docker,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const bin = yield* DockerBin;

    const run = (
      args: Array<string>,
      env?: Record<string, string>,
      tap: (
        stream: Stream.Stream<string, PlatformError, never>,
      ) => Stream.Stream<string, PlatformError, never> = Stream.tap(
        Effect.logDebug,
      ),
    ) =>
      ChildProcess.make(bin, args, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: false,
        env,
        extendEnv: true,
      }).pipe(
        spawner.spawn,
        Effect.flatMap((child) =>
          Effect.all(
            {
              exitCode: child.exitCode,
              stdout: child.stdout.pipe(
                Stream.decodeText,
                tap,
                Stream.mkString,
                Effect.map((stdout) => stdout.trim()),
              ),
              stderr: child.stderr.pipe(
                Stream.decodeText,
                tap,
                Stream.mkString,
                Effect.map((stderr) => stderr.trim()),
              ),
            },
            { concurrency: "unbounded" },
          ),
        ),
        Effect.mapError((error) =>
          systemError({
            _tag: "Unknown",
            args,
            description: "The command failed unexpectedly.",
            cause: error.reason,
          }),
        ),
        Effect.tap((result) => {
          if (result.exitCode === 0) return Effect.void;
          const stderr = result.stderr.replace(
            /^Error response from daemon: /,
            "",
          );
          if (stderr.match(/no such/i) || stderr.match(/not found/i)) {
            return systemError({
              _tag: "NotFound",
              args,
              description: stderr,
            });
          }
          if (stderr.match(/already exists/i)) {
            return systemError({
              _tag: "AlreadyExists",
              args,
              description: stderr,
            });
          }
          return systemError({
            _tag: "Unknown",
            args,
            description: `Command exited with code ${result.exitCode}: ${stderr}`,
          });
        }),
        Effect.scoped,
      );

    const runInspect = <T>(args: Array<string>) =>
      run(args).pipe(
        Effect.map((result) => {
          const [item] = JSON.parse(result.stdout) as T[];
          return item;
        }),
      );

    return Docker.of({
      run,
      materialize: Effect.fn((options) =>
        Effect.forEach(
          [
            ...options.files,
            { path: "Dockerfile", content: options.dockerfile },
          ],
          (file) => {
            const fullPath = path.join(options.context, file.path);
            return fs
              .makeDirectory(path.dirname(fullPath), { recursive: true })
              .pipe(
                Effect.andThen(
                  typeof file.content === "string"
                    ? fs.writeFileString(fullPath, file.content)
                    : fs.writeFile(fullPath, file.content),
                ),
              );
          },
          { concurrency: "unbounded" },
        ),
      ),
      container: {
        create: ({ image, env, command, context, ...options }) =>
          // `--env KEY` (name-only) keeps values off CLI arguments; Docker
          // copies each value from the CLI process environment, so the
          // normalized container env must be passed to the child process.
          run(
            [
              ...formatArgs({ context }),
              "container",
              "create",
              ...formatArgs({
                ...options,
                env: env ? Object.keys(env) : undefined,
              }),
              image,
              ...(command ?? []),
            ],
            env,
          ),
        inspect: (name, context) =>
          runInspect<Docker.Container>([
            ...formatArgs({ context }),
            "container",
            "inspect",
            name,
          ]),
        remove: (name, force, context) =>
          run([
            ...formatArgs({ context }),
            "container",
            "rm",
            name,
            ...(force ? ["-f"] : []),
          ]),
        start: (name, context) =>
          run([...formatArgs({ context }), "container", "start", name]),
        stop: (name, context) =>
          run([...formatArgs({ context }), "container", "stop", name]),
      },
      image: {
        build: (
          { context: buildContext, engineContext, args, ...options },
          session,
        ) =>
          run(
            [
              ...formatArgs({ context: engineContext }),
              "image",
              "build",
              buildContext,
              ...formatArgs(options),
              ...(args ?? []),
            ],
            undefined,
            session
              ? Stream.tapSink(
                  Sink.make<string>()(
                    flow(Stream.splitLines, Stream.runForEach(session.note)),
                  ),
                )
              : undefined,
          ),
        pull: (ref, platform, context) =>
          run([
            ...formatArgs({ context }),
            "image",
            "pull",
            ref,
            ...(platform ? ["--platform", platform] : []),
          ]),
        inspect: (ref, context) =>
          runInspect<Docker.Image>([
            ...formatArgs({ context }),
            "image",
            "inspect",
            ref,
          ]),
        remove: (ref, force, context) =>
          run([
            ...formatArgs({ context }),
            "image",
            "rm",
            ...(Array.isArray(ref) ? ref : [ref]),
            ...(force ? ["-f"] : []),
          ]),
        tag: (source, target, context) =>
          run([...formatArgs({ context }), "image", "tag", source, target]),
        push: Effect.fn(function* (ref, credentials, platform, context) {
          // Write the registry credentials directly into an isolated docker config
          // as a plaintext `auths` entry and skip `docker login` entirely.
          //
          // `docker login` is the wrong tool here: on macOS Docker Desktop it routes
          // through the shared `osxkeychain`/`desktop` credential helper *regardless*
          // of an isolated DOCKER_CONFIG, so concurrent deploys either race the system
          // keychain (`The specified item already exists in the keychain (-25299)`) or
          // land the credential in the helper — leaving this isolated config without
          // an `auths` entry, so the subsequent `docker push` fails with "no basic
          // auth credentials". Embedding the base64 `auth` inline (the same thing
          // `docker login` would write when no credsStore is configured) makes each
          // deploy fully self-contained: no credential helper, no keychain, no login
          // race. Only `push` reads this config; `build`/`pull`/`tag` keep using the
          // global docker config (buildx builders, `docker context`, etc. intact).
          const dir = yield* fs.makeTempDirectoryScoped({
            prefix: "alchemy-docker-",
          });
          const config = yield* Effect.sync(() => {
            const password = Redacted.isRedacted(credentials.password)
              ? Redacted.value(credentials.password)
              : credentials.password;
            const auth = Buffer.from(
              `${credentials.username}:${password}`,
            ).toString("base64");
            return JSON.stringify({
              auths: {
                [credentials.server]: { auth },
              },
            });
          });
          yield* fs.writeFileString(path.join(dir, "config.json"), config);
          if (platform === undefined) {
            return yield* run([...formatArgs({ context }), "push", ref], {
              DOCKER_CONFIG: dir,
            });
          }
          return yield* run(
            [...formatArgs({ context }), "push", "--platform", platform, ref],
            { DOCKER_CONFIG: dir },
          ).pipe(
            // Engines without the containerd image store reject `--platform`
            // on push; their local tag is already narrowed to the requested
            // platform by `pull --platform`, so a plain push is equivalent.
            Effect.catchIf(
              (error) =>
                /--platform|unknown flag|containerd/i.test(String(error)),
              () =>
                run([...formatArgs({ context }), "push", ref], {
                  DOCKER_CONFIG: dir,
                }),
            ),
          );
        }, Effect.scoped),
      },
      volume: {
        create: ({ context, ...options }) =>
          run([
            ...formatArgs({ context }),
            "volume",
            "create",
            ...formatArgs(options),
          ]),
        remove: (name, context) =>
          run([...formatArgs({ context }), "volume", "rm", name]),
        inspect: (name, context) =>
          runInspect<Docker.Volume>([
            ...formatArgs({ context }),
            "volume",
            "inspect",
            name,
          ]),
      },
      context: {
        create: ({ name, description, docker }) =>
          run([
            "context",
            "create",
            name,
            ...formatArgs({ description, docker }),
          ]),
        update: ({ name, description, docker }) =>
          run([
            "context",
            "update",
            name,
            ...formatArgs({ description, docker }),
          ]),
        inspect: (name) =>
          runInspect<Docker.Context>(["context", "inspect", name]),
        remove: (name, force) =>
          run(["context", "rm", ...(force ? ["-f"] : []), name]),
      },
      network: {
        create: ({ name, driver, ipv6, label, context }) =>
          run([
            ...formatArgs({ context }),
            "network",
            "create",
            name,
            ...formatArgs({ driver, ipv6, label }),
          ]),
        connect: ({ network, container, alias, context }) =>
          run([
            ...formatArgs({ context }),
            "network",
            "connect",
            network,
            container,
            ...(alias ? alias.flatMap((a) => ["--alias", a]) : []),
          ]),
        disconnect: ({ network, container, context }) =>
          run([
            ...formatArgs({ context }),
            "network",
            "disconnect",
            network,
            container,
          ]),
        inspect: (name, context) =>
          runInspect<Docker.Network>([
            ...formatArgs({ context }),
            "network",
            "inspect",
            name,
          ]),
        remove: (id, context) =>
          run([...formatArgs({ context }), "network", "rm", id]),
      },
      swarm: {
        init: ({ context, ...options }) =>
          run([
            ...formatArgs({ context }),
            "swarm",
            "init",
            ...formatArgs(options),
          ]),
        info: (context) =>
          run([
            ...formatArgs({ context }),
            "info",
            "--format",
            "{{json .Swarm}}",
          ]).pipe(
            Effect.map(
              (result) => JSON.parse(result.stdout) as Docker.SwarmInfo,
            ),
          ),
        leave: (force, context) =>
          run([
            ...formatArgs({ context }),
            "swarm",
            "leave",
            ...(force ? ["--force"] : []),
          ]),
      },
      service: {
        create: ({ context, image, command, args, ...options }) =>
          run([
            ...formatArgs({ context }),
            "service",
            "create",
            ...formatArgs({ ...options }),
            image,
            ...(command ?? []),
            ...(args ?? []),
          ]),
        update: ({ context, id, ...options }) =>
          run([
            ...formatArgs({ context }),
            "service",
            "update",
            "--detach=false",
            ...formatArgs({ ...options }),
            id,
          ]),
        inspect: (id, context) =>
          runInspect([...formatArgs({ context }), "service", "inspect", id]),
        remove: (id, context) =>
          run([...formatArgs({ context }), "service", "rm", id]),
      },
    });
  }),
);

export const dockerContextName = (
  context: Docker.ContextRef | undefined,
): string | undefined => {
  const value = typeof context === "string" ? context : context?.name;
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
};

/**
 * Resolve an {@link Docker.EngineRef} to a context name. A `Docker.Swarm`
 * reference (narrowed by its `nodeId` attribute) contributes the context the
 * swarm was initialized on.
 */
export const dockerEngineContextName = (
  ref: Docker.EngineRef | undefined,
): string | undefined => {
  if (typeof ref === "object" && ref !== null && "nodeId" in ref) {
    return dockerContextName((ref as { context?: string }).context);
  }
  return dockerContextName(ref as Docker.ContextRef | undefined);
};

export const dockerPhysicalName = (
  id: string,
  props: { name?: string } | undefined,
  instanceId: string,
  // Swarm service names are capped at 63 characters; other Docker object
  // names accept much longer values.
  maxLength = 128,
) =>
  props?.name
    ? Effect.succeed(props.name)
    : createPhysicalName({
        id,
        instanceId,
        maxLength,
        lowercase: true,
      });

/** Constructs a PlatformError from a command execution result. */
const systemError = (input: {
  _tag: SystemErrorTag;
  args: Array<string>;
  description?: string;
  cause?: unknown;
}) =>
  new PlatformError(
    new SystemError({
      _tag: input._tag,
      module: "Docker",
      method: input.args.slice(0, 2).join("."),
      pathOrDescriptor: input.args.join(" "),
      description: input.description,
      cause: input.cause,
    }),
  );

/** Formats a set of options into a list of command-line arguments. */
const formatArgs = (
  options: Record<
    string,
    | boolean
    | string
    | number
    | undefined
    | Record<string, string>
    | Array<string>
  >,
) => {
  const args: Array<string> = [];
  for (const [key, value] of Object.entries(options)) {
    if (!value) continue;
    const prefix = key.length > 1 ? `--${key}` : `-${key}`;
    if (value === true) {
      args.push(prefix);
    } else if (typeof value === "string") {
      args.push(prefix, value);
    } else if (typeof value === "number") {
      args.push(prefix, String(value));
    } else if (Array.isArray(value)) {
      for (const item of value) {
        args.push(prefix, item);
      }
    } else if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        args.push(prefix, `${k}=${v}`);
      }
    }
  }
  return args;
};
