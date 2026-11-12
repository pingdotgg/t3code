import {
  parseGitRemoteHost,
  unknownRemoteProvider,
} from "@t3tools/source-control-core/shared/definition";
import {
  probeSourceControlProvider,
  refineUnknownRemoteProvider,
} from "@t3tools/source-control-core/server/discovery";
import { processOutput } from "@t3tools/source-control-testing/TestSourceControlHost";
import { VcsProcessTimeoutError } from "@t3tools/contracts";
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

it.effect("skips --all when the current glab host is signed in", () =>
  Effect.gen(function* () {
    const asked: Array<ReadonlyArray<string>> = [];
    const item = yield* probeSourceControlProvider({
      spec: GitLabSourceControlProvider.discovery,
      cwd: "/repo",
      process: {
        run: ({ args }) => {
          asked.push(args);
          return Effect.succeed(
            args[0] === "--version"
              ? processOutput("glab 1.124.0\n")
              : processOutput(`gitlab.example.test
  ✓ Logged in to gitlab.example.test as gitlab-user
`),
          );
        },
      },
    });
    assert.strictEqual(item.auth.status, "authenticated");
    assert.isFalse(asked.some((args) => args.includes("--all")));
  }),
);

it.effect("keeps glab's own sign-out detail when glab predates --all", () =>
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
                ? processOutput("", {
                    stderr: "unknown flag: --all\n",
                    exitCode: ChildProcessSpawner.ExitCode(1),
                  })
                : processOutput("", {
                    stderr: "No GitLab instances have been authenticated with glab.\n",
                    exitCode: ChildProcessSpawner.ExitCode(1),
                  }),
          ),
      },
    });
    assert.strictEqual(item.auth.status, "unauthenticated");
    assert.deepStrictEqual(
      item.auth.detail,
      Option.some("No GitLab instances have been authenticated with glab."),
    );
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
          if (args[0] === "config") return Effect.succeed(processOutput(""));
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

// glab answers `auth status` over the network, but its config knows the login offline.
it.effect("claims a self-hosted remote glab is signed in to while the host is offline", () =>
  Effect.gen(function* () {
    const remoteUrl = "https://git.example.test/group/project.git";
    const remote = parseGitRemoteHost(remoteUrl);
    assert.ok(remote);
    const verdict = yield* refineUnknownRemoteProvider({
      specs: [GitLabSourceControlProvider.discovery],
      cwd: "/repo",
      context: { provider: unknownRemoteProvider(remote), remoteName: "origin", remoteUrl },
      process: {
        run: ({ operation, command, args, cwd }) => {
          if (args[0] === "config" && args[1] === "get") {
            const host = args[args.indexOf("--host") + 1];
            const value =
              host === "git.example.test" ? (args[2] === "user" ? "gitlab-user" : host) : "";
            return Effect.succeed(processOutput(value === "" ? "" : `${value}\n`));
          }
          return Effect.fail(
            new VcsProcessTimeoutError({ operation, command, cwd, timeoutMs: 5_000 }),
          );
        },
      },
    });
    assert.strictEqual(verdict.provider?.kind, "gitlab");
    assert.strictEqual(verdict.settled, true);
  }),
);

it.effect.each([
  {
    name: "claims a host whose token login glab cannot check offline",
    hostUser: "",
    globalUser: "",
    auth: "timeout",
    kind: "gitlab",
  },
  {
    name: "ignores the global user glab reports for a host it has no login for",
    hostUser: "global-user",
    globalUser: "global-user",
    auth: "x git.example.test has not been authenticated with glab.",
    kind: undefined,
  },
] as const)("$name", (scenario) =>
  Effect.gen(function* () {
    const remoteUrl = "https://git.example.test/group/project.git";
    const remote = parseGitRemoteHost(remoteUrl);
    assert.ok(remote);
    const verdict = yield* refineUnknownRemoteProvider({
      specs: [GitLabSourceControlProvider.discovery],
      cwd: "/repo",
      context: { provider: unknownRemoteProvider(remote), remoteName: "origin", remoteUrl },
      process: {
        run: ({ operation, command, args, cwd }) => {
          if (args[0] === "config") {
            const user = args.includes("--global") ? scenario.globalUser : scenario.hostUser;
            return Effect.succeed(processOutput(user === "" ? "" : `${user}\n`));
          }
          return scenario.auth === "timeout"
            ? Effect.fail(new VcsProcessTimeoutError({ operation, command, cwd, timeoutMs: 5_000 }))
            : Effect.succeed(
                processOutput(scenario.auth, { exitCode: ChildProcessSpawner.ExitCode(1) }),
              );
        },
      },
    });
    assert.strictEqual<string | undefined>(verdict.provider?.kind, scenario.kind);
    assert.strictEqual(verdict.settled, true);
  }),
);
