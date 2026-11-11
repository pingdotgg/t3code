import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/process";

import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@t3tools/contracts";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import { projectGitHubEnvironment } from "./projectGitHubEnvironment.ts";

const projectId = ProjectId.make("project-a");

describe("projectGitHubEnvironment", () => {
  it.effect("uses the environment host pin when the project inherits", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const run: SourceControlHost.SourceControlHost["Service"]["process"]["run"] = (input) =>
      Effect.sync(() => {
        calls.push(input.args);
        return {
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: "token-for-work\n",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      });
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      sourceControlHosts: { github: { hosts: { "github.com": { account: "work" } } } },
    });
    return Effect.gen(function* () {
      const env = yield* projectGitHubEnvironment(settings, projectId);
      expect(env).toEqual({ GH_TOKEN: "token-for-work" });
      expect(calls).toEqual([["auth", "token", "--hostname", "github.com", "--user", "work"]]);
    }).pipe(Effect.provide(TestSourceControlHost.layer({ process: { run } })));
  });

  it.effect("prefers the project pin over the environment host pin", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const run: SourceControlHost.SourceControlHost["Service"]["process"]["run"] = (input) =>
      Effect.sync(() => {
        calls.push(input.args);
        const user = input.args[input.args.indexOf("--user") + 1];
        return {
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: `token-for-${user}\n`,
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      });
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      sourceControlHosts: { github: { hosts: { "github.com": { account: "work" } } } },
      projectSettingsOverrides: {
        [projectId]: { githubHostAccounts: { "github.com": "personal" } },
      },
    });
    return Effect.gen(function* () {
      const env = yield* projectGitHubEnvironment(settings, projectId);
      expect(env).toEqual({ GH_TOKEN: "token-for-personal" });
      expect(calls).toEqual([["auth", "token", "--hostname", "github.com", "--user", "personal"]]);
    }).pipe(Effect.provide(TestSourceControlHost.layer({ process: { run } })));
  });

  it.effect("returns no overlay when neither pin is set", () => {
    const run: SourceControlHost.SourceControlHost["Service"]["process"]["run"] = () =>
      Effect.die("gh should not run");
    return Effect.gen(function* () {
      expect(yield* projectGitHubEnvironment(DEFAULT_SERVER_SETTINGS, projectId)).toEqual({});
    }).pipe(Effect.provide(TestSourceControlHost.layer({ process: { run } })));
  });
});
