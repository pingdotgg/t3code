import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { vi } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import * as DirenvEnvironment from "./DirenvEnvironment.ts";

const runMock = vi.fn<ProcessRunner.ProcessRunner["Service"]["run"]>();

const TestLayer = DirenvEnvironment.layer.pipe(
  Layer.provide(
    Layer.succeed(ProcessRunner.ProcessRunner, ProcessRunner.ProcessRunner.of({ run: runMock })),
  ),
  Layer.provide(Layer.succeed(HostProcessPlatform, "linux")),
  Layer.provideMerge(NodeServices.layer),
);

const output = (
  overrides: Partial<ProcessRunner.ProcessRunOutput>,
): ProcessRunner.ProcessRunOutput => ({
  stdout: "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
  ...overrides,
});

/** A project root holding an `.envrc`, and a nested directory a thread might run in. */
const makeProject = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-direnv-" });
  const nested = path.join(root, "packages", "app");
  yield* fileSystem.makeDirectory(nested, { recursive: true });
  yield* fileSystem.writeFileString(path.join(root, ".envrc"), "use flake\n");
  return { envrcPath: path.join(root, ".envrc"), nested };
});

afterEach(() => {
  runMock.mockReset();
});

describe("DirenvEnvironment.load", () => {
  it.effect("skips direnv when no .envrc governs the directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-direnv-" });
      const direnv = yield* DirenvEnvironment.DirenvEnvironment;

      expect(yield* direnv.load(cwd)).toEqual({ _tag: "None" });
      expect(runMock).not.toHaveBeenCalled();
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("loads the exported variables from the nearest parent .envrc", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeProject;
      runMock.mockReturnValueOnce(
        Effect.succeed(output({ stdout: '{"PATH":"/nix/store/x/bin:/usr/bin","OLD":null}' })),
      );
      const direnv = yield* DirenvEnvironment.DirenvEnvironment;

      const result = yield* direnv.load(nested);

      expect(result).toEqual({
        _tag: "Loaded",
        diff: { PATH: "/nix/store/x/bin:/usr/bin", OLD: null },
        changed: true,
      });
      expect(runMock).toHaveBeenCalledWith(
        expect.objectContaining({ command: "direnv", args: ["export", "json"], cwd: nested }),
      );
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("reports a blocked .envrc instead of loading it", () =>
    Effect.gen(function* () {
      const { envrcPath, nested } = yield* makeProject;
      runMock.mockReturnValueOnce(
        Effect.succeed(
          output({
            // direnv still prints its own bookkeeping variables when blocked.
            stdout: '{"DIRENV_DIR":"-/project"}',
            stderr: `\u001b[31mdirenv: error ${envrcPath} is blocked. Run \`direnv allow\` to approve its content\u001b[0m\n`,
            code: ChildProcessSpawner.ExitCode(1),
          }),
        ),
      );
      const direnv = yield* DirenvEnvironment.DirenvEnvironment;

      const result = yield* direnv.load(nested);

      expect(result).toEqual({
        _tag: "Failed",
        envrcPath,
        reason: "blocked",
        message: `${envrcPath} is blocked. Run \`direnv allow\` to approve its content`,
      });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("treats a missing direnv binary as no project environment", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeProject;
      runMock.mockReturnValueOnce(
        Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: "direnv",
            argumentCount: 2,
            cause: new Error("spawn direnv ENOENT"),
          }),
        ),
      );
      const direnv = yield* DirenvEnvironment.DirenvEnvironment;

      expect(yield* direnv.load(nested)).toEqual({ _tag: "None" });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("reports a timed-out load", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeProject;
      runMock.mockReturnValueOnce(Effect.succeed(output({ code: null, timedOut: true })));
      const direnv = yield* DirenvEnvironment.DirenvEnvironment;

      const result = yield* direnv.load(nested);

      expect(result).toMatchObject({ _tag: "Failed", reason: "timeout" });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("checks staleness against exactly the previously loaded environment", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeProject;
      const previous = { PATH: "/nix/store/old/bin", STALE: null, DIRENV_DIFF: "v1" };
      runMock.mockReturnValueOnce(Effect.succeed(output({ stdout: "" })));
      const direnv = yield* DirenvEnvironment.DirenvEnvironment;

      const result = yield* direnv.load(nested, previous);

      expect(result).toEqual({ _tag: "Loaded", diff: previous, changed: false });
      const input = runMock.mock.calls[0]?.[0];
      expect(input?.extendEnv).toBe(false);
      expect(input?.env?.PATH).toBe("/nix/store/old/bin");
      expect(input?.env && "STALE" in input.env).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("keeps the diff relative to the server environment after a change", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeProject;
      const previous = { PATH: "/nix/store/old/bin", FOO: "1", DIRENV_DIFF: "v1" };
      runMock.mockReturnValueOnce(
        Effect.succeed(output({ stdout: '{"PATH":"/nix/store/new/bin","DIRENV_DIFF":"v2"}' })),
      );
      const direnv = yield* DirenvEnvironment.DirenvEnvironment;

      expect(yield* direnv.load(nested, previous)).toEqual({
        _tag: "Loaded",
        diff: { PATH: "/nix/store/new/bin", FOO: "1", DIRENV_DIFF: "v2" },
        changed: true,
      });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("shares one evaluation between concurrent loads of a directory", () =>
    Effect.gen(function* () {
      const { nested } = yield* makeProject;
      const release = yield* Deferred.make<void>();
      runMock.mockReturnValueOnce(
        Deferred.await(release).pipe(Effect.as(output({ stdout: '{"FOO":"bar"}' }))),
      );
      const direnv = yield* DirenvEnvironment.DirenvEnvironment;

      const first = yield* Effect.forkChild(direnv.load(nested), { startImmediately: true });
      const second = yield* Effect.forkChild(direnv.load(nested), { startImmediately: true });
      yield* Deferred.succeed(release, undefined);

      expect(yield* Fiber.join(first)).toEqual(yield* Fiber.join(second));
      expect(runMock).toHaveBeenCalledTimes(1);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("DirenvEnvironment.allow", () => {
  it.effect("allows the .envrc governing the directory", () =>
    Effect.gen(function* () {
      const { envrcPath, nested } = yield* makeProject;
      runMock.mockReturnValueOnce(Effect.succeed(output({})));
      const direnv = yield* DirenvEnvironment.DirenvEnvironment;

      expect(yield* direnv.allow(nested)).toEqual({ _tag: "Allowed", envrcPath });
      expect(runMock).toHaveBeenCalledWith(
        expect.objectContaining({ command: "direnv", args: ["allow", envrcPath] }),
      );
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

describe("applyDirenvEnvironment", () => {
  const serverEnv = { PATH: "/usr/bin", HOME: "/home/user", STALE: "1" };

  it("sets and unsets variables over the server environment", () => {
    expect(
      DirenvEnvironment.applyDirenvEnvironment(
        serverEnv,
        { PATH: "/nix/store/x/bin:/usr/bin", STALE: null, IN_NIX_SHELL: "impure" },
        serverEnv,
      ),
    ).toEqual({ PATH: "/nix/store/x/bin:/usr/bin", HOME: "/home/user", IN_NIX_SHELL: "impure" });
  });

  it("keeps values the provider instance configured itself", () => {
    const instanceEnv = { ...serverEnv, CLAUDE_CONFIG_DIR: "/home/user/.claude-work" };

    expect(
      DirenvEnvironment.applyDirenvEnvironment(
        instanceEnv,
        { CLAUDE_CONFIG_DIR: "/project/.claude", FOO: "bar" },
        serverEnv,
      ),
    ).toEqual({ ...instanceEnv, FOO: "bar" });
  });
});
