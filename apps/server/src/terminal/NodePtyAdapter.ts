import * as NodeModule from "node:module";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as PtyAdapter from "./PtyAdapter.ts";

export class NodePtyModuleLoadError extends Schema.TaggedErrorClass<NodePtyModuleLoadError>()(
  "NodePtyModuleLoadError",
  {
    platform: Schema.String,
    architecture: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to load node-pty for ${this.platform}-${this.architecture}.`;
  }

  /**
   * Full, user-facing explanation of the load failure. Written straight to
   * stderr at startup so a broken install never exits without output.
   */
  get diagnostic(): string {
    const causeMessage = this.cause instanceof Error ? this.cause.message : String(this.cause);
    return [
      this.message,
      `Caused by: ${causeMessage}`,
      "",
      "node-pty is the native module that powers t3 terminals. It is compiled (or a",
      "prebuild is unpacked) when t3 is installed, so this usually means the install",
      "could not produce a working binary for this machine:",
      "  - the machine is missing a C/C++ toolchain (macOS: `xcode-select --install`,",
      "    Debian/Ubuntu: `sudo apt-get install -y build-essential python3`), or",
      "  - t3 was installed with a different Node.js version or architecture than the",
      "    one running now.",
      "Fix the toolchain, then reinstall t3 (`npm install -g t3`, or clear the npx",
      "cache with `rm -rf ~/.npm/_npx` and re-run `npx t3`).",
    ].join("\n");
  }
}

type NodePtyModuleLoader = () => Promise<typeof import("node-pty")>;

let didEnsureSpawnHelperExecutable = false;

const resolveNodePtySpawnHelperPath = Effect.gen(function* () {
  const requireForNodePty = NodeModule.createRequire(import.meta.url);
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;

  const packageJsonPath = requireForNodePty.resolve("node-pty/package.json");
  const packageDir = path.dirname(packageJsonPath);
  const candidates = [
    path.join(packageDir, "build", "Release", "spawn-helper"),
    path.join(packageDir, "build", "Debug", "spawn-helper"),
    path.join(packageDir, "prebuilds", `${platform}-${architecture}`, "spawn-helper"),
  ];

  for (const candidate of candidates) {
    if (yield* fs.exists(candidate)) {
      return candidate;
    }
  }
  return null;
}).pipe(Effect.orElseSucceed(() => null));

const ensureNodePtySpawnHelperExecutable = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  if (platform === "win32") return;
  if (didEnsureSpawnHelperExecutable) return;

  const helperPath = yield* resolveNodePtySpawnHelperPath;
  if (!helperPath) {
    didEnsureSpawnHelperExecutable = true;
    return;
  }

  // npm can extract the package without the exec bit on spawn-helper, which then
  // surfaces as "posix_spawnp failed" for every shell. Chmod unconditionally
  // instead of stat-then-chmod: in packaged mode some fs metadata can be missing.
  const chmodResult = yield* Effect.result(fs.chmod(helperPath, 0o755));
  if (chmodResult._tag === "Success") {
    didEnsureSpawnHelperExecutable = true;
    return;
  }
  // Leave the flag unset so the next spawn retries; a transient failure (e.g. a
  // fleeting read-only mount) should not disable the repair forever.
  yield* Effect.logWarning("failed to mark node-pty spawn-helper executable", {
    helperPath,
    error: chmodResult.failure,
    remedy: `chmod +x "${helperPath}"`,
  });
});

export const spawnHelperNotExecutableMessage = (helperPath: string): string =>
  `node-pty's spawn-helper at ${helperPath} is not executable, so every shell fails with "posix_spawnp failed". Fix it with: chmod +x "${helperPath}"`;

const causeMentionsPosixSpawnFailure = (cause: unknown): boolean => {
  let current: unknown = cause;
  const seen = new Set<unknown>();
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (typeof current === "string") {
      return current.toLowerCase().includes("posix_spawnp failed");
    }
    if (current instanceof Error) {
      if (current.message.toLowerCase().includes("posix_spawnp failed")) {
        return true;
      }
      current = current.cause;
      continue;
    }
    return false;
  }
  return false;
};

/**
 * Wraps a spawn failure with an actionable message when the real culprit is a
 * non-executable spawn-helper. Without this, the shell-candidate fallback in the
 * terminal manager retries every shell and reports the failure as if no working
 * shell existed on the machine.
 */
export const describeSpawnFailure = (input: {
  cause: unknown;
  platform: string;
  helperPath: string | null;
  helperIsExecutable: boolean;
}): unknown => {
  if (input.platform === "win32") return input.cause;
  if (!causeMentionsPosixSpawnFailure(input.cause)) return input.cause;
  if (input.helperPath === null || input.helperIsExecutable) return input.cause;
  return new Error(spawnHelperNotExecutableMessage(input.helperPath), { cause: input.cause });
};

class NodePtyProcess implements PtyAdapter.PtyProcess {
  private readonly process: import("node-pty").IPty;

  constructor(process: import("node-pty").IPty) {
    this.process = process;
  }

  get pid(): number {
    return this.process.pid;
  }

  write(data: string): void {
    this.process.write(data);
  }

  resize(cols: number, rows: number): void {
    this.process.resize(cols, rows);
  }

  kill(signal?: string): void {
    this.process.kill(signal);
  }

  onData(callback: (data: string) => void): () => void {
    const disposable = this.process.onData(callback);
    return () => {
      disposable.dispose();
    };
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    const disposable = this.process.onExit((event) => {
      callback({
        exitCode: event.exitCode,
        signal: event.signal ?? null,
      });
    });
    return () => {
      disposable.dispose();
    };
  }
}

export const make = Effect.fn("NodePtyAdapter.make")(function* (
  loadNodePtyModule: NodePtyModuleLoader = () => import("node-pty"),
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;

  const nodePty = yield* Effect.tryPromise({
    try: loadNodePtyModule,
    catch: (cause) =>
      new NodePtyModuleLoadError({
        platform,
        architecture,
        cause,
      }),
  }).pipe(
    // The defect below can be swallowed by headless startup logging, which used
    // to make `npx t3` exit cleanly with no output on a broken install. Write
    // the diagnosis straight to stderr and force a failing exit code first.
    Effect.tapError((error) =>
      Effect.sync(() => {
        process.exitCode = 1;
        process.stderr.write(`${error.diagnostic}\n`);
      }),
    ),
    Effect.orDie,
  );

  const ensureSpawnHelperExecutable = ensureNodePtySpawnHelperExecutable().pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.provideService(HostProcessPlatform, platform),
    Effect.provideService(HostProcessArchitecture, architecture),
  );
  const resolveSpawnHelperPath = resolveNodePtySpawnHelperPath.pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.provideService(HostProcessPlatform, platform),
    Effect.provideService(HostProcessArchitecture, architecture),
  );
  const spawnHelperIsExecutable = (helperPath: string) =>
    fs.stat(helperPath).pipe(
      Effect.map((info) => (info.mode & 0o111) !== 0),
      // When metadata is unavailable (packaged mode) assume the helper is fine
      // rather than pointing users at a chmod that may not help.
      Effect.orElseSucceed(() => true),
    );

  return PtyAdapter.PtyAdapter.of({
    spawn: Effect.fn("NodePtyAdapter.spawn")(function* (input) {
      yield* ensureSpawnHelperExecutable;
      const attempt = yield* Effect.result(
        Effect.try({
          try: () =>
            nodePty.spawn(input.shell, input.args ?? [], {
              cwd: input.cwd,
              cols: input.cols,
              rows: input.rows,
              env: input.env,
              name: platform === "win32" ? "xterm-color" : "xterm-256color",
            }),
          catch: (cause) =>
            new PtyAdapter.PtySpawnError({
              adapter: "node-pty",
              shell: input.shell,
              cause,
            }),
        }),
      );
      if (attempt._tag === "Success") {
        return new NodePtyProcess(attempt.success);
      }

      const spawnCause = attempt.failure.cause;
      if (platform === "win32" || !causeMentionsPosixSpawnFailure(spawnCause)) {
        return yield* attempt.failure;
      }
      const helperPath = yield* resolveSpawnHelperPath;
      const helperIsExecutable =
        helperPath === null ? true : yield* spawnHelperIsExecutable(helperPath);
      return yield* new PtyAdapter.PtySpawnError({
        adapter: "node-pty",
        shell: input.shell,
        cause: describeSpawnFailure({
          cause: spawnCause,
          platform,
          helperPath,
          helperIsExecutable,
        }),
      });
    }),
  });
});

export const layer = Layer.effect(PtyAdapter.PtyAdapter, make());
