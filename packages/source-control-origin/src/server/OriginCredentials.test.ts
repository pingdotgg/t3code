import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as OriginCredentials from "./OriginCredentials.ts";

const processOutput = TestSourceControlHost.processOutput;

function harness(
  run: SourceControlHost.SourceControlHost["Service"]["process"]["run"],
  env: NodeJS.ProcessEnv = {},
) {
  const calls: Array<SourceControlHost.SourceControlProcessInput> = [];
  const layer = OriginCredentials.layer.pipe(
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
    Layer.provide(Layer.succeed(HostProcess.Environment, env)),
    Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/server")),
  );
  return { layer, calls };
}

describe("OriginCredentials", () => {
  it.effect("uses CURSOR_AUTH_TOKEN directly without running origin", () => {
    const { layer, calls } = harness(() => Effect.die("origin must not run"), {
      CURSOR_AUTH_TOKEN: "bearer-token",
    });
    return Effect.gen(function* () {
      const credentials = yield* OriginCredentials.OriginCredentials;
      const credential = yield* credentials.get();
      assert.strictEqual(Redacted.value(credential.token), "bearer-token");
      assert.strictEqual(credential.source, "env");
      assert.deepStrictEqual(calls, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("mints a settings API key through origin auth token", () => {
    const calls: Array<SourceControlHost.SourceControlProcessInput> = [];
    const layer = OriginCredentials.layer.pipe(
      Layer.provideMerge(
        TestSourceControlHost.layer({
          process: {
            run: (input) => {
              calls.push(input);
              return Effect.succeed(processOutput("minted-jwt\n"));
            },
          },
        }),
      ),
      Layer.provide(Layer.succeed(HostProcess.Environment, { CURSOR_AUTH_TOKEN: "env-bearer" })),
      Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/server")),
    );
    return Effect.gen(function* () {
      const credentials = yield* OriginCredentials.OriginCredentials;
      const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
      yield* settings.update({ sourceControlHosts: { origin: { token: "api-key" } } });
      const credential = yield* credentials.get();
      assert.strictEqual(Redacted.value(credential.token), "minted-jwt");
      assert.strictEqual(credential.source, "settings");
      assert.strictEqual(calls[0]?.command, "origin");
      assert.deepStrictEqual(calls[0]?.args, ["auth", "token"]);
      assert.strictEqual(calls[0]?.env?.CURSOR_API_KEY, "api-key");
      assert.deepStrictEqual(yield* credentials.cliEnv(), { CURSOR_API_KEY: "api-key" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("mints CURSOR_API_KEY through origin when no auth token is set", () => {
    const { layer, calls } = harness(() => Effect.succeed(processOutput("from-api-key\n")), {
      CURSOR_API_KEY: "env-api-key",
    });
    return Effect.gen(function* () {
      const credentials = yield* OriginCredentials.OriginCredentials;
      const credential = yield* credentials.get();
      assert.strictEqual(Redacted.value(credential.token), "from-api-key");
      assert.strictEqual(credential.source, "env");
      assert.strictEqual(calls[0]?.env?.CURSOR_API_KEY, "env-api-key");
    }).pipe(Effect.provide(layer));
  });
});
