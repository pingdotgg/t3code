import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitHubCredentials from "./GitHubCredentials.ts";

const TOKEN_VARIABLES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;

const hostSettings = (
  hosts: Record<string, { readonly account?: string; readonly enabled?: boolean }>,
) =>
  Object.fromEntries(
    Object.entries(hosts).map(([host, choice]) => [host, { enabled: true, ...choice }]),
  );

function harness(
  hosts: Record<string, { readonly account?: string; readonly enabled?: boolean }> = {},
  signedOut: ReadonlyArray<string> = [],
  tokens: Record<string, string> = {},
  repoAccounts:
    | Record<string, string>
    | ((cwd: string, key: string) => Effect.Effect<string | null>) = {},
  defaultTokens: Record<string, string> = {},
) {
  const calls: Array<ReadonlyArray<string>> = [];
  const directories: Array<string> = [];
  const configReads: Array<readonly [string, string]> = [];
  const run: SourceControlHost.SourceControlHost["Service"]["process"]["run"] = (input) =>
    Effect.sync(() => {
      calls.push(input.args);
      directories.push(input.cwd);
      const user = input.args[input.args.indexOf("--user") + 1];
      if (input.args.includes("--user") && user !== undefined && signedOut.includes(user)) {
        return {
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }
      return {
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout: input.args.includes("--user")
          ? `token-for-${user}\n`
          : `${defaultTokens[input.cwd] ?? "active-token"}\n`,
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    });
  const layer = GitHubCredentials.layer.pipe(
    Layer.provideMerge(
      TestSourceControlHost.layer({
        settings: applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
          sourceControlHosts: { github: { hosts: hostSettings(hosts), tokens } },
        }),
        process: { run },
        git: {
          readConfigValue: (cwd, key) =>
            Effect.sync(() => {
              configReads.push([cwd, key]);
            }).pipe(
              Effect.andThen(
                typeof repoAccounts === "function"
                  ? repoAccounts(cwd, key)
                  : Effect.succeed(repoAccounts[cwd] ?? null),
              ),
            ),
        },
      }),
    ),
    Layer.provide(NodeCrypto.layer),
  );
  return { layer, calls, directories, configReads };
}

describe("GitHubCredentials", () => {
  beforeEach(() => {
    for (const name of TOKEN_VARIABLES) vi.stubEnv(name, "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.effect("uses the repository's account without sharing the default token", () => {
    const { layer, calls, directories, configReads } = harness(
      {},
      [],
      {},
      {
        "/work": "work",
        "/work-tree": "work",
      },
    );
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      expect(Redacted.value((yield* credentials.get("github.com", "/personal")).token)).toBe(
        "active-token",
      );
      expect(Redacted.value((yield* credentials.get(" GITHUB.COM ", "/work")).token)).toBe(
        "token-for-work",
      );
      expect(Redacted.value((yield* credentials.get("github.com", "/work-tree")).token)).toBe(
        "token-for-work",
      );
      expect(Redacted.value((yield* credentials.get("github.com", "/personal")).token)).toBe(
        "active-token",
      );
      expect(calls).toEqual([
        ["auth", "token", "--hostname", "github.com"],
        ["auth", "token", "--hostname", "github.com", "--user", "work"],
      ]);
      expect(directories).toEqual(["/personal", "/work"]);
      expect(configReads).toContainEqual(["/work-tree", "credential.https://github.com.username"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("honors includeIf gitdir in a main checkout and its linked worktree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "t3-gh-account-" });
      const directory = yield* fs.realPath(temporary);
      const main = path.join(directory, "main");
      const worktree = path.join(directory, "linked");
      const globalConfig = path.join(directory, "gitconfig");
      const accountConfig = path.join(directory, "account");
      const git = (cwd: string, ...args: Array<string>) =>
        spawner
          .string(
            ChildProcess.make("git", args, {
              cwd,
              env: { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" },
              extendEnv: true,
            }),
          )
          .pipe(Effect.orDie);
      yield* fs.writeFileString(globalConfig, "");
      yield* git(directory, "init", "-q", main);
      yield* git(
        main,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-qm",
        "initial",
      );
      yield* git(main, "worktree", "add", "-qb", "linked", worktree);
      yield* fs.writeFileString(
        accountConfig,
        '[credential "https://github.com"]\nusername = work\n',
      );
      yield* fs.writeFileString(
        globalConfig,
        `[includeIf "gitdir:${main}/"]\npath = ${accountConfig}\n`,
      );
      const { layer, calls, directories } = harness({}, [], {}, (cwd, key) =>
        git(cwd, "config", "--get", key).pipe(Effect.map((value) => value.trim())),
      );
      yield* Effect.gen(function* () {
        const credentials = yield* GitHubCredentials.GitHubCredentials;
        for (const cwd of [main, worktree]) {
          expect(Redacted.value((yield* credentials.get("github.com", cwd)).token)).toBe(
            "token-for-work",
          );
        }
        expect(calls).toEqual([["auth", "token", "--hostname", "github.com", "--user", "work"]]);
        expect(directories).toEqual([main]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "keeps directory-selected wrapper accounts separate without a configured username",
    () => {
      const { layer, calls, directories } = harness(
        {},
        [],
        {},
        {},
        { "/work": "wrapper-work", "/personal": "wrapper-personal" },
      );
      return Effect.gen(function* () {
        const credentials = yield* GitHubCredentials.GitHubCredentials;
        for (const cwd of ["/personal", "/work", "/personal", "/work"]) {
          expect(Redacted.value((yield* credentials.get("github.com", cwd)).token)).toBe(
            `wrapper-${cwd.slice(1)}`,
          );
        }
        expect(directories).toEqual(["/personal", "/work"]);
        expect(calls.every((args) => !args.includes("--user"))).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("falls back to the existing account choice for an unknown repository username", () => {
    const { layer, calls } = harness(
      { "github.com": { account: "personal" } },
      ["missing"],
      {},
      { "/work": "missing" },
    );
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      expect(Redacted.value((yield* credentials.get("github.com", "/work")).token)).toBe(
        "token-for-personal",
      );
      expect(calls).toEqual([
        ["auth", "token", "--hostname", "github.com", "--user", "missing"],
        ["auth", "token", "--hostname", "github.com", "--user", "personal"],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "refreshes the repository account after invalidation without evicting another account",
    () => {
      const { layer, calls } = harness({}, [], {}, { "/a": "personal", "/b": "work" });
      return Effect.gen(function* () {
        const credentials = yield* GitHubCredentials.GitHubCredentials;
        yield* credentials.get("github.com", "/a");
        yield* credentials.get("github.com", "/b");
        yield* credentials.invalidate("github.com", "/b");
        yield* credentials.get("github.com", "/a");
        yield* credentials.get("github.com", "/b");
        expect(calls.filter((args) => args.includes("personal"))).toHaveLength(1);
        expect(calls.filter((args) => args.includes("work"))).toHaveLength(2);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("lets an environment token win over a pinned account, as gh does", () => {
    vi.stubEnv("GH_TOKEN", "from-env");
    const { layer, calls, configReads } = harness(
      { "github.com": { account: "work" } },
      [],
      {},
      { "/repo": "another" },
    );
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("github.com", "/repo");
      expect(Redacted.value(credential.token)).toBe("from-env");
      expect(credential.source).toBe("env");
      expect(calls).toEqual([]);
      expect(configReads).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("picks up a changed account on the next request without a restart", () => {
    const { layer, calls } = harness();
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
      expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe("active-token");

      yield* settings.update({
        sourceControlHosts: {
          github: { hosts: { "github.com": { account: "work", enabled: true } } },
        },
      });
      expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe("token-for-work");

      yield* settings.update({
        sourceControlHosts: { github: { hosts: { "github.com": { enabled: false } } } },
      });
      expect((yield* Effect.flip(credentials.get("github.com")))._tag).toBe(
        "GitHubHostDisabledError",
      );

      yield* settings.update({ sourceControlHosts: { github: { hosts: {} } } });
      expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe("active-token");
      expect(calls).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("falls back to the active login when the pinned one is no longer signed in", () => {
    const { layer, calls } = harness({ "github.com": { account: "gone" } }, ["gone"]);
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe("active-token");
      expect(calls).toEqual([
        ["auth", "token", "--hostname", "github.com", "--user", "gone"],
        ["auth", "token", "--hostname", "github.com"],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses a token saved in Settings before GH_TOKEN and gh", () => {
    vi.stubEnv("GH_TOKEN", "env-token");
    const { layer, calls } = harness({}, [], { "github.com": "saved-token" });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("github.com");
      expect(Redacted.value(credential.token)).toBe("saved-token");
      expect(credential.source).toBe("settings");
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a host turned off even with a token saved in Settings", () => {
    const { layer } = harness({ "github.com": { enabled: false } }, [], {
      "github.com": "saved-token",
    });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      expect((yield* Effect.flip(credentials.get("github.com")))._tag).toBe(
        "GitHubHostDisabledError",
      );
    }).pipe(Effect.provide(layer));
  });
});
