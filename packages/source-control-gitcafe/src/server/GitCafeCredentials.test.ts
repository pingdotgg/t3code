import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as GitCafeCredentials from "./GitCafeCredentials.ts";

const processOutput = TestSourceControlHost.processOutput;

function harness(
  run: SourceControlHost.SourceControlHost["Service"]["process"]["run"],
  env: NodeJS.ProcessEnv = {},
) {
  const calls: Array<SourceControlHost.SourceControlProcessInput> = [];
  const layer = GitCafeCredentials.layer.pipe(
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

describe("GitCafeCredentials", () => {
  it("hands CAFE_TOKEN only to the host cafe itself targets", () => {
    const token = { CAFE_TOKEN: "env-token" };
    assert.strictEqual(GitCafeCredentials.environmentToken("git.cafe", token), "env-token");
    assert.isNull(GitCafeCredentials.environmentToken("staging.git.cafe", token));
    for (const CAFE_HOST of ["https://staging.git.cafe/api", "staging.git.cafe"]) {
      const staging = { ...token, CAFE_HOST };
      assert.strictEqual(
        GitCafeCredentials.environmentToken("staging.git.cafe", staging),
        "env-token",
      );
      assert.isNull(GitCafeCredentials.environmentToken("git.cafe", staging));
    }
    assert.isNull(GitCafeCredentials.environmentToken("git.cafe", { CAFE_TOKEN: " " }));
  });

  it.effect("prefers CAFE_TOKEN without running cafe", () => {
    const { layer, calls } = harness(() => Effect.die("cafe must not run"), {
      CAFE_TOKEN: "env-token",
    });
    return Effect.gen(function* () {
      const credentials = yield* GitCafeCredentials.GitCafeCredentials;
      const credential = yield* credentials.get("git.cafe");
      assert.strictEqual(Redacted.value(credential.token), "env-token");
      assert.strictEqual(credential.source, "env");
      assert.deepStrictEqual(calls, []);
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses a token saved in Settings for git.cafe only, ahead of CAFE_TOKEN", () => {
    const calls: Array<SourceControlHost.SourceControlProcessInput> = [];
    const layer = GitCafeCredentials.layer.pipe(
      Layer.provideMerge(
        TestSourceControlHost.layer({
          process: {
            run: (input) => {
              calls.push(input);
              return Effect.succeed(processOutput("password=gct_staging\n"));
            },
          },
        }),
      ),
      Layer.provide(Layer.succeed(HostProcess.Environment, { CAFE_TOKEN: "env-token" })),
      Layer.provide(Layer.succeed(HostProcess.WorkingDirectory, "/server")),
    );
    return Effect.gen(function* () {
      const credentials = yield* GitCafeCredentials.GitCafeCredentials;
      const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
      yield* settings.update({ sourceControlHosts: { gitcafe: { token: "saved-token" } } });

      const saved = yield* credentials.get("git.cafe");
      assert.strictEqual(Redacted.value(saved.token), "saved-token");
      assert.strictEqual(saved.source, "settings");
      assert.deepStrictEqual(yield* credentials.cliEnv("git.cafe"), { CAFE_TOKEN: "saved-token" });
      assert.deepStrictEqual(yield* credentials.cliEnv("staging.git.cafe"), {});
      assert.strictEqual(
        Redacted.value((yield* credentials.get("staging.git.cafe")).token),
        "gct_staging",
      );

      yield* settings.update({ sourceControlHosts: { gitcafe: { token: "" } } });
      assert.strictEqual((yield* credentials.get("git.cafe")).source, "env");
    }).pipe(Effect.provide(layer));
  });

  it.effect("asks cafe's Git credential helper over stdin and reuses the token", () => {
    const { layer, calls } = harness(() =>
      Effect.succeed(
        processOutput("protocol=https\nhost=staging.git.cafe\nusername=alice\npassword=gct_1\n"),
      ),
    );
    return Effect.gen(function* () {
      const credentials = yield* GitCafeCredentials.GitCafeCredentials;
      const credential = yield* credentials.get("Staging.Git.Cafe");
      assert.strictEqual(Redacted.value(credential.token), "gct_1");
      assert.strictEqual(credential.source, "cafe");
      yield* credentials.get("staging.git.cafe");
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0]?.command, "cafe");
      assert.deepStrictEqual(calls[0]?.args, [
        "auth",
        "http",
        "credential",
        "--host",
        "https://staging.git.cafe/api",
        "get",
      ]);
      assert.strictEqual(calls[0]?.stdin, "protocol=https\nhost=staging.git.cafe\n\n");
      yield* credentials.invalidate("staging.git.cafe");
      yield* credentials.get("staging.git.cafe");
      assert.strictEqual(calls.length, 2);
    }).pipe(Effect.provide(layer));
  });
});
