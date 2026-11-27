import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as OriginCli from "./OriginCli.ts";
import * as OriginSourceControlProvider from "./OriginSourceControlProvider.ts";

const onPath = (command: string) => `/usr/bin/${command}`;

const loginSignIn = {
  label: "login",
  authenticated: true,
  authMethod: "login",
  tokenValid: true,
  account: { email: "dev@example.test" },
};
// A `CURSOR_API_KEY` sign-in has no token to check.
const apiKeySignIn = { ...loginSignIn, label: "api-key", authMethod: "api-key", tokenValid: null };
const expiredToken = { ...loginSignIn, label: "expired", tokenValid: false };
const signedOut = {
  label: "signed-out",
  authenticated: false,
  authMethod: null,
  tokenValid: null,
  account: null,
};

const emptyHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response()))),
);

// Matches the real CLI: bare `--json` exits 1, requested fields default to `null`, signed-out exits 1 with JSON.
const fakeOrigin = (status: Record<string, unknown>) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const run = (args: ReadonlyArray<string>) => {
    calls.push(args);
    if (args[0] === "--version") return TestSourceControlHost.processOutput("2026.11.03");
    if (args[0] === "auth" && args[1] === "token") {
      return status.authenticated
        ? TestSourceControlHost.processOutput("tok\n")
        : TestSourceControlHost.processOutput("", {
            stderr: "Not authenticated",
            exitCode: ChildProcessSpawner.ExitCode(1),
          });
    }
    if (args[0] === "auth" && args[1] === "status") {
      const jsonIndex = args.indexOf("--json");
      const rawFields = jsonIndex >= 0 ? args[jsonIndex + 1] : undefined;
      const fields = rawFields ? rawFields.split(",").filter(Boolean) : [];
      if (fields.length === 0) {
        return TestSourceControlHost.processOutput("", {
          stderr:
            "Error: Specify one or more comma-separated fields for `--json`:\n  authenticated",
          exitCode: ChildProcessSpawner.ExitCode(1),
        });
      }
      return TestSourceControlHost.processOutput(
        JSON.stringify(Object.fromEntries(fields.map((field) => [field, status[field] ?? null]))),
        { exitCode: ChildProcessSpawner.ExitCode(status.authenticated ? 0 : 1) },
      );
    }
    return TestSourceControlHost.processOutput("", {
      stderr: `Unexpected args: ${args.join(" ")}`,
      exitCode: ChildProcessSpawner.ExitCode(1),
    });
  };
  return { calls, run };
};

it.effect("reads the sign-in from an Origin CLI that wants its --json fields named", () =>
  Effect.gen(function* () {
    const runProbeAndViewer = (status: Record<string, unknown>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const cli = fakeOrigin(status);
          const hostLayer = TestSourceControlHost.layer({
            process: { run: (input) => Effect.succeed(cli.run(input.args)) },
          });
          const discovery = yield* OriginSourceControlProvider.makeDiscovery.pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.mock(OriginCli.OriginCli)({
                  personalNamespace: () => Effect.succeed("acme"),
                }),
                hostLayer,
              ),
            ),
          );
          const item = yield* discovery.probe("/repo");
          const discoveryAuthCall = cli.calls.find(
            (args) => args[0] === "auth" && args[1] === "status",
          );
          const originCli = yield* OriginCli.make.pipe(
            Effect.provide(Layer.mergeAll(hostLayer, emptyHttpClient)),
          );
          const viewer = yield* Effect.result(originCli.viewer("/repo"));
          return { item, discoveryAuthCall, viewer };
        }),
      );

    for (const signedIn of [loginSignIn, apiKeySignIn]) {
      const { item, discoveryAuthCall, viewer } = yield* runProbeAndViewer(signedIn);
      assert.strictEqual(item.auth.status, "authenticated", signedIn.label);
      assert.deepStrictEqual(item.auth.account, Option.some("acme"), signedIn.label);
      assert.isFalse(
        discoveryAuthCall?.some((arg) => arg.includes("account")),
        `${signedIn.label}: discovery should stay local`,
      );
      assert.strictEqual(viewer._tag, "Success", signedIn.label);
      if (viewer._tag === "Success") {
        assert.strictEqual(viewer.success, "dev@example.test", signedIn.label);
      }
    }

    for (const notSignedIn of [expiredToken, signedOut]) {
      const { item, viewer } = yield* runProbeAndViewer(notSignedIn);
      assert.strictEqual(item.auth.status, "unauthenticated", notSignedIn.label);
      assert.strictEqual(viewer._tag, "Failure", notSignedIn.label);
      if (viewer._tag === "Failure") {
        assert.strictEqual(viewer.failure.reason, "unauthenticated", notSignedIn.label);
      }
    }
  }).pipe(Effect.provideService(SpawnExecutableResolution, onPath)),
);
