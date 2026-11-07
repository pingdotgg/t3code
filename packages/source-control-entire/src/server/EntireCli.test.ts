import { assert, describe, it } from "@effect/vitest";
import { VcsProcessSpawnError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import { ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as EntireCli from "./EntireCli.ts";

const processOutput = TestSourceControlHost.processOutput;
const failed = (stderr: string) =>
  processOutput("", { stderr, exitCode: ChildProcessSpawner.ExitCode(1) });

function harness(run: SourceControlHost.SourceControlHost["Service"]["process"]["run"]) {
  const calls: Array<SourceControlHost.SourceControlProcessInput> = [];
  const layer = EntireCli.layer.pipe(
    Layer.provide(
      TestSourceControlHost.layer({
        process: {
          run: (input) => {
            calls.push(input);
            return run(input);
          },
        },
      }),
    ),
    Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/server")),
  );
  return { layer, calls };
}

const view = {
  repo: "/gh/acme/web",
  repoId: "01J0REPO",
  owningProjectId: "01J0PROJECT",
  apiUrl: "https://aws-us-east-2.api.entire.io",
  placements: [
    { cluster: "aws-eu-west-1.entire.io", status: "processing" },
    { cluster: "aws-us-east-2.entire.io", status: "ready" },
  ],
};

describe("EntireCli", () => {
  it.effect("asks `repo view` for a repository's cell once, from the server's directory", () => {
    const { layer, calls } = harness(() => Effect.succeed(processOutput(JSON.stringify(view))));
    return Effect.gen(function* () {
      const cli = yield* EntireCli.EntireCli;
      const reference = "entire://aws-us-east-2.entire.io/gh/acme/web";
      const coordinates = yield* cli.repository(reference);
      yield* cli.repository(reference);
      assert.deepStrictEqual(coordinates, {
        repoId: "01J0REPO",
        projectId: "01J0PROJECT",
        apiUrl: "https://aws-us-east-2.api.entire.io",
        cluster: "aws-us-east-2.entire.io",
      });
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0]?.args, ["repo", "view", reference, "--json"]);
      assert.strictEqual(calls[0]?.command, "entire");
      assert.strictEqual(calls[0]?.cwd, "/server");
      assert.strictEqual(calls[0]?.env?.ENTIRE_TELEMETRY_OPTOUT, "1");
      assert.isDefined(calls[0]?.timeoutMs);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails, rather than guessing a cell, when `repo view` omits the coordinates", () => {
    const { layer, calls } = harness(() =>
      Effect.succeed(processOutput(JSON.stringify({ repo: "/gh/acme/web", status: "ready" }))),
    );
    return Effect.gen(function* () {
      const cli = yield* EntireCli.EntireCli;
      const error = yield* cli.repository("/gh/acme/web").pipe(Effect.flip);
      assert.strictEqual(error._tag, "EntireCliFailedError");
      // A failure is not remembered, so the next read asks again.
      yield* cli.repository("/gh/acme/web").pipe(Effect.flip);
      assert.strictEqual(calls.length, 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports the CLI's own reason when `repo view` refuses, without its colours", () => {
    const { layer } = harness(() =>
      Effect.succeed(failed("\n\u001b[31mError: no repo matching /gh/a/b\u001b[0m\n")),
    );
    return Effect.gen(function* () {
      const cli = yield* EntireCli.EntireCli;
      const error = yield* cli.repository("/gh/a/b").pipe(Effect.flip);
      assert.include(error.message, ": Error: no repo matching /gh/a/b");
      assert.notInclude(error.message, "\u001b");
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps the bearer redacted, reuses it, and reads again once invalidated", () => {
    const { layer, calls } = harness(() => Effect.succeed(processOutput("ent_token\n")));
    return Effect.gen(function* () {
      const cli = yield* EntireCli.EntireCli;
      const token = yield* cli.token;
      assert.strictEqual(Redacted.value(token), "ent_token");
      assert.notInclude(String(token), "ent_token");
      yield* cli.token;
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0]?.args, ["auth", "token"]);
      yield* cli.invalidateToken;
      yield* cli.token;
      assert.strictEqual(calls.length, 2);
    }).pipe(Effect.provide(layer));
  });

  const notFound = (module: string) =>
    harness((input) =>
      Effect.fail(
        new VcsProcessSpawnError({
          operation: input.operation,
          command: input.command,
          cwd: input.cwd,
          cause: PlatformError.systemError({ _tag: "NotFound", module, method: "spawn" }),
        }),
      ),
    );
  it.effect.each([
    [
      "signed out",
      harness(() => Effect.succeed(failed("Not logged in."))),
      "EntireNotSignedInError",
    ],
    ["not installed", notFound("ChildProcess"), "EntireCliMissingError"],
    // The spawner checks the working directory first; a missing one is not a missing CLI.
    ["run from a missing directory", notFound("FileSystem"), "EntireCliFailedError"],
  ] as const)("tells a CLI that is %s apart", ([, { layer }, tag]) =>
    EntireCli.EntireCli.pipe(
      Effect.flatMap((cli) => cli.token),
      Effect.flip,
      Effect.map((error) => assert.strictEqual(error._tag, tag)),
      Effect.provide(layer),
    ),
  );

  it.effect("reads the viewer's bare login from `auth status`", () => {
    const { layer, calls } = harness(() =>
      Effect.succeed(
        processOutput(JSON.stringify({ logged_in: true, user: "github:Alice", server: "x" })),
      ),
    );
    return Effect.gen(function* () {
      const cli = yield* EntireCli.EntireCli;
      assert.strictEqual(yield* cli.viewer, "Alice");
      assert.deepStrictEqual(calls[0]?.args, ["auth", "status", "--json"]);
    }).pipe(Effect.provide(layer));
  });
});
