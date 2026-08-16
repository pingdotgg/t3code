import { assert, describe, it } from "@effect/vitest";
import { detectSourceControlProviderFromRemoteUrl } from "@t3tools/shared/sourceControl";
import * as Effect from "effect/Effect";

import {
  gitRemoteSshAliasToResolve,
  resolveGitRemoteForSourceControl,
} from "./resolveGitRemoteForSourceControl.ts";

describe("gitRemoteSshAliasToResolve", () => {
  it("selects undotted SSH aliases and skips real hostnames", () => {
    assert.strictEqual(
      gitRemoteSshAliasToResolve("git@github-personal:owner/repo.git"),
      "github-personal",
    );
    assert.strictEqual(
      gitRemoteSshAliasToResolve("ssh://git@gitlab-work/group/project.git"),
      "gitlab-work",
    );
    assert.strictEqual(gitRemoteSshAliasToResolve("git@github.com:owner/repo.git"), null);
    assert.strictEqual(gitRemoteSshAliasToResolve("https://github.com/owner/repo.git"), null);
  });
});

describe("resolveGitRemoteForSourceControl", () => {
  it.effect("rewrites an SSH alias to the resolved HostName", () =>
    Effect.gen(function* () {
      const rewritten = yield* resolveGitRemoteForSourceControl(
        "git@github-personal:owner/repo.git",
        () => Effect.succeed("github.com"),
      );

      assert.strictEqual(rewritten, "git@github.com:owner/repo.git");
      assert.deepStrictEqual(detectSourceControlProviderFromRemoteUrl(rewritten), {
        kind: "github",
        name: "GitHub",
        baseUrl: "https://github.com",
      });
    }),
  );

  it.effect("leaves the original remote when resolve fails", () =>
    Effect.gen(function* () {
      const original = "git@github-personal:owner/repo.git";
      const rewritten = yield* resolveGitRemoteForSourceControl(original, () =>
        Effect.succeed(null),
      );

      assert.strictEqual(rewritten, original);
      assert.strictEqual(detectSourceControlProviderFromRemoteUrl(rewritten)?.kind, "unknown");
    }),
  );

  it.effect("does not invent github.com and does not resolve dotted hosts", () =>
    Effect.gen(function* () {
      let resolveCalls = 0;
      const resolve = () => {
        resolveCalls += 1;
        return Effect.succeed("evil.example");
      };

      assert.strictEqual(
        yield* resolveGitRemoteForSourceControl("git@github.com:owner/repo.git", resolve),
        "git@github.com:owner/repo.git",
      );
      assert.strictEqual(resolveCalls, 0);
    }),
  );
});
