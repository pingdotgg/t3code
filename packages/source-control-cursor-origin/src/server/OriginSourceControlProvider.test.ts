import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as OriginCli from "./OriginCli.ts";
import * as OriginSourceControlProvider from "./OriginSourceControlProvider.ts";

const oauthSignIn: Record<string, unknown> = {
  authenticated: true,
  authMethod: "oauth",
  tokenValid: true,
  account: { email: "dev@example.test" },
};
// A `CURSOR_API_KEY` sign-in has no token to check.
const apiKeySignIn = { ...oauthSignIn, authMethod: "api-key", tokenValid: null };

// As the real CLI does, this exits 1 on a bare `--json` and prints only the fields it is asked for.
const origin = (signedIn: Record<string, unknown>) => (args: ReadonlyArray<string>) => {
  if (args[0] === "--version") return TestSourceControlHost.processOutput("2026.11.03");
  const fields = args[args.indexOf("--json") + 1]?.split(",") ?? [];
  return fields.length === 0
    ? TestSourceControlHost.processOutput("", {
        stderr: "Error: Specify one or more comma-separated fields for `--json`:\n  authenticated",
        exitCode: ChildProcessSpawner.ExitCode(1),
      })
    : TestSourceControlHost.processOutput(
        JSON.stringify(Object.fromEntries(fields.map((field) => [field, signedIn[field]]))),
      );
};

it.effect("reads the sign-in from an Origin CLI that wants its --json fields named", () =>
  Effect.gen(function* () {
    for (const signedIn of [oauthSignIn, apiKeySignIn]) {
      const cli = origin(signedIn);
      const discovery = yield* OriginSourceControlProvider.makeDiscovery.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(OriginCli.OriginCli)({ personalNamespace: () => Effect.succeed("acme") }),
            TestSourceControlHost.layer({
              process: { run: (input) => Effect.succeed(cli(input.args)) },
            }),
          ),
        ),
      );
      const item = yield* discovery.probe("/repo");
      assert.strictEqual(item.auth.status, "authenticated", `${signedIn.authMethod}`);
      assert.deepStrictEqual(item.auth.account, Option.some("acme"));
      // Discovery shows the namespace instead, so only the viewer lookup needs the email.
      assert.strictEqual(
        OriginCli.originAccount(
          OriginCli.parseOriginAuthStatus(cli(OriginCli.ORIGIN_AUTH_STATUS_ARGS).stdout),
        ),
        "dev@example.test",
      );
    }
  }),
);
