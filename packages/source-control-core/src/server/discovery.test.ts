import { SourceControlProviderKind } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/process";

import {
  providerAuth,
  refineUnknownRemoteProvider,
  type SourceControlCliDiscoverySpec,
} from "./discovery.ts";
import type * as SourceControlHost from "./SourceControlHost.ts";

const unknownContext = {
  provider: {
    kind: SourceControlProviderKind.make("unknown"),
    name: "example.test",
    baseUrl: "https://example.test",
  },
  remoteName: "origin",
  remoteUrl: "https://example.test/team/project.git",
} as const;

const processOutput = (stdout: string): SourceControlHost.SourceControlProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

function makeSpec(
  refinementArgs: SourceControlCliDiscoverySpec["remoteRefinementArgs"],
  refineUnknownRemote: NonNullable<SourceControlCliDiscoverySpec["refineUnknownRemote"]>,
): SourceControlCliDiscoverySpec {
  return {
    type: "cli",
    kind: SourceControlProviderKind.make("test-provider"),
    label: "Test provider",
    installHint: "Install the test provider.",
    executable: "test-cli",
    versionArgs: ["--version"],
    authArgs: ["auth", "status"],
    ...(refinementArgs === undefined ? {} : { remoteRefinementArgs: refinementArgs }),
    parseAuth: () => providerAuth({ status: "unknown" }),
    refineUnknownRemote,
  };
}

it.effect("passes unknown remote context to dynamic refinement arguments", () =>
  Effect.gen(function* () {
    const calls: Array<ReadonlyArray<string>> = [];
    const spec = makeSpec(
      ({ context }) => ["config", "get", "user", "--host", context.provider.name],
      () => ({
        kind: SourceControlProviderKind.make("test-provider"),
        name: "Test provider",
        baseUrl: "https://example.test",
      }),
    );
    const process: SourceControlHost.SourceControlHost["Service"]["process"] = {
      run: (input) => {
        calls.push(input.args);
        return Effect.succeed(processOutput("configured-user\n"));
      },
    };

    const result = yield* refineUnknownRemoteProvider({
      specs: [spec],
      process,
      cwd: "/repo",
      context: unknownContext,
    });

    assert.deepStrictEqual(calls, [["config", "get", "user", "--host", "example.test"]]);
    assert.strictEqual(result?.provider.kind, "test-provider");
  }),
);

it.effect.each([
  {
    label: "static refinement arguments",
    refinementArgs: ["login", "list", "--output", "json"],
    expectedArgs: ["login", "list", "--output", "json"],
  },
  {
    label: "auth arguments as the fallback",
    refinementArgs: undefined,
    expectedArgs: ["auth", "status"],
  },
])("keeps $label", ({ refinementArgs, expectedArgs }) =>
  Effect.gen(function* () {
    const calls: Array<ReadonlyArray<string>> = [];
    const spec = makeSpec(refinementArgs, ({ auth }) =>
      auth.stdout === "configured-user\n"
        ? {
            kind: SourceControlProviderKind.make("test-provider"),
            name: "Test provider",
            baseUrl: "https://example.test",
          }
        : null,
    );
    const process: SourceControlHost.SourceControlHost["Service"]["process"] = {
      run: (input) => {
        calls.push(input.args);
        return Effect.succeed(processOutput("configured-user\n"));
      },
    };

    const result = yield* refineUnknownRemoteProvider({
      specs: [spec],
      process,
      cwd: "/repo",
      context: unknownContext,
    });

    assert.deepStrictEqual(calls, [expectedArgs]);
    assert.strictEqual(result?.provider.kind, "test-provider");
  }),
);
