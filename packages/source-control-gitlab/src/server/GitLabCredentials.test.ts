import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitLabCredentials from "./GitLabCredentials.ts";

/** A scripted glab: `config get <key> --host <host>` reads `config`, `api` refreshes. */
function harness(config: Record<string, Record<string, string>>, refreshed?: string) {
  const runs: Array<SourceControlHost.SourceControlProcessInput> = [];
  const run: SourceControlHost.SourceControlHost["Service"]["process"]["run"] = (input) =>
    Effect.sync(() => {
      runs.push(input);
      const host = input.args[input.args.indexOf("--host") + 1] ?? "";
      if (input.args[0] === "api") {
        if (refreshed !== undefined) config[input.args[2]!]!.token = refreshed;
        return TestSourceControlHost.processOutput("{}");
      }
      return TestSourceControlHost.processOutput(`${config[host]?.[input.args[2]!] ?? ""}\n`);
    });
  const layer = GitLabCredentials.layer.pipe(
    Layer.provide(TestSourceControlHost.layer({ process: { run } })),
  );
  return { layer, runs };
}

const token = (host: string) =>
  GitLabCredentials.GitLabCredentials.pipe(
    Effect.flatMap((credentials) => credentials.get(host)),
    Effect.map(Option.map(Redacted.value)),
  );

describe("GitLabCredentials", () => {
  it.effect("reads only the token glab stores for the host", () => {
    const { layer, runs } = harness({ "gitlab.example.com": { token: "stored" } });
    return Effect.gen(function* () {
      expect(yield* token("GitLab.Example.com")).toEqual(Option.some("stored"));
      expect(runs.map((input) => input.args)).toEqual([
        ["config", "get", "token", "--host", "gitlab.example.com"],
        ["config", "get", "is_oauth2", "--host", "gitlab.example.com"],
        ["config", "get", "token", "--host", "gitlab.example.com"],
      ]);
      // glab would otherwise answer every host with an ambient token.
      for (const input of runs) {
        expect(input.env).toMatchObject({ GITLAB_TOKEN: "", OAUTH_TOKEN: "", CI_JOB_TOKEN: "" });
      }
      // Cached: a second read asks glab nothing.
      yield* token("gitlab.example.com");
      expect(runs).toHaveLength(3);
    }).pipe(Effect.provide(layer));
  });

  it.effect("has nothing for a host glab holds no login for", () => {
    const { layer, runs } = harness({});
    return Effect.gen(function* () {
      expect(yield* token("attacker.example")).toEqual(Option.none());
      expect(runs).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refreshes an OAuth login through an API call before reading it", () => {
    const { layer, runs } = harness(
      { "gitlab.com": { token: "expired", is_oauth2: "true" } },
      "refreshed",
    );
    return Effect.gen(function* () {
      expect(yield* token("gitlab.com")).toEqual(Option.some("refreshed"));
      expect(runs.map((input) => input.args)).toContainEqual([
        "api",
        "--hostname",
        "gitlab.com",
        "user",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("asks glab again after a refused token is invalidated", () => {
    const { layer, runs } = harness({ "gitlab.com": { token: "stored" } });
    return Effect.gen(function* () {
      const credentials = yield* GitLabCredentials.GitLabCredentials;
      yield* credentials.get("gitlab.com");
      yield* credentials.invalidate("gitlab.com");
      yield* credentials.get("gitlab.com");
      expect(runs).toHaveLength(6);
    }).pipe(Effect.provide(layer));
  });
});
