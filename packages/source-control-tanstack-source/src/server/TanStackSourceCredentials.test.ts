import { assert, describe, it } from "@effect/vitest";
import { VcsProcessExitError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as TanStackSourceCredentials from "./TanStackSourceCredentials.ts";

const processOutput = TestSourceControlHost.processOutput;
const HOST = "source.tanstack.com";

function harness(
  run: SourceControlHost.SourceControlHost["Service"]["process"]["run"],
  env: NodeJS.ProcessEnv = {},
) {
  const calls: Array<SourceControlHost.SourceControlProcessInput> = [];
  const layer = TanStackSourceCredentials.layer.pipe(
    Layer.provideMerge(
      TestSourceControlHost.layer({
        process: {
          run: (input) => {
            calls.push(input);
            return run(input);
          },
        },
      }),
    ),
    Layer.provide(Layer.succeed(HostProcess.Environment, env)),
    Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/server")),
  );
  return { layer, calls };
}

const notSignedIn = (input: SourceControlHost.SourceControlProcessInput) =>
  Effect.fail(
    new VcsProcessExitError({
      operation: input.operation,
      command: input.command,
      cwd: input.cwd,
      exitCode: 1,
      detail: "no oauth token found",
    }),
  );

describe("TanStackSourceCredentials", () => {
  it("hands SRC_TOKEN only to the host src itself sends it to", () => {
    const token = { SRC_TOKEN: "tsp_env" };
    assert.strictEqual(TanStackSourceCredentials.environmentToken(HOST, token), "tsp_env");
    assert.isNull(TanStackSourceCredentials.environmentToken("github.com", token));
    assert.isNull(
      TanStackSourceCredentials.environmentToken(HOST, { ...token, SRC_HOST: "localhost:5173" }),
    );
    assert.isNull(TanStackSourceCredentials.environmentToken(HOST, { SRC_TOKEN: " " }));
  });

  it.effect("puts a saved token before SRC_TOKEN, and SRC_TOKEN before the src login", () => {
    const { layer, calls } = harness(() => Effect.succeed(processOutput("tsp_cli\n")), {
      SRC_TOKEN: "tsp_env",
    });
    return Effect.gen(function* () {
      const credentials = yield* TanStackSourceCredentials.TanStackSourceCredentials;
      const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
      yield* settings.update({
        sourceControlHosts: { "tanstack-source": { tokens: { [HOST]: "tsp_saved" } } },
      });
      const saved = yield* credentials.get(HOST);
      assert.strictEqual(Redacted.value(saved.token), "tsp_saved");
      assert.strictEqual(saved.source, "settings");

      yield* settings.update({ sourceControlHosts: { "tanstack-source": { tokens: {} } } });
      const fromEnv = yield* credentials.get(HOST);
      assert.strictEqual(Redacted.value(fromEnv.token), "tsp_env");
      assert.strictEqual(fromEnv.source, "env");
      assert.deepStrictEqual(calls, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("asks src for the account picked in Settings, then its active login", () => {
    const { layer, calls } = harness((input) =>
      input.args.includes("--user")
        ? notSignedIn(input)
        : Effect.succeed(processOutput("tsp_active\n")),
    );
    return Effect.gen(function* () {
      const credentials = yield* TanStackSourceCredentials.TanStackSourceCredentials;
      const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
      yield* settings.update({
        sourceControlHosts: { "tanstack-source": { hosts: { [HOST]: { account: "gone" } } } },
      });
      const credential = yield* credentials.get("Source.TanStack.com");
      assert.strictEqual(Redacted.value(credential.token), "tsp_active");
      assert.strictEqual(credential.source, "src");
      assert.deepStrictEqual(
        calls.map((call) => [call.command, ...call.args]),
        [
          ["src", "auth", "token", "--hostname", HOST, "--user", "gone"],
          ["src", "auth", "token", "--hostname", HOST],
        ],
      );
      // An inherited SRC_TOKEN must not answer for the login asked for.
      assert.strictEqual(calls[0]?.env?.SRC_TOKEN, "");
      yield* credentials.get(HOST);
      assert.strictEqual(calls.length, 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a host turned off in Settings and any host that is not Source's", () => {
    const { layer, calls } = harness(() => Effect.succeed(processOutput("tsp_cli\n")), {
      SRC_TOKEN: "tsp_env",
    });
    return Effect.gen(function* () {
      const credentials = yield* TanStackSourceCredentials.TanStackSourceCredentials;
      const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
      const foreign = yield* Effect.flip(credentials.get("source.tanstack.com.evil.test"));
      assert.strictEqual(foreign._tag, "TanStackSourceNotSignedInError");
      yield* settings.update({
        sourceControlHosts: {
          "tanstack-source": {
            hosts: { [HOST]: { enabled: false } },
            tokens: { [HOST]: "tsp_saved" },
          },
        },
      });
      const disabled = yield* Effect.flip(credentials.get(HOST));
      assert.strictEqual(disabled._tag, "TanStackSourceHostDisabledError");
      assert.deepStrictEqual(calls, []);
    }).pipe(Effect.provide(layer));
  });
});
