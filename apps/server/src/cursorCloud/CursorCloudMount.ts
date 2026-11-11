import {
  CursorCloudError,
  cursorCloudWorkspacePath,
  parseCursorCloudWorkspacePath,
  type ThreadId,
} from "@t3tools/contracts";
import {
  CURSOR_CLOUD_WORKSPACE_ROOT,
  RemoteCallError,
  type CursorCloudMachineApi,
} from "@t3tools/provider-cursor/server/cloudMachine";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as ByteSize from "effect/ByteSize";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { systemError, type PlatformError } from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export interface CursorCloudMachineOptions {
  /** Starting a sleeping VM bills the user, so only explicit actions such as terminals wake it. */
  readonly wake: boolean;
}

export interface CursorCloudMachineSource {
  readonly machine: (
    threadId: ThreadId,
    options: CursorCloudMachineOptions,
  ) => Effect.Effect<CursorCloudMachineApi, CursorCloudError>;
}

/**
 * Serves `/.t3-cursor-cloud/<threadId>` paths from that thread's Cursor cloud VM, so path-based
 * features (files, Git, terminals) run there unchanged. The machines service registers later
 * because it depends on settings and credentials that themselves use the filesystem.
 */
export class CursorCloudMount extends Context.Service<
  CursorCloudMount,
  {
    readonly register: (source: CursorCloudMachineSource) => Effect.Effect<void>;
    readonly machine: CursorCloudMachineSource["machine"];
  }
>()("t3/cursorCloud/CursorCloudMount") {}

const remotePath = (relativePath: string) =>
  relativePath === ""
    ? CURSOR_CLOUD_WORKSPACE_ROOT
    : `${CURSOR_CLOUD_WORKSPACE_ROOT}/${relativePath}`;

const isRemoteCallError = Schema.is(RemoteCallError);
const VM_PID_OFFSET = 2 ** 30;

const commandName = (command: string) =>
  (command.split(/[\\/]/).pop() ?? command).replace(/\.(exe|cmd|bat)$/i, "");

const WORKSPACE_PATH_LINE = /^(worktree )?\/workspace((?:\/[^\n]*)?)$/gm;

const MOUNT_IN_TEXT = /(?:[A-Za-z]:)?[\\/]\.t3-cursor-cloud[\\/]([^\\/\s"']+)((?:[\\/][^\s"']*)?)/g;

const remoteErrorTag = (cause: unknown) => {
  const name = isRemoteCallError(cause) ? (cause.remoteName ?? "") : "";
  if (name.startsWith("EntryNotFound")) return "NotFound" as const;
  if (name.startsWith("EntryExists")) return "AlreadyExists" as const;
  if (name.startsWith("NoPermissions")) return "PermissionDenied" as const;
  if (name.startsWith("EntryIsADirectory") || name.startsWith("EntryNotADirectory"))
    return "BadResource" as const;
  return "Unknown" as const;
};

const fileInfo = (stat: { type: string; size: number; mtime: number }): FileSystem.File.Info => ({
  type:
    stat.type === "Directory" || stat.type === "File" || stat.type === "SymbolicLink"
      ? stat.type
      : "Unknown",
  mtime: Option.some(DateTime.toDateUtc(DateTime.makeUnsafe(stat.mtime))),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0n,
  ino: Option.none(),
  mode: stat.type === "Directory" ? 0o755 : 0o644,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: ByteSize.fromInputUnsafe(stat.size),
  blksize: Option.none(),
  blocks: Option.none(),
});

/**
 * Keeps only variables that change Git's output; host paths and secrets stay on the host.
 * `GIT_CONFIG_*` numbering continues the host's own entries, which the VM does not have.
 */
const remoteEnv = (
  env: Record<string, string | Redacted.Redacted<string> | undefined> | undefined,
) =>
  Object.fromEntries(
    Object.entries(env ?? {}).flatMap(([key, value]) =>
      value !== undefined &&
      (key === "GIT_OPTIONAL_LOCKS" ||
        key === "GIT_TERMINAL_PROMPT" ||
        key === "LANGUAGE" ||
        key === "LC_ALL")
        ? [[key, Redacted.isRedacted(value) ? Redacted.value(value) : value]]
        : [],
    ),
  );

export const layer = Layer.effectContext(
  Effect.gen(function* () {
    const baseFileSystem = yield* FileSystem.FileSystem;
    const baseSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const source = yield* Deferred.make<CursorCloudMachineSource>();

    const machine = (threadId: ThreadId, options: CursorCloudMachineOptions) =>
      Deferred.await(source).pipe(
        Effect.timeoutOrElse({
          duration: "30 seconds",
          orElse: () => Effect.fail(new CursorCloudError({ reason: "disabled" })),
        }),
        Effect.flatMap((registered) => registered.machine(threadId, options)),
      );

    const remote = <A>(
      method: string,
      path: string,
      run: (machine: CursorCloudMachineApi, path: string) => Promise<A>,
    ): Effect.Effect<A, PlatformError> => {
      const mounted = parseCursorCloudWorkspacePath(path);
      if (mounted === null) {
        return Effect.die(new Error(`${path} is not a Cursor Cloud path`));
      }
      return machine(mounted.threadId, { wake: false }).pipe(
        Effect.mapError((cause) =>
          systemError({
            _tag: "Unknown",
            module: "FileSystem",
            method,
            pathOrDescriptor: path,
            description: cause.message,
            cause,
          }),
        ),
        Effect.flatMap((connected) =>
          Effect.tryPromise({
            try: () => run(connected, remotePath(mounted.relativePath)),
            catch: (cause) =>
              systemError({
                _tag: remoteErrorTag(cause),
                module: "FileSystem",
                method,
                pathOrDescriptor: path,
                description: cause instanceof Error ? cause.message : undefined,
                cause,
              }),
          }),
        ),
      );
    };
    const isMounted = (path: string) => parseCursorCloudWorkspacePath(path) !== null;

    const readDirectory = (
      path: string,
      recursive: boolean,
    ): Effect.Effect<Array<string>, PlatformError> =>
      remote("readDirectory", path, async (connected, root) => {
        const names: string[] = [];
        const walk = async (directory: string, prefix: string): Promise<void> => {
          for (const entry of await connected.readdir(directory)) {
            const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
            names.push(name);
            if (recursive && entry.type === "Directory") {
              await walk(`${directory}/${entry.name}`, name);
            }
          }
        };
        await walk(root, "");
        return names;
      });

    const fileSystem: FileSystem.FileSystem = {
      ...baseFileSystem,
      access: (path, options) =>
        isMounted(path)
          ? remote("access", path, (connected, target) => connected.stat(target)).pipe(
              Effect.asVoid,
            )
          : baseFileSystem.access(path, options),
      exists: (path) =>
        isMounted(path)
          ? remote("exists", path, (connected, target) => connected.stat(target)).pipe(
              Effect.as(true),
              Effect.catchTags({
                PlatformError: (error) =>
                  error.reason._tag === "NotFound" ? Effect.succeed(false) : Effect.fail(error),
              }),
            )
          : baseFileSystem.exists(path),
      stat: (path) =>
        isMounted(path)
          ? remote("stat", path, (connected, target) => connected.stat(target)).pipe(
              Effect.map(fileInfo),
            )
          : baseFileSystem.stat(path),
      lstat: (path) =>
        isMounted(path)
          ? remote("lstat", path, (connected, target) => connected.stat(target)).pipe(
              Effect.map(fileInfo),
            )
          : baseFileSystem.lstat(path),
      realPath: (path) => (isMounted(path) ? Effect.succeed(path) : baseFileSystem.realPath(path)),
      readDirectory: (path, options) =>
        isMounted(path)
          ? readDirectory(path, options?.recursive === true)
          : baseFileSystem.readDirectory(path, options),
      readDirectoryEntries: (path) =>
        isMounted(path)
          ? remote("readDirectoryEntries", path, (connected, target) => connected.readdir(target))
          : baseFileSystem.readDirectoryEntries(path),
      readFile: (path) =>
        isMounted(path)
          ? remote("readFile", path, (connected, target) => connected.readFile(target))
          : baseFileSystem.readFile(path),
      readFileString: (path, encoding) =>
        isMounted(path)
          ? remote("readFileString", path, (connected, target) => connected.readFile(target)).pipe(
              Effect.map((bytes) => new TextDecoder(encoding).decode(bytes)),
            )
          : baseFileSystem.readFileString(path, encoding),
      stream: (path, options) =>
        isMounted(path)
          ? Stream.fromEffect(
              remote("stream", path, (connected, target) => connected.readFile(target)),
            )
          : baseFileSystem.stream(path, options),
      writeFile: (path, data, options) =>
        isMounted(path)
          ? remote("writeFile", path, (connected, target) => connected.writeFile(target, data))
          : baseFileSystem.writeFile(path, data, options),
      writeFileString: (path, data, options) =>
        isMounted(path)
          ? remote("writeFileString", path, (connected, target) =>
              connected.writeFile(target, new TextEncoder().encode(data)),
            )
          : baseFileSystem.writeFileString(path, data, options),
      makeDirectory: (path, options) =>
        isMounted(path)
          ? remote("makeDirectory", path, async (connected, target) => {
              if (options?.recursive !== true) return connected.mkdir(target);
              const parts = target.split("/").filter(Boolean);
              for (let index = 1; index <= parts.length; index++) {
                const prefix = `/${parts.slice(0, index).join("/")}`;
                await connected.mkdir(prefix).catch((cause: unknown) => {
                  if (remoteErrorTag(cause) !== "AlreadyExists") throw cause;
                });
              }
            })
          : baseFileSystem.makeDirectory(path, options),
      remove: (path, options) =>
        isMounted(path)
          ? remote("remove", path, (connected, target) =>
              connected.delete(target, options?.recursive === true),
            ).pipe(
              Effect.catchTags({
                PlatformError: (error) =>
                  options?.force === true && error.reason._tag === "NotFound"
                    ? Effect.void
                    : Effect.fail(error),
              }),
            )
          : baseFileSystem.remove(path, options),
      rename: (from, to) => {
        const target = parseCursorCloudWorkspacePath(to);
        return isMounted(from) && target !== null
          ? remote("rename", from, (connected, source) =>
              connected.rename(source, remotePath(target.relativePath)),
            )
          : baseFileSystem.rename(from, to);
      },
      // VM changes reach clients through their own refreshes; cursor-server watching is per-session.
      watch: (path, options) =>
        isMounted(path) ? Stream.never : baseFileSystem.watch(path, options),
    };

    const spawnRemote = Effect.fn("CursorCloudMount.spawn")(function* (
      command: ChildProcess.StandardCommand,
      threadId: ThreadId,
    ) {
      const rewrite = (text: string) =>
        text.replace(MOUNT_IN_TEXT, (_match, mountedThread: string, rest: string) => {
          if (mountedThread !== threadId) return _match;
          return remotePath(rest.replaceAll("\\", "/").replace(/^\/+/, ""));
        });
      const args = command.args.map((arg) =>
        rewrite(typeof arg === "string" ? arg : Redacted.value(arg)),
      );
      const cwd =
        command.options.cwd !== undefined && isMounted(command.options.cwd)
          ? rewrite(command.options.cwd)
          : CURSOR_CLOUD_WORKSPACE_ROOT;
      const connected = yield* machine(threadId, { wake: false }).pipe(
        Effect.mapError((cause) =>
          systemError({
            _tag: "Unknown",
            module: "ChildProcess",
            method: "spawn",
            pathOrDescriptor: command.command,
            description: cause.message,
            cause,
          }),
        ),
      );
      const stdinChunks: Uint8Array[] = [];
      const stdinDone = yield* Deferred.make<void>();
      const demanded = yield* Deferred.make<void>();
      let stdinStarted = false;
      // The process starts on first demand. Callers write stdin concurrently with reading output,
      // so yield once to let a stdin writer start before deciding whether to wait for it.
      const execution = yield* Effect.gen(function* () {
        yield* Deferred.await(demanded);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        if (stdinStarted) yield* Deferred.await(stdinDone);
        const stdin =
          stdinChunks.length === 0
            ? undefined
            : Uint8Array.from(stdinChunks.flatMap((chunk) => Array.from(chunk)));
        return yield* Effect.tryPromise({
          try: (signal) =>
            connected.exec(
              {
                command: commandName(command.command),
                args,
                cwd,
                env: remoteEnv(command.options.env),
                ...(stdin === undefined ? {} : { stdin }),
              },
              signal,
            ),
          catch: (cause) =>
            systemError({
              _tag: "Unknown",
              module: "ChildProcess",
              method: "spawn",
              pathOrDescriptor: command.command,
              description: isRemoteCallError(cause) ? cause.message : undefined,
              cause,
            }),
        });
      }).pipe(Effect.forkScoped);
      const result = Deferred.succeed(demanded, undefined).pipe(
        Effect.andThen(Fiber.join(execution)),
      );
      let running = true;
      const finished = result.pipe(Effect.ensuring(Effect.sync(() => (running = false))));
      // `git rev-parse` and `git worktree` print VM paths that callers pass back as cwd.
      const mountRoot = cursorCloudWorkspacePath(threadId);
      const printsPaths =
        commandName(command.command) === "git" &&
        args.some((arg) => arg === "rev-parse" || arg === "worktree");
      const output = (pick: (value: { stdout: Uint8Array; stderr: Uint8Array }) => Uint8Array) =>
        Stream.unwrap(
          finished.pipe(
            Effect.map((value) => {
              const raw = pick(value);
              const bytes =
                printsPaths && raw.byteLength > 0
                  ? new TextEncoder().encode(
                      new TextDecoder()
                        .decode(raw)
                        .replace(
                          WORKSPACE_PATH_LINE,
                          (_line, prefix: string | undefined, rest: string) =>
                            `${prefix ?? ""}${mountRoot}${rest}`,
                        ),
                    )
                  : raw;
              return bytes.byteLength === 0 ? Stream.empty : Stream.make(bytes);
            }),
          ),
        );
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: finished.pipe(
          Effect.map((value) => ChildProcessSpawner.ExitCode(value.exitCode)),
        ),
        isRunning: Effect.sync(() => running),
        kill: () => Fiber.interrupt(execution),
        stdin: Sink.unwrap(
          Effect.sync(() => {
            stdinStarted = true;
            return Sink.forEach((chunk: Uint8Array) => Effect.sync(() => stdinChunks.push(chunk)));
          }),
        ).pipe(Sink.ensuring(Deferred.succeed(stdinDone, undefined))),
        stdout: output((value) => value.stdout),
        stderr: output((value) => value.stderr),
        all: output((value) => value.stdout),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    });

    const mountedThread = (command: ChildProcess.Command) => {
      if (command._tag !== "StandardCommand") return null;
      const cwd = command.options.cwd;
      const fromCwd = cwd === undefined ? null : parseCursorCloudWorkspacePath(cwd);
      if (fromCwd !== null) return fromCwd.threadId;
      // VcsProcess runs `git -C <cwd>` from the server's own directory.
      for (let index = 0; index < command.args.length - 1; index++) {
        const arg = command.args[index + 1];
        if (command.args[index] === "-C" && typeof arg === "string") {
          const mounted = parseCursorCloudWorkspacePath(arg);
          if (mounted !== null) return mounted.threadId;
        }
      }
      return null;
    };

    const spawner = ChildProcessSpawner.make((command) => {
      const threadId = mountedThread(command);
      return threadId === null || command._tag !== "StandardCommand"
        ? baseSpawner.spawn(command)
        : spawnRemote(command, threadId);
    });

    const mount = CursorCloudMount.of({
      register: Effect.fn("CursorCloudMount.register")(function* (registered) {
        yield* Deferred.succeed(source, registered);
      }),
      machine,
    });

    return Context.make(CursorCloudMount, mount).pipe(
      Context.add(FileSystem.FileSystem, fileSystem),
      Context.add(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
  }),
);

/** Terminals whose cwd is mounted open a login shell on the VM; others use the host PTY. */
export const layerPtyAdapter = Layer.effect(
  PtyAdapter.PtyAdapter,
  Effect.gen(function* () {
    const base = yield* PtyAdapter.PtyAdapter;
    const mount = yield* CursorCloudMount;
    const spawnFailed = (cause: unknown) =>
      new PtyAdapter.PtySpawnError({ adapter: "cursor-cloud", cause });
    return PtyAdapter.PtyAdapter.of({
      spawn: Effect.fn("CursorCloudMount.spawnPty")(function* (input) {
        const mounted = parseCursorCloudWorkspacePath(input.cwd);
        if (mounted === null) return yield* base.spawn(input);
        const connected = yield* mount
          .machine(mounted.threadId, { wake: true })
          .pipe(Effect.mapError(spawnFailed));
        const pty = yield* Effect.tryPromise({
          try: () =>
            connected.spawnPty({
              executable: "/bin/bash",
              args: ["-l"],
              cwd: remotePath(mounted.relativePath),
              cols: input.cols,
              rows: input.rows,
              env: { COLORTERM: "truecolor" },
            }),
          catch: spawnFailed,
        });
        return {
          // Subprocess and port inspection read the host's process table; host pids stay below 2^30.
          pid: VM_PID_OFFSET + pty.pid,
          write: pty.write,
          resize: pty.resize,
          kill: () => pty.kill(),
          onData: pty.onData,
          onExit: (callback) => pty.onExit((exitCode) => callback({ exitCode, signal: null })),
        } satisfies PtyAdapter.PtyProcess;
      }),
    });
  }),
);
