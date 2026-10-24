import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { ChildProcessSpawner } from "effect/process";

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
  repositories: Record<string, string | number> = {},
) {
  const calls: Array<ReadonlyArray<string>> = [];
  const gitCalls: string[] = [];
  const run: SourceControlHost.SourceControlHost["Service"]["process"]["run"] = (input) =>
    Effect.sync(() => {
      if (input.command === "git") {
        gitCalls.push(input.cwd);
        const value = repositories[input.cwd];
        return {
          exitCode: ChildProcessSpawner.ExitCode(
            typeof value === "number" ? value : value === undefined ? 1 : 0,
          ),
          stdout: typeof value === "string" ? value : "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }
      calls.push(input.args);
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
        stdout: input.args.includes("--user") ? `token-for-${user}\n` : "active-token\n",
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
      }),
    ),
    Layer.provide(NodeCrypto.layer),
  );
  return { layer, calls, gitCalls };
}

describe("GitHubCredentials", () => {
  beforeEach(() => {
    for (const name of TOKEN_VARIABLES) vi.stubEnv(name, "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.effect("lets an environment token win over a pinned account, as gh does", () => {
    vi.stubEnv("GH_TOKEN", "from-env");
    const { layer, calls } = harness({ "github.com": { account: "work" } });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("github.com");
      expect(Redacted.value(credential.token)).toBe("from-env");
      expect(credential.source).toBe("env");
      expect(calls).toEqual([]);
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

it.effect(
  "keeps repo accounts separate from settings and each other, including invalidation",
  () => {
    const { layer, calls } = harness(
      { "github.com": { account: "personal" } },
      [],
      {},
      {
        "/work": "work-user",
        "/other": "other-user",
      },
    );
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const get = (cwd: string) =>
        credentials
          .get("github.com")
          .pipe(Effect.provideService(GitHubCredentials.RepositoryDirectory, cwd));
      expect(Redacted.value((yield* get("/work")).token)).toBe("token-for-work-user");
      expect(Redacted.value((yield* get("/other")).token)).toBe("token-for-other-user");
      yield* credentials
        .invalidate("github.com")
        .pipe(Effect.provideService(GitHubCredentials.RepositoryDirectory, "/work"));
      yield* get("/work");
      yield* get("/other");
      expect(calls).toEqual([
        ["auth", "token", "--hostname", "github.com", "--user", "work-user"],
        ["auth", "token", "--hostname", "github.com", "--user", "other-user"],
        ["auth", "token", "--hostname", "github.com", "--user", "work-user"],
      ]);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("does not fall back to another account when the repo account is signed out", () => {
  const { layer, calls } = harness({}, ["work-user"], {}, { "/work": "work-user" });
  return Effect.gen(function* () {
    const credentials = yield* GitHubCredentials.GitHubCredentials;
    const error = yield* Effect.flip(
      credentials
        .get("github.com")
        .pipe(Effect.provideService(GitHubCredentials.RepositoryDirectory, "/work")),
    );
    expect(error._tag).toBe("GitHubNotSignedInError");
    expect(calls).toEqual([["auth", "token", "--hostname", "github.com", "--user", "work-user"]]);
  }).pipe(Effect.provide(layer));
});

it.effect("reuses the repo account lookup for repeated API reads", () => {
  const { layer, gitCalls } = harness({}, [], {}, { "/repo": "work" });
  return Effect.gen(function* () {
    const credentials = yield* GitHubCredentials.GitHubCredentials;
    for (let i = 0; i < 5; i++)
      yield* credentials
        .get("github.com")
        .pipe(Effect.provideService(GitHubCredentials.RepositoryDirectory, "/repo"));
    expect(gitCalls).toEqual(["/repo"]);
  }).pipe(Effect.provide(layer));
});

it.effect("keeps GitHub.com repo accounts out of Enterprise requests", () => {
  const { layer, calls, gitCalls } = harness(
    { "ghe.example.test": { account: "enterprise" } },
    [],
    {},
    { "/repo": "personal" },
  );
  return Effect.gen(function* () {
    const credentials = yield* GitHubCredentials.GitHubCredentials;
    yield* credentials
      .get("ghe.example.test")
      .pipe(Effect.provideService(GitHubCredentials.RepositoryDirectory, "/repo"));
    expect(calls).toEqual([
      ["auth", "token", "--hostname", "ghe.example.test", "--user", "enterprise"],
    ]);
    expect(gitCalls).toEqual([]);
  }).pipe(Effect.provide(layer));
});

it.effect("fails unreadable repo configuration instead of selecting another account", () => {
  const { layer, calls } = harness({}, [], {}, { "/repo": 128 });
  return Effect.gen(function* () {
    const credentials = yield* GitHubCredentials.GitHubCredentials;
    const error = yield* Effect.flip(
      credentials
        .get("github.com")
        .pipe(Effect.provideService(GitHubCredentials.RepositoryDirectory, "/repo")),
    );
    expect(error._tag).toBe("GitHubRepositoryAccountError");
    expect(calls).toEqual([]);
  }).pipe(Effect.provide(layer));
});
