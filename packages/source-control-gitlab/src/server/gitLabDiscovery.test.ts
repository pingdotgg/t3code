import {
  parseGitRemoteHost,
  unknownRemoteProvider,
} from "@t3tools/source-control-core/client/definition";
import { refineUnknownRemoteProvider } from "@t3tools/source-control-core/server/discovery";
import { processOutput } from "@t3tools/source-control-testing/TestSourceControlHost";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/process";

import * as GitLabSourceControlProvider from "./GitLabSourceControlProvider.ts";

it("reads the account from glab output without status marks", () => {
  const auth = GitLabSourceControlProvider.discovery.parseAuth(
    processOutput(`gitlab.com
Logged in to gitlab.com as gitlab-user
`),
  );
  assert.strictEqual(auth.status, "authenticated");
  assert.deepStrictEqual(auth.account, Option.some("gitlab-user"));
});

it.effect.each([
  {
    name: "without relying on host naming",
    remoteUrl: "https://self-hosted.example.test/group/project.git",
    host: "self-hosted.example.test",
    stdout: `gitlab.com
  x gitlab.com: API call failed: 401 Unauthorized
  ! No token found
self-hosted.example.test
  ✓ Logged in to self-hosted.example.test as gitlab-user
  ✓ Token found: ******
`,
    exitCode: 1,
  },
  {
    name: "on a non-standard port",
    remoteUrl: "https://self-hosted.example.test:8443/group/project.git",
    host: "self-hosted.example.test:8443",
    stdout: `self-hosted.example.test:8443
  ✓ Logged in to self-hosted.example.test:8443 as gitlab-user
  ✓ Token found: ******
`,
    exitCode: 0,
  },
] as const)("claims a self-hosted remote glab is signed in to $name", (scenario) =>
  Effect.gen(function* () {
    const remote = parseGitRemoteHost(scenario.remoteUrl);
    assert.ok(remote);
    const asked: Array<ReadonlyArray<string>> = [];
    const verdict = yield* refineUnknownRemoteProvider({
      specs: [GitLabSourceControlProvider.discovery],
      cwd: "/repo",
      context: {
        provider: unknownRemoteProvider(remote),
        remoteName: "origin",
        remoteUrl: scenario.remoteUrl,
      },
      process: {
        run: ({ command, args }) => {
          asked.push([command, ...args]);
          return Effect.succeed(
            processOutput(scenario.stdout, {
              exitCode: ChildProcessSpawner.ExitCode(scenario.exitCode),
            }),
          );
        },
      },
    });
    assert.deepStrictEqual(asked, [["glab", "auth", "status", "--hostname", scenario.host]]);
    assert.strictEqual(verdict.provider?.kind, "gitlab");
    assert.strictEqual(verdict.settled, true);
  }),
);
