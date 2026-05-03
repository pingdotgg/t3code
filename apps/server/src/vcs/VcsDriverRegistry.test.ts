import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe } from "vitest";

import { VcsProcess, type VcsProcessInput, type VcsProcessOutput } from "./VcsProcess.ts";
import { VcsProjectConfig } from "./VcsProjectConfig.ts";
import { VcsDriverRegistry, make as makeVcsDriverRegistry } from "./VcsDriverRegistry.ts";

const commandCalls = (calls: ReadonlyArray<VcsProcessInput>) =>
  calls.map((call) => [call.command].concat(call.args));

const processOutput = (stdout: string, exitCode = 0, stderr = ""): VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(exitCode),
  stdout,
  stderr,
  stdoutTruncated: false,
  stderrTruncated: false,
});

describe("VcsDriverRegistry", () => {
  it.effect("routes directly by VCS driver kind for non-repository workflows", () => {
    const layer = Layer.effect(VcsDriverRegistry, makeVcsDriverRegistry()).pipe(
      Layer.provide(
        Layer.mock(VcsProjectConfig)({
          resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
        }),
      ),
      Layer.provide(
        Layer.mock(VcsProcess)({
          run: () => Effect.succeed(processOutput("")),
        }),
      ),
      Layer.provide(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry;
      const driver = yield* registry.get("git");

      assert.strictEqual(driver.capabilities.kind, "git");
    }).pipe(Effect.provide(layer));
  });

  it.effect("caches repository detection for repeated resolves in the same cwd and kind", () => {
    const calls: VcsProcessInput[] = [];
    const layer = Layer.effect(VcsDriverRegistry, makeVcsDriverRegistry()).pipe(
      Layer.provide(
        Layer.mock(VcsProjectConfig)({
          resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
        }),
      ),
      Layer.provide(
        Layer.mock(VcsProcess)({
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
      Layer.provide(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry;
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

  it.effect("resolves an explicitly requested jj repository", () => {
    const calls: VcsProcessInput[] = [];
    const layer = Layer.effect(VcsDriverRegistry, makeVcsDriverRegistry()).pipe(
      Layer.provide(
        Layer.mock(VcsProjectConfig)({
          resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
        }),
      ),
      Layer.provide(
        Layer.mock(VcsProcess)({
          run: (input) =>
            Effect.sync(() => {
              calls.push(input);
              const command = input.args.join(" ");
              if (input.command === "jj" && command === "--no-pager root") {
                return processOutput("/repo\n");
              }
              return processOutput("", 1, "not found");
            }),
        }),
      ),
      Layer.provide(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry;
      const handle = yield* registry.resolve({ cwd: "/repo", requestedKind: "jj" });

      assert.equal(handle.kind, "jj");
      assert.equal(handle.repository.rootPath, "/repo");
      assert.deepStrictEqual(commandCalls(calls), [["jj", "--no-pager", "root"]]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("prefers jj auto-detection before git for colocated repositories", () => {
    const calls: VcsProcessInput[] = [];
    const layer = Layer.effect(VcsDriverRegistry, makeVcsDriverRegistry()).pipe(
      Layer.provide(
        Layer.mock(VcsProjectConfig)({
          resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
        }),
      ),
      Layer.provide(
        Layer.mock(VcsProcess)({
          run: (input) =>
            Effect.sync(() => {
              calls.push(input);
              const command = input.args.join(" ");
              if (input.command === "jj" && command === "--no-pager root") {
                return processOutput("/repo\n");
              }
              if (input.command === "git") {
                return processOutput("true\n");
              }
              return processOutput("", 1, "not found");
            }),
        }),
      ),
      Layer.provide(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry;
      const handle = yield* registry.resolve({ cwd: "/repo" });

      assert.equal(handle.kind, "jj");
      assert.equal(handle.repository.rootPath, "/repo");
      assert.deepStrictEqual(commandCalls(calls), [["jj", "--no-pager", "root"]]);
    }).pipe(Effect.provide(layer));
  });
});
