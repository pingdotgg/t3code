import { assert, it, describe } from "@effect/vitest";
import { Effect, Layer } from "effect";
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

describe("VcsDriverRegistry", () => {
  it.effect("routes directly by VCS driver kind for non-repository workflows", () => {
    const layer = Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make()).pipe(
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
    const layer = Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make()).pipe(
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
              const command = input.args.join(" ");
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
        calls.map((call) => call.args.join(" ")),
        [
          "rev-parse --is-inside-work-tree",
          "rev-parse --show-toplevel",
          "rev-parse --git-common-dir",
        ],
      );
    }).pipe(Effect.provide(layer));
  });
});
