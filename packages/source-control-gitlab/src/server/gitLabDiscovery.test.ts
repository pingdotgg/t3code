import {
  parseGitRemoteHost,
  unknownRemoteProvider,
} from "@t3tools/source-control-core/shared/definition";
import {
  probeSourceControlProvider,
  refineUnknownRemoteProvider,
} from "@t3tools/source-control-core/server/discovery";
import { VcsProcessTimeoutError } from "@t3tools/contracts";
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

// Without `--all`, glab 1.79+ checks only the current host unless that is gitlab.com.
it.effect("reports a signed-in host when glab's default host is signed out", () =>
  Effect.gen(function* () {
    const defaultHostOnly = `gitlab.gnome.org
  x gitlab.gnome.org: API call failed: GET https://gitlab.gnome.org/api/v4/user: 401 {message: 401 Unauthorized}
`;
    const allHosts = `gitlab.com
  ✓ Logged in to gitlab.com as gitlab-user (/home/user/.config/glab-cli/config.yml)
${defaultHostOnly}`;
    const item = yield* probeSourceControlProvider({
      spec: GitLabSourceControlProvider.discovery,
      cwd: "/repo",
      process: {
        run: ({ args }) =>
          Effect.succeed(
            args[0] === "--version"
              ? processOutput("glab 1.124.0\n")
              : processOutput(args.includes("--all") ? allHosts : defaultHostOnly, {
                  exitCode: ChildProcessSpawner.ExitCode(1),
                }),
          ),
      },
    });
    assert.strictEqual(item.auth.status, "authenticated");
    assert.deepStrictEqual(item.auth.account, Option.some("gitlab-user"));
    assert.deepStrictEqual(item.auth.host, Option.some("gitlab.com"));
  }),
);

const signedInListing = `gitlab.gnome.org
  x gitlab.gnome.org: API call failed: GET https://gitlab.gnome.org/api/v4/user: 401 {message: 401 Unauthorized}
gitlab.com
  ✓ Logged in to gitlab.com as gitlab-user (/home/user/.config/glab-cli/config.yml)
`;

it.effect.each([
  {
    name: "1.73 to 1.78",
    stderr: "ERROR\n\n  Unknown flag: --all.\n\nUsage\n\n  glab auth status [--flags]\n",
  },
  { name: "1.60 to 1.72", stderr: "ERROR: unknown flag: --all\n" },
  { name: "1.36 to 1.53", stderr: "unknown flag: --all\n" },
])("falls back to plain auth status when glab $name rejects --all", ({ stderr }) =>
  Effect.gen(function* () {
    const item = yield* probeSourceControlProvider({
      spec: GitLabSourceControlProvider.discovery,
      cwd: "/repo",
      process: {
        run: ({ args }) =>
          Effect.succeed(
            args[0] === "--version"
              ? processOutput("glab 1.53.0\n")
              : args.includes("--all")
                ? processOutput("", { stderr, exitCode: ChildProcessSpawner.ExitCode(1) })
                : processOutput(signedInListing, { exitCode: ChildProcessSpawner.ExitCode(1) }),
          ),
      },
    });
    assert.strictEqual(item.auth.status, "authenticated");
    assert.deepStrictEqual(item.auth.account, Option.some("gitlab-user"));
  }),
);

it.effect("falls back to plain auth status when glab times out checking every host", () =>
  Effect.gen(function* () {
    const item = yield* probeSourceControlProvider({
      spec: GitLabSourceControlProvider.discovery,
      cwd: "/repo",
      process: {
        run: ({ operation, command, cwd, args, timeoutMs }) =>
          args[0] === "--version"
            ? Effect.succeed(processOutput("glab 1.124.0\n"))
            : args.includes("--all")
              ? Effect.fail(
                  new VcsProcessTimeoutError({
                    operation,
                    command,
                    cwd,
                    timeoutMs: timeoutMs ?? 0,
                  }),
                )
              : Effect.succeed(
                  processOutput(`gitlab.example.test
  ✓ Logged in to gitlab.example.test as gitlab-user
`),
                ),
      },
    });
    assert.strictEqual(item.auth.status, "authenticated");
    assert.deepStrictEqual(item.auth.account, Option.some("gitlab-user"));
    assert.deepStrictEqual(item.auth.host, Option.some("gitlab.example.test"));
  }),
);

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
