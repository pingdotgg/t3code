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
        command: Array<string> | undefined;
        label?: Record<string, string>;
      }) => Effect.Effect<CommandOutput, PlatformError>;
      /** Inspects a container. */
      readonly inspect: (
        name: string,
      ) => Effect.Effect<Docker.Container, PlatformError>;
      /** Removes a container. */
      readonly remove: (
        name: string,
        force?: boolean,
      ) => Effect.Effect<CommandOutput, PlatformError>;
      /** Starts a container. */
      readonly start: (
        name: string,
      ) => Effect.Effect<CommandOutput, PlatformError>;
      /** Stops a container. */
      readonly stop: (
        name: string,
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
        },
        session?: ScopedPlanStatusSession,
      ) => Effect.Effect<CommandOutput, PlatformError>;
      /** Pulls an image. */
      readonly pull: (
        ref: string,
        platform?: string,
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
      ) => Effect.Effect<CommandOutput, PlatformError>;
      /** Tags an image. */
      readonly tag: (
        source: string,
        target: string,
      ) => Effect.Effect<CommandOutput, PlatformError>;
      /** Inspects an image. */
      readonly inspect: (
        ref: string,
      ) => Effect.Effect<Docker.Image, PlatformError>;
      /** Removes an image. */
      readonly remove: (
        ref: string | Array<string>,
        force?: boolean,
      ) => Effect.Effect<CommandOutput, PlatformError>;
    };
    readonly volume: {
      /** Creates a new volume. */
      readonly create: (options: {
        name: string;
        driver?: string;
        opt?: Record<string, string>;
        label?: Record<string, string>;
      }) => Effect.Effect<CommandOutput, PlatformError>;
      /** Removes a volume. */
      readonly remove: (
        name: string,
      ) => Effect.Effect<CommandOutput, PlatformError>;
      /** Inspects a volume. */
      readonly inspect: (
        name: string,
      ) => Effect.Effect<Docker.Volume, PlatformError>;
    };
    readonly network: {
      /** Creates a new network. */
      readonly create: (options: {
        name: string;
        driver: string;
        ipv6?: boolean;
        label?: Record<string, string>;
      }) => Effect.Effect<CommandOutput, PlatformError>;
      /** Connects a container to a network. */
      readonly connect: (options: {
        network: string;
        container: string;
        alias?: string[];
      }) => Effect.Effect<CommandOutput, PlatformError>;
      /** Disconnects a container from a network. */
      readonly disconnect: (options: {
        network: string;
        container: string;
      }) => Effect.Effect<CommandOutput, PlatformError>;
      /** Inspects a network. */
      readonly inspect: (
        name: string,
      ) => Effect.Effect<Docker.Network, PlatformError>;
      /** Removes a network. */
      readonly remove: (
        id: string,
      ) => Effect.Effect<CommandOutput, PlatformError>;
    };
  }
>()("@alchemy/Docker") {}

export declare namespace Docker {
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
        create: ({ image, env, command, ...options }) =>
          run(
            [
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
        inspect: (name) =>
          runInspect<Docker.Container>(["container", "inspect", name]),
        remove: (name, force) =>
          run(["container", "rm", name, ...(force ? ["-f"] : [])]),
        start: (name) => run(["container", "start", name]),
        stop: (name) => run(["container", "stop", name]),
      },
      image: {
        build: ({ context, args, ...options }, session) =>
          run(
            [
              "image",
              "build",
              context,
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
        pull: (ref, platform) =>
          run([
            "image",
            "pull",
            ref,
            ...(platform ? ["--platform", platform] : []),
          ]),
        inspect: (ref) => runInspect<Docker.Image>(["image", "inspect", ref]),
        remove: (ref, force) =>
          run([
            "image",
            "rm",
            ...(Array.isArray(ref) ? ref : [ref]),
            ...(force ? ["-f"] : []),
          ]),
        tag: (source, target) => run(["image", "tag", source, target]),
        push: Effect.fn(function* (ref, credentials, platform) {
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
            return yield* run(["push", ref], { DOCKER_CONFIG: dir });
          }
          return yield* run(["push", "--platform", platform, ref], {
            DOCKER_CONFIG: dir,
          }).pipe(
            // Engines without the containerd image store reject `--platform`
            // on push; their local tag is already narrowed to the requested
            // platform by `pull --platform`, so a plain push is equivalent.
            Effect.catchIf(
              (error) =>
                /--platform|unknown flag|containerd/i.test(String(error)),
              () => run(["push", ref], { DOCKER_CONFIG: dir }),
            ),
          );
        }, Effect.scoped),
      },
      volume: {
        create: (options) => run(["volume", "create", ...formatArgs(options)]),
        remove: (name) => run(["volume", "rm", name]),
        inspect: (name) =>
          runInspect<Docker.Volume>(["volume", "inspect", name]),
      },
      network: {
        create: ({ name, driver, ipv6, label }) =>
          run([
            "network",
            "create",
            name,
            ...formatArgs({ driver, ipv6, label }),
          ]),
        connect: ({ network, container, alias }) =>
          run([
            "network",
            "connect",
            network,
            container,
            ...(alias ? alias.flatMap((a) => ["--alias", a]) : []),
          ]),
        disconnect: ({ network, container }) =>
          run(["network", "disconnect", network, container]),
        inspect: (name) =>
          runInspect<Docker.Network>(["network", "inspect", name]),
        remove: (id) => run(["network", "rm", id]),
      },
    });
  }),
);

export const dockerPhysicalName = (
  id: string,
  props: { name?: string } | undefined,
  instanceId: string,
) =>
  props?.name
    ? Effect.succeed(props.name)
    : createPhysicalName({
        id,
        instanceId,
        maxLength: 128,
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
