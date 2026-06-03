import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/unstable/process";
import { exec } from "../Util/exec.ts";

export class DockerCommandError extends Data.TaggedError("DockerCommandError")<{
  readonly command: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly message: string;
}> {}

export interface RegistryAuth {
  readonly username: string;
  readonly password: string;
  /**
   * Registry host only (no `https://`, no path), e.g. `123456789.dkr.ecr.us-east-1.amazonaws.com`.
   */
  readonly server: string;
}

export interface DockerBuildOptions {
  /** Image reference passed to `docker build -t`. */
  readonly tag: string;
  /** Build context directory (`.` argument to `docker build`). */
  readonly context: string;
  readonly platform?: string;
  readonly target?: string;
  readonly buildArgs?: Record<string, string>;
  /** Appended to `docker build` before the final context path. */
  readonly extraArgs?: ReadonlyArray<string>;
  readonly env?: Record<string, string | undefined>;
}

export const materializeDockerfile = Effect.fn(function* (
  dockerfile: string,
  dir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(dir, { recursive: true });
  const target = path.join(dir, "Dockerfile");
  yield* fs.writeFileString(target, dockerfile);
  return target;
});

export const writeContextFiles = Effect.fn(function* (
  dir: string,
  files: ReadonlyArray<{
    readonly path: string;
    readonly content: string | Uint8Array;
  }>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const file of files) {
    const fullPath = path.join(dir, file.path);
    yield* fs.makeDirectory(path.dirname(fullPath), { recursive: true });
    if (typeof file.content === "string") {
      yield* fs.writeFileString(fullPath, file.content);
    } else {
      yield* fs.writeFile(fullPath, file.content);
    }
  }
});

export const runDockerCommand = Effect.fn(function* (
  args: ReadonlyArray<string>,
  options?: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    /** Passed to the process stdin (e.g. for `docker login --password-stdin`). */
    stdin?: string;
  },
) {
  const command = `docker ${args.join(" ")}`;
  const env = { ...process.env, ...options?.env };
  const commandOptions: ChildProcess.CommandOptions = {
    env,
    ...(options?.stdin !== undefined
      ? {
          stdin: Stream.succeed(new TextEncoder().encode(options.stdin)),
        }
      : {}),
  };
  const child = options?.cwd
    ? ChildProcess.setCwd(
        ChildProcess.make("docker", args, commandOptions),
        options.cwd,
      )
    : ChildProcess.make("docker", args, commandOptions);

  const { stdout, stderr, exitCode } = yield* exec(child).pipe(
    Effect.catch((e) =>
      Effect.fail(
        new DockerCommandError({
          command,
          stderr: e instanceof Error ? e.message : String(e),
          exitCode: 1,
          message: e instanceof Error ? e.message : String(e),
        }),
      ),
    ),
  );

  if (exitCode !== 0) {
    return yield* Effect.fail(
      new DockerCommandError({
        command,
        stderr,
        exitCode,
        message:
          `Docker command failed (${exitCode}): ${command}\n${stderr}`.trim(),
      }),
    );
  }

  return { stdout, stderr };
});

/**
 * Run `docker build` with standard flags from {@link DockerBuildOptions}.
 */
export const dockerBuild = Effect.fn(function* (options: DockerBuildOptions) {
  const args: string[] = ["build", "-t", options.tag];
  if (options.platform) {
    args.push("--platform", options.platform);
  }
  if (options.target) {
    args.push("--target", options.target);
  }
  if (options.buildArgs) {
    for (const [k, v] of Object.entries(options.buildArgs)) {
      args.push("--build-arg", `${k}=${v}`);
    }
  }
  if (options.extraArgs?.length) {
    args.push(...options.extraArgs);
  }
  args.push(options.context);

  yield* runDockerCommand(args, { env: options.env });
});

/**
 * Get the image ID (content-addressable digest) of a locally-built image.
 */
export const getDockerImageId = Effect.fn(function* (tag: string) {
  const { stdout } = yield* runDockerCommand([
    "inspect",
    "--format",
    "{{.Id}}",
    tag,
  ]);
  return stdout.trim();
});

/**
 * Tag a local image with a new reference.
 */
export const dockerTag = Effect.fn(function* (source: string, target: string) {
  yield* runDockerCommand(["tag", source, target]);
});

/**
 * Log in to a registry using `docker login --password-stdin` (no password on argv).
 */
export const dockerLogin = Effect.fn(function* (
  auth: RegistryAuth,
  options?: { env?: Record<string, string | undefined> },
) {
  yield* runDockerCommand(
    ["login", "-u", auth.username, "--password-stdin", auth.server],
    {
      env: options?.env,
      stdin: auth.password,
    },
  );
});

/**
 * Push an image ref. When `auth` is set, uses an isolated `DOCKER_CONFIG`
 * directory so concurrent deploys do not race on global docker credentials.
 */
export const pushImage = Effect.fn(function* (
  imageRef: string,
  auth?: RegistryAuth,
) {
  if (auth) {
    const fs = yield* FileSystem.FileSystem;
    const configDir = yield* fs.makeTempDirectory({
      prefix: "alchemy-docker-",
    });
    const env = { ...process.env, DOCKER_CONFIG: configDir };
    return yield* Effect.gen(function* () {
      yield* dockerLogin(auth, { env });
      yield* runDockerCommand(["push", imageRef], { env });
    }).pipe(
      Effect.ensuring(
        fs
          .remove(configDir, { recursive: true })
          .pipe(Effect.catch(() => Effect.void)),
      ),
    );
  }
  yield* runDockerCommand(["push", imageRef]);
});
