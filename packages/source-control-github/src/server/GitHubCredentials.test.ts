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

type HostChoice = {
  readonly account?: string;
  readonly enabled?: boolean;
  readonly owners?: Record<string, string>;
  readonly repositories?: Record<string, string>;
};

const hostSettings = (hosts: Record<string, HostChoice>) =>
  Object.fromEntries(
    Object.entries(hosts).map(([host, choice]) => [host, { enabled: true, ...choice }]),
  );

function harness(
  hosts: Record<string, HostChoice> = {},
  signedOut: ReadonlyArray<string> = [],
  tokens: Record<string, string> = {},
) {
  const calls: Array<ReadonlyArray<string>> = [];
  const run: SourceControlHost.SourceControlHost["Service"]["process"]["run"] = (input) =>
    Effect.sync(() => {
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
  return { layer, calls };
}

describe("GitHubCredentials", () => {
  beforeEach(() => {
    for (const name of TOKEN_VARIABLES) vi.stubEnv(name, "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.effect("asks gh for the active login when Settings pin nothing", () => {
    const { layer, calls } = harness();
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("GitHub.com");
      expect(Redacted.value(credential.token)).toBe("active-token");
      expect(calls).toEqual([["auth", "token", "--hostname", "github.com"]]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("passes --user for an account pinned in Settings", () => {
    const { layer, calls } = harness({ "github.com": { account: "work" } });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("github.com");
      expect(Redacted.value(credential.token)).toBe("token-for-work");
      expect(calls).toEqual([["auth", "token", "--hostname", "github.com", "--user", "work"]]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails a host turned off in Settings without asking gh", () => {
    const { layer, calls } = harness({ "github.com": { enabled: false } });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const error = yield* Effect.flip(credentials.get("github.com"));
      expect(error._tag).toBe("GitHubHostDisabledError");
      expect(error.message).toBe(
        "GitHub host github.com is turned off in Settings → Source Control.",
      );
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layer));
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

  it.effect("reads an owner's repositories as the account its rule names", () => {
    const { layer, calls } = harness({ "github.com": { owners: { acme: "work" } } });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const work = yield* credentials.get("github.com", "Acme");
      expect(Redacted.value(work.token)).toBe("token-for-work");
      expect(work.account).toBe("work");
      const personal = yield* credentials.get("github.com", "someone");
      expect(Redacted.value(personal.token)).toBe("active-token");
      expect(personal.account).toBeUndefined();
      expect(yield* credentials.accountFor("github.com", "ACME")).toBe("work");
      expect(yield* credentials.accountFor("github.com", "someone")).toBeUndefined();
      expect(calls).toEqual([
        ["auth", "token", "--hostname", "github.com", "--user", "work"],
        ["auth", "token", "--hostname", "github.com"],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads a repository with its own rule as that account, over its owner's", () => {
    const { layer, calls } = harness({
      "github.com": { owners: { acme: "work" }, repositories: { "acme/handbook": "personal" } },
    });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      expect(yield* credentials.accountFor("github.com", "Acme/Handbook")).toBe("personal");
      expect(yield* credentials.accountFor("github.com", "acme/web")).toBe("work");
      const handbook = yield* credentials.get("github.com", "acme/handbook");
      expect(Redacted.value(handbook.token)).toBe("token-for-personal");
      expect(handbook.account).toBe("personal");
      expect(Redacted.value((yield* credentials.get("github.com", "acme/web")).token)).toBe(
        "token-for-work",
      );
      expect(calls).toEqual([
        ["auth", "token", "--hostname", "github.com", "--user", "personal"],
        ["auth", "token", "--hostname", "github.com", "--user", "work"],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("gives a rule whose login gh no longer holds way to the next choice", () => {
    const { layer, calls } = harness(
      {
        "github.com": {
          account: "personal",
          owners: { acme: "work" },
          repositories: { "acme/handbook": "gone" },
        },
      },
      ["gone"],
    );
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const handbook = yield* credentials.get("github.com", "acme/handbook");
      expect(Redacted.value(handbook.token)).toBe("token-for-work");
      expect(handbook.account).toBe("work");
      expect(calls).toEqual([
        ["auth", "token", "--hostname", "github.com", "--user", "gone"],
        ["auth", "token", "--hostname", "github.com", "--user", "work"],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reads an owner without a rule as the host's pinned account", () => {
    const { layer, calls } = harness({
      "github.com": { account: "personal", owners: { acme: "work" } },
    });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      expect(Redacted.value((yield* credentials.get("github.com", "other")).token)).toBe(
        "token-for-personal",
      );
      expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe(
        "token-for-personal",
      );
      expect(calls).toEqual([["auth", "token", "--hostname", "github.com", "--user", "personal"]]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("lets an environment token win over an owner's rule, as gh does", () => {
    vi.stubEnv("GH_TOKEN", "from-env");
    const { layer, calls } = harness({ "github.com": { owners: { acme: "work" } } });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const credential = yield* credentials.get("github.com", "acme");
      expect(Redacted.value(credential.token)).toBe("from-env");
      expect(credential.account).toBeUndefined();
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("drops every account's token for a host when one is refused", () => {
    const { layer, calls } = harness({ "github.com": { owners: { acme: "work" } } });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      yield* credentials.get("github.com", "acme");
      yield* credentials.get("github.com");
      yield* credentials.invalidate("github.com");
      yield* credentials.get("github.com", "acme");
      yield* credentials.get("github.com");
      expect(calls).toHaveLength(4);
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
