import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as SshRemoteHost from "./sshRemoteHost.ts";

const HOST_NAMES: Readonly<Record<string, string>> = {
  "gh-work": "github.com",
  "GitLab-Work": "gitlab.example.com",
  "github.work": "ssh.github.com",
  "code.example.com": "ssh.code.example.com",
  lan: "10.0.0.5",
  // A `Match user` block applies to the remote's user only.
  "deploy@forge": "github.com",
  named: "constructor",
};

it.effect("replaces an SSH alias with the host ssh config sends it to", () =>
  Effect.gen(function* () {
    const asked: Array<string> = [];
    const canonicalRemoteUrl = yield* SshRemoteHost.make({
      isPublicHost: (hostName) => hostName === "github.com",
      run: ({ args }) => {
        const target = args[1]!;
        const host = target.slice(target.lastIndexOf("@") + 1);
        asked.push(target);
        return Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: `host ${host}\nuser git\nhostname ${HOST_NAMES[target] ?? HOST_NAMES[host] ?? host}\nport 2222\n`,
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      },
    });
    for (const [written, canonical] of [
      ["git@gh-work:owner/repo.git", "git@github.com:owner/repo.git"],
      ["gh-work:owner/repo.git", "github.com:owner/repo.git"],
      [
        "ssh://git@GitLab-Work:2222/group/project.git",
        "ssh://git@gitlab.example.com:2222/group/project.git",
      ],
      ["git@github.work:owner/repo.git", "git@github.com:owner/repo.git"],
      // A dotted host may be the web host itself, with its SSH endpoint elsewhere.
      ["git@code.example.com:owner/repo.git", "git@code.example.com:owner/repo.git"],
      ["git@lan:owner/repo.git", "git@lan:owner/repo.git"],
      ["git@unconfigured:owner/repo.git", "git@unconfigured:owner/repo.git"],
      ["https://gh-work/owner/repo.git", "https://gh-work/owner/repo.git"],
      ["git@-oProxyCommand=x:owner/repo.git", "git@-oProxyCommand=x:owner/repo.git"],
      ["-oProxyCommand=x@gh-work:owner/repo.git", "-oProxyCommand=x@gh-work:owner/repo.git"],
      ["deploy@forge:owner/repo.git", "deploy@github.com:owner/repo.git"],
      ["git@forge:owner/repo.git", "git@forge:owner/repo.git"],
      ["git@named:owner/repo.git", "git@constructor:owner/repo.git"],
    ] as const) {
      assert.strictEqual(yield* canonicalRemoteUrl(written), canonical, written);
    }
    // One read per host, and none for a remote that is not SSH or not a host name.
    assert.deepStrictEqual(asked, [
      "git@gh-work",
      "gh-work",
      "git@GitLab-Work",
      "git@github.work",
      "git@code.example.com",
      "git@lan",
      "git@unconfigured",
      "deploy@forge",
      "git@forge",
      "git@named",
    ]);
  }),
);
