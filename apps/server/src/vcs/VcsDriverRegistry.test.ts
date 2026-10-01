import { assert, it, describe } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as VcsProcess from "./VcsProcess.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const normalizeGitArgs = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args[0] === "-C" && args.length >= 2 ? args.slice(2) : args;

describe("VcsDriverRegistry", () => {
  it.effect("routes directly by VCS driver kind for non-repository workflows", () => {
    const layer = Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
      Layer.provide(NodeServices.layer),
      Layer.provide(
        Layer.mock(VcsProjectConfig.VcsProjectConfig)({
          resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
        }),
      ),
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: () => Effect.succeed(processOutput("")),
        }),
      ),
    );

    return Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      const driver = yield* registry.get("git");

      assert.strictEqual(driver.capabilities.kind, "git");
    }).pipe(Effect.provide(layer));
  });

  it.effect("caches repository detection for repeated resolves in the same cwd and kind", () => {
    const calls: VcsProcess.VcsProcessInput[] = [];
    const layer = Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
      Layer.provide(NodeServices.layer),
      Layer.provide(
        Layer.mock(VcsProjectConfig.VcsProjectConfig)({
          resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
        }),
      ),
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.sync(() => {
              calls.push(input);
              const normalizedArgs =
                input.args[0] === "-C" && input.args.length >= 2 ? input.args.slice(2) : input.args;
              const command = normalizedArgs.join(" ");
              if (command === "rev-parse --is-inside-work-tree") {
                return processOutput("true\n");
              }
              if (command === "rev-parse --show-toplevel") {
                return processOutput("/repo\n");
              }
              if (command === "rev-parse --git-common-dir") {
                return processOutput("/repo/.git\n");
              }
              return processOutput("");
            }),
        }),
      ),
    );

    return Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      const first = yield* registry.resolve({ cwd: "/repo", requestedKind: "git" });
      const second = yield* registry.resolve({ cwd: "/repo", requestedKind: "git" });

      assert.equal(first.repository.rootPath, "/repo");
      assert.equal(second.repository.rootPath, "/repo");
      assert.deepStrictEqual(
        calls.map((call) => normalizeGitArgs(call.args).join(" ")),
        [
          "rev-parse --is-inside-work-tree",
          "rev-parse --show-toplevel",
          "rev-parse --git-common-dir",
        ],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("detects a repository created after a negative lookup", () => {
    let insideWorkTreeChecks = 0;
    const layer = Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
      Layer.provide(NodeServices.layer),
      Layer.provide(
        Layer.mock(VcsProjectConfig.VcsProjectConfig)({
          resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
        }),
      ),
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.sync(() => {
              const command = normalizeGitArgs(input.args).join(" ");
              if (command === "rev-parse --is-inside-work-tree") {
                insideWorkTreeChecks += 1;
                return insideWorkTreeChecks === 1
                  ? {
                      ...processOutput(""),
                      exitCode: ChildProcessSpawner.ExitCode(128),
                      stderr: "fatal: not a git repository",
                    }
                  : processOutput("true\n");
              }
              if (command === "rev-parse --show-toplevel") {
                return processOutput("/repo\n");
              }
              if (command === "rev-parse --git-common-dir") {
                return processOutput("/repo/.git\n");
              }
              return processOutput("");
            }),
        }),
      ),
    );

    return Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;

      assert.equal(yield* registry.detect({ cwd: "/repo" }), null);
      assert.equal((yield* registry.detect({ cwd: "/repo" }))?.repository.rootPath, "/repo");
      assert.equal(insideWorkTreeChecks, 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a shared detection alive when the first caller is interrupted", () => {
    // Two host API calls (Version Control, then Diff) detect the same cwd. The
    // first caller's request is aborted while the git probe is still running;
    // the second caller must still get the detection, not an interrupt.
    return Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const probeInterrupted = yield* Deferred.make<void>();
      const layer = Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
        Layer.provide(NodeServices.layer),
        Layer.provide(
          Layer.mock(VcsProjectConfig.VcsProjectConfig)({
            resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
          }),
        ),
        Layer.provide(
          Layer.mock(VcsProcess.VcsProcess)({
            run: (input) => {
              const command = normalizeGitArgs(input.args).join(" ");
              if (command === "rev-parse --is-inside-work-tree") {
                // A real subprocess takes time to die, so its interruption
                // only completes once `release` fires.
                return Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.onInterrupt(() =>
                    Deferred.succeed(probeInterrupted, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                    ),
                  ),
                  Effect.as(processOutput("true\n")),
                );
              }
              if (command === "rev-parse --show-toplevel") {
                return Effect.succeed(processOutput("/repo\n"));
              }
              if (command === "rev-parse --git-common-dir") {
                return Effect.succeed(processOutput("/repo/.git\n"));
              }
              return Effect.succeed(processOutput(""));
            },
          }),
        ),
      );

      yield* Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        const first = yield* Effect.forkChild(registry.detect({ cwd: "/repo" }));
        yield* Deferred.await(started);
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(first));
        // Either the probe is being torn down, or the first caller left
        // without touching it; both are the moment the second caller arrives.
        yield* Effect.raceFirst(Deferred.await(probeInterrupted), Fiber.await(first));
        const second = yield* Effect.forkChild(registry.detect({ cwd: "/repo" }), {
          startImmediately: true,
        });
        yield* Deferred.succeed(release, undefined);

        const secondExit = yield* Fiber.await(second);
        yield* Fiber.join(interrupting);
        assert.isTrue(Exit.isSuccess(secondExit), String(secondExit));
        assert.equal(
          Exit.isSuccess(secondExit) ? secondExit.value?.repository.rootPath : null,
          "/repo",
        );
      }).pipe(Effect.provide(layer));
    });
  });

  it.effect("stops a detection still running when the service shuts down", () => {
    // A cancelled caller leaves the shared lookup running for later callers,
    // but the lookup must not outlive the registry: closing the service scope
    // interrupts it, and no further git command starts afterwards.
    return Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const probeInterrupted = yield* Deferred.make<void>();
      const commands: string[] = [];
      const layer = Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
        Layer.provide(NodeServices.layer),
        Layer.provide(
          Layer.mock(VcsProjectConfig.VcsProjectConfig)({
            resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
          }),
        ),
        Layer.provide(
          Layer.mock(VcsProcess.VcsProcess)({
            run: (input) => {
              const command = normalizeGitArgs(input.args).join(" ");
              commands.push(command);
              if (command === "rev-parse --is-inside-work-tree") {
                return Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.onInterrupt(() => Deferred.succeed(probeInterrupted, undefined)),
                  Effect.as(processOutput("true\n")),
                );
              }
              if (command === "rev-parse --show-toplevel") {
                return Effect.succeed(processOutput("/repo\n"));
              }
              if (command === "rev-parse --git-common-dir") {
                return Effect.succeed(processOutput("/repo/.git\n"));
              }
              return Effect.succeed(processOutput(""));
            },
          }),
        ),
      );

      const serviceScope = yield* Scope.make();
      const services = yield* Layer.buildWithScope(layer, serviceScope);
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry.pipe(Effect.provide(services));

      const caller = yield* Effect.forkChild(registry.detect({ cwd: "/repo" }));
      yield* Deferred.await(started);
      yield* Fiber.interrupt(caller);
      yield* Scope.close(serviceScope, Exit.void);

      assert.isTrue(yield* Deferred.isDone(probeInterrupted), "lookup outlived the service");
      yield* Deferred.succeed(release, undefined);
      yield* Effect.yieldNow;
      assert.deepStrictEqual(commands, ["rev-parse --is-inside-work-tree"]);
    });
  });
});
