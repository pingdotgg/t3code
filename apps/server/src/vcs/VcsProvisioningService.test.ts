import { assert, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Option } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { VcsDriverShape } from "./VcsDriver.ts";
import { VcsDriverRegistry } from "./VcsDriverRegistry.ts";
import { VcsProvisioningService, layer } from "./VcsProvisioningService.ts";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

function makeDriver(calls: string[]): VcsDriverShape {
  return {
    capabilities: {
      kind: "git",
      supportsWorktrees: true,
      supportsBookmarks: false,
      supportsAtomicSnapshot: false,
      supportsPushDefaultRemote: true,
      ignoreClassifier: "native",
    },
    execute: () =>
      Effect.succeed({
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    detectRepository: () => Effect.succeed(null),
    isInsideWorkTree: () => Effect.succeed(false),
    listWorkspaceFiles: () =>
      Effect.succeed({
        paths: [],
        truncated: false,
        freshness: {
          source: "live-local",
          observedAt: TEST_EPOCH,
          expiresAt: Option.none(),
        },
      }),
    listRemotes: () =>
      Effect.succeed({
        remotes: [],
        freshness: {
          source: "live-local",
          observedAt: TEST_EPOCH,
          expiresAt: Option.none(),
        },
      }),
    filterIgnoredPaths: (_cwd, relativePaths) => Effect.succeed(relativePaths),
    initRepository: (input) =>
      Effect.sync(() => {
        calls.push(`${input.kind ?? "default"}:${input.cwd}`);
      }),
  };
}

it.effect("routes repository initialization through an explicit VCS driver kind", () => {
  const calls: string[] = [];
  const driver = makeDriver(calls);
  const testLayer = layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry)({
        get: (kind) => (kind === "git" ? Effect.succeed(driver) : Effect.die("unexpected kind")),
      }),
    ),
  );

  return Effect.gen(function* () {
    const provisioning = yield* VcsProvisioningService;
    yield* provisioning.initRepository({ cwd: "/repo", kind: "git" });

    assert.deepStrictEqual(calls, ["git:/repo"]);
  }).pipe(Effect.provide(testLayer));
});

it.effect("defaults repository initialization to Git until callers choose a VCS kind", () => {
  const calls: string[] = [];
  const driver = makeDriver(calls);
  const testLayer = layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry)({
        get: (kind) => (kind === "git" ? Effect.succeed(driver) : Effect.die("unexpected kind")),
      }),
    ),
  );

  return Effect.gen(function* () {
    const provisioning = yield* VcsProvisioningService;
    yield* provisioning.initRepository({ cwd: "/repo" });

    assert.deepStrictEqual(calls, ["default:/repo"]);
  }).pipe(Effect.provide(testLayer));
});
