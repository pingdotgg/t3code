import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { ChildProcessSpawner } from "effect/process";

import { DEFAULT_SERVER_SETTINGS, ServerSettingsError } from "@t3tools/contracts";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
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
  settingsRead: (
    get: SourceControlHost.SourceControlHost["Service"]["settings"]["get"],
  ) => SourceControlHost.SourceControlHost["Service"]["settings"]["get"] = (get) => get,
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
  const hostLayer = Layer.effect(
    SourceControlHost.SourceControlHost,
    Effect.map(SourceControlHost.SourceControlHost, (host) =>
      SourceControlHost.SourceControlHost.of({
        ...host,
        settings: { get: settingsRead(host.settings.get) },
      }),
    ),
  ).pipe(
    Layer.provideMerge(
      TestSourceControlHost.layer({
        settings: applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
          sourceControlHosts: { github: { hosts: hostSettings(hosts), tokens } },
        }),
        process: { run },
      }),
    ),
  );
  const layer = GitHubCredentials.layer.pipe(
    Layer.provideMerge(hostLayer),
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

  it.effect("uses one successful selection snapshot and reads changes on the next call", () => {
    let reads = 0;
    const { layer, calls } = harness({}, [], { "github.com": "first-token" }, (get) =>
      get.pipe(
        Effect.map((settings) => {
          reads++;
          return reads === 1
            ? settings
            : applyServerSettingsPatch(settings, {
                sourceControlHosts: { github: { tokens: { "github.com": "next-token" } } },
              });
        }),
      ),
    );
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const first = yield* credentials.get(" GitHub.com ");
      expect(Redacted.value(first.token)).toBe("first-token");
      expect(first.host).toBe("github.com");
      expect(reads).toBe(1);
      const next = yield* credentials.get("github.com");
      expect(Redacted.value(next.token)).toBe("next-token");
      expect(next.fingerprint).not.toBe(first.fingerprint);
      expect(reads).toBe(2);
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("picks up saved-token replacement and removal without caching the selection", () => {
    vi.stubEnv("GH_TOKEN", "env-token");
    const { layer, calls } = harness({}, [], { "github.com": "saved-token" });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
      const first = yield* credentials.get("github.com");
      yield* settings.update({
        sourceControlHosts: { github: { tokens: { "github.com": "replacement-token" } } },
      });
      const next = yield* credentials.get("github.com");
      expect(Redacted.value(next.token)).toBe("replacement-token");
      expect(next.source).toBe("settings");
      expect(next.fingerprint).not.toBe(first.fingerprint);
      yield* settings.update({ sourceControlHosts: { github: { tokens: {} } } });
      const removed = yield* credentials.get("github.com");
      expect(Redacted.value(removed.token)).toBe("env-token");
      expect(removed.source).toBe("env");
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("retries saved settings after the first read fails", () => {
    let reads = 0;
    const { layer, calls } = harness({}, [], { "github.com": "saved-token" }, (get) =>
      Effect.suspend(() => {
        reads++;
        return reads === 1
          ? Effect.fail(
              new ServerSettingsError({
                settingsPath: "fixture-settings.json",
                operation: "read-secret",
                cause: "fixture transient failure",
              }),
            )
          : get;
      }),
    );
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const recovered = yield* credentials.get("github.com");
      expect(Redacted.value(recovered.token)).toBe("saved-token");
      expect(recovered.source).toBe("settings");
      expect(reads).toBe(2);
      expect(calls).toEqual([]);
      yield* credentials.get("github.com");
      expect(reads).toBe(3);
    }).pipe(Effect.provide(layer));
  });

  it.effect("falls back to the environment when both settings reads fail", () => {
    vi.stubEnv("GH_TOKEN", "env-token");
    let reads = 0;
    const { layer, calls } = harness({}, [], {}, () =>
      Effect.suspend(() => {
        reads++;
        return Effect.fail(
          new ServerSettingsError({
            settingsPath: "fixture-settings.json",
            operation: "read-secret",
            cause: "fixture unavailable settings",
          }),
        );
      }),
    );
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const value = yield* credentials.get("github.com");
      expect(value.source).toBe("env");
      expect(Redacted.value(value.token)).toBe("env-token");
      expect(reads).toBe(2);
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("invalidates the current account without dropping another account's token", () => {
    const { layer, calls } = harness();
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const settings = yield* TestSourceControlHost.TestSourceControlHostSettings;
      yield* credentials.get("github.com");
      yield* settings.update({
        sourceControlHosts: { github: { hosts: { "github.com": { account: "work" } } } },
      });
      yield* credentials.get("github.com");
      yield* credentials.invalidate(" GitHub.com ");
      expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe("token-for-work");
      yield* settings.update({ sourceControlHosts: { github: { hosts: {} } } });
      expect(Redacted.value((yield* credentials.get("github.com")).token)).toBe("active-token");
      expect(calls).toEqual([
        ["auth", "token", "--hostname", "github.com"],
        ["auth", "token", "--hostname", "github.com", "--user", "work"],
        ["auth", "token", "--hostname", "github.com", "--user", "work"],
      ]);
    }).pipe(Effect.provide(layer));
  });
});
