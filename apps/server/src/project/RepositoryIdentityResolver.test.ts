// @effect-diagnostics nodeBuiltinImport:off - realpathSync.native resolves Windows 8.3 short names, which the Effect realPath does not.
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { SourceControlProviderError } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { TestClock } from "effect/testing";

import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const normalizePathSeparators = (value: string) => value.replaceAll("\\", "/");
const normalizeResolvedPath = (value: string) => normalizePathSeparators(value);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    return yield* processRunner.run({
      command: "git",
      args: ["-C", cwd, ...args],
    });
  }).pipe(Effect.provide(ProcessRunner.layer));

const makeRepositoryIdentityResolverTestLayer = (options: {
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
}) =>
  Layer.effect(
    RepositoryIdentityResolver.RepositoryIdentityResolver,
    RepositoryIdentityResolver.make({
      cacheCapacity: 16,
      ...options,
    }),
  ).pipe(Layer.provide(ProcessRunner.layer));

const processOutput = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

/**
 * What `ssh -G` prints for a config with these hosts, including `Match` rules on
 * the login and port. Any other host prints as itself.
 */
function sshConfigOutput(args: ReadonlyArray<string>): string {
  const option = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  // ssh matches host names case-insensitively.
  const host = (args.at(-1) ?? "").toLowerCase();
  const user = option("-l");
  const port = option("-p") ?? "22";
  const hosts: Record<string, { readonly hostname: string; readonly user?: string }> = {
    gh: { hostname: "github.com" },
    g: { hostname: "github.com" },
    gh443: { hostname: "ssh.github.com" },
    // No `User`, so ssh logs in as the local account.
    nouser: { hostname: "github.com", user: "localuser" },
    // A login git cannot spell in a remote.
    spaced: { hostname: "github.com", user: "John Smith" },
    "alice-box": { hostname: "192.0.2.10", user: "alice" },
    "bob-box": { hostname: "192.0.2.10", user: "bob" },
    // `Match originalhost review user git` picks GitHub; otherwise GitLab.
    review: { hostname: user === "git" ? "github.com" : "gitlab.com", user: "me" },
    // `Match exec "test %p = 2222"` picks a second server for the same name.
    forge: { hostname: port === "2222" ? "forge-b.test" : "forge-a.test" },
    "gh-fqdn": { hostname: "github.com." },
    // Two tunnels to different servers through local ports.
    "tunnel-a": { hostname: "localhost" },
    "tunnel-b": { hostname: "127.0.0.1" },
  };
  const entry = hosts[host];
  return `user ${user ?? entry?.user ?? "git"}\nhostname ${entry?.hostname ?? host}\nport ${port}\n`;
}

/** Resolves a repository whose primary remote is `remoteUrl`, against the config above. */
const resolveRemote = (remoteUrl: string, options: { readonly sshFails?: boolean } = {}) => {
  const sshCalls: Array<ReadonlyArray<string>> = [];
  const processRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
    run: (input) =>
      Effect.sync(() => {
        if (input.command !== "ssh") {
          return processOutput(
            input.args.includes("rev-parse") ? "/repo\n" : `origin\t${remoteUrl} (fetch)\n`,
          );
        }
        sshCalls.push(input.args);
        return options.sshFails
          ? processOutput("", 255)
          : processOutput(sshConfigOutput(input.args));
      }),
  });
  return Effect.gen(function* () {
    const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
    return { identity: yield* resolver.resolve("/repo"), sshCalls };
  }).pipe(
    Effect.provide(
      Layer.effect(
        RepositoryIdentityResolver.RepositoryIdentityResolver,
        RepositoryIdentityResolver.make(),
      ).pipe(Layer.provide(processRunner)),
    ),
  );
};

it.layer(NodeServices.layer)("RepositoryIdentityResolverLive", (it) => {
  it.effect("refreshes the Git root only when requested", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    let rootPath = "/repo";
    let remoteUrl = "git@github.com:T3Tools/t3code.git";
    let refinements = 0;
    let refinementFails = false;
    const processRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input) =>
        Effect.sync(() => {
          calls.push(input.args);
          return {
            stdout: input.args.includes("rev-parse")
              ? `${rootPath}\n`
              : `origin\t${remoteUrl} (fetch)\n`,
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    });
    const resolverLayer = Layer.effect(
      RepositoryIdentityResolver.RepositoryIdentityResolver,
      RepositoryIdentityResolver.make({
        refine: (identity) => {
          refinements++;
          if (refinementFails)
            return Effect.fail(
              new SourceControlProviderError({
                provider: "forgejo",
                operation: "detectProvider",
                cwd: rootPath,
                detail: "account unavailable",
              }),
            );
          return Effect.succeed(
            identity.canonicalKey.startsWith("ssh.forge.test/")
              ? {
                  ...identity,
                  provider: "forgejo",
                  webUrl: "http://forge.test:3000/git/team/repo",
                }
              : identity,
          );
        },
      }),
    ).pipe(Layer.provide(processRunner));

    return Effect.gen(function* () {
      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const first = yield* resolver.resolve("/repo/packages/web");
      rootPath = "/repo/packages/web";
      // Longer than the one-minute cadence of the background sweeps.
      yield* TestClock.adjust(Duration.minutes(10));
      const second = yield* resolver.resolve("/repo/packages/web");

      expect(first?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(second).toEqual(first);
      expect(refinements).toBe(1);
      expect(calls).toEqual([
        ["-C", "/repo/packages/web", "rev-parse", "--show-toplevel"],
        ["-C", "/repo", "remote", "-v"],
      ]);

      const refreshed = yield* resolver.resolve("/repo/packages/web", { refresh: true });
      expect(refreshed?.rootPath).toBe("/repo/packages/web");
      expect(yield* resolver.resolve("/repo/packages/web")).toEqual(refreshed);
      expect(calls.slice(2)).toEqual([
        ["-C", "/repo/packages/web", "rev-parse", "--show-toplevel"],
        ["-C", "/repo/packages/web", "remote", "-v"],
      ]);
      remoteUrl = "git@ssh.forge.test:team/repo.git";
      const forgejo = yield* resolver.resolve(rootPath, { refresh: true });
      expect(forgejo?.webUrl).toBe("http://forge.test:3000/git/team/repo");
      expect(forgejo?.provider).toBe("forgejo");
      expect(forgejo?.canonicalKey).toBe("ssh.forge.test/team/repo");
      expect(forgejo?.locator.remoteUrl).toBe(remoteUrl);
      expect(yield* resolver.resolve(rootPath)).toEqual(forgejo);
      expect(refinements).toBe(3);
      refinementFails = true;
      const unavailable = yield* resolver.resolve(rootPath, { refresh: true });
      expect(unavailable?.webUrl).toBeUndefined();
      expect(unavailable?.canonicalKey).toBe("ssh.forge.test/team/repo");
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), resolverLayer)));
  });

  it.effect("retries Git root discovery after the negative TTL", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    let rootAttempts = 0;
    const processRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input) =>
        Effect.sync(() => {
          calls.push(input.args);
          const rootLookup = input.args.includes("rev-parse");
          const failed = rootLookup && rootAttempts++ === 0;
          return {
            stdout: rootLookup
              ? failed
                ? ""
                : "/repo\n"
              : "origin\tgit@github.com:T3Tools/t3code.git (fetch)\n",
            stderr: failed ? "temporary Git failure" : "",
            code: ChildProcessSpawner.ExitCode(failed ? 1 : 0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    });
    const resolverLayer = Layer.effect(
      RepositoryIdentityResolver.RepositoryIdentityResolver,
      RepositoryIdentityResolver.make(),
    ).pipe(Layer.provide(processRunner));

    return Effect.gen(function* () {
      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      expect(yield* resolver.resolve("/repo/packages/web")).toBeNull();
      expect(yield* resolver.resolve("/repo/packages/web")).toBeNull();

      yield* TestClock.adjust(Duration.minutes(1));
      const recovered = yield* resolver.resolve("/repo/packages/web");
      expect(recovered?.rootPath).toBe("/repo");
      expect(calls).toEqual([
        ["-C", "/repo/packages/web", "rev-parse", "--show-toplevel"],
        ["-C", "/repo/packages/web", "rev-parse", "--show-toplevel"],
        ["-C", "/repo", "remote", "-v"],
      ]);
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), resolverLayer)));
  });

  it.effect("keys an aliased remote by its host while git keeps the alias", () =>
    Effect.gen(function* () {
      const { identity } = yield* resolveRemote("gh:T3Tools/t3code");
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(identity?.provider).toBe("github");
      expect(identity?.locator.remoteUrl).toBe("gh:T3Tools/t3code");
    }),
  );

  it.effect.each([
    // Each SSH spelling of an aliased repository.
    { remote: "me@gh:T3Tools/t3code.git", key: "github.com/t3tools/t3code" },
    { remote: "ssh://gh/T3Tools/t3code.git", key: "github.com/t3tools/t3code" },
    { remote: "git+ssh://git@gh:2222/T3Tools/t3code", key: "github.com/t3tools/t3code" },
    { remote: "git@g:T3Tools/t3code", key: "github.com/t3tools/t3code" },
    { remote: "gh443:T3Tools/t3code", key: "github.com/t3tools/t3code" },
    { remote: "nouser:T3Tools/t3code", key: "github.com/t3tools/t3code" },
    { remote: "spaced:T3Tools/t3code", key: "github.com/t3tools/t3code" },
    { remote: "GH:T3Tools/t3code", key: "github.com/t3tools/t3code" },
    { remote: "git@ssh.github.com:T3Tools/t3code", key: "github.com/t3tools/t3code" },
    // `Match` rules see the remote's login and port.
    { remote: "git@review:team/app", key: "github.com/team/app" },
    { remote: "review:team/app", key: "gitlab.com/team/app" },
    { remote: "git@forge:team/app", key: "forge-a.test/team/app" },
    { remote: "ssh://git@forge:2222/team/app", key: "forge-b.test/team/app" },
    // An absolute path names one repository, through an alias or by address.
    { remote: "alice-box:/srv/git/app.git", key: "192.0.2.10/srv/git/app" },
    { remote: "ssh://deploy@192.0.2.10/srv/git/app.git", key: "192.0.2.10/srv/git/app" },
    // A relative path on a server is in the login's home.
    { remote: "alice-box:app.git", key: "192.0.2.10/~alice/app" },
    { remote: "bob-box:app.git", key: "192.0.2.10/~bob/app" },
    { remote: "alice@192.0.2.10:~/app.git", key: "192.0.2.10/~alice/app" },
    { remote: "ssh://alice@192.0.2.10/~/app.git", key: "192.0.2.10/~alice/app" },
    { remote: "bob-box:~alice/app.git", key: "192.0.2.10/~alice/app" },
    // A forge reads the path as the repository's name, whatever the login.
    { remote: "me@gitlab.example.com:team/app.git", key: "gitlab.example.com/team/app" },
    { remote: "git@git.corp.example:team/app.git", key: "git.corp.example/team/app" },
    // A trailing dot is the same name; a tunnel keeps its alias and the login's home.
    { remote: "gh-fqdn:T3Tools/t3code", key: "github.com/t3tools/t3code" },
    { remote: "git@tunnel-a:team/app", key: "tunnel-a/team/app" },
    { remote: "git@tunnel-b:team/app", key: "tunnel-b/team/app" },
    { remote: "alice@tunnel-a:app.git", key: "tunnel-a/~alice/app" },
  ])("keys $remote as $key", ({ remote, key }) =>
    Effect.gen(function* () {
      expect((yield* resolveRemote(remote)).identity?.canonicalKey).toBe(key);
    }),
  );

  it.effect.each([
    "https://github.com/T3Tools/t3code",
    // Public forges key as themselves.
    "git@github.com:T3Tools/t3code",
    "git@ssh.github.com:T3Tools/t3code",
    // Would read as an option.
    "-oProxyCommand=calc:T3Tools/t3code",
    // Shell syntax that a `Match exec` `%r` would expand.
    "x;id@gh:T3Tools/t3code",
    "ssh://x%3Bid@gh/T3Tools/t3code",
  ])("never runs ssh for %s", (remote) =>
    Effect.gen(function* () {
      expect((yield* resolveRemote(remote)).sshCalls).toEqual([]);
    }),
  );

  it.effect("keeps the alias when ssh fails but still keys a spelled login's home", () =>
    Effect.gen(function* () {
      const aliased = yield* resolveRemote("gh:T3Tools/t3code", { sshFails: true });
      expect(aliased.identity?.canonicalKey).toBe("gh/t3tools/t3code");
      const spelled = yield* resolveRemote("alice@192.0.2.10:app.git", { sshFails: true });
      expect(spelled.identity?.canonicalKey).toBe("192.0.2.10/~alice/app");
    }),
  );

  it.effect("normalizes equivalent GitHub remotes into a stable repository identity", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);
      // Native realpath, since git reports the long form of a directory the
      // temp dir may name by its 8.3 short form on Windows.
      const resolvedIdentityRoot =
        identity?.rootPath === undefined ? "" : NodeFS.realpathSync.native(identity.rootPath);
      const resolvedCwd = NodeFS.realpathSync.native(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(normalizeResolvedPath(resolvedIdentityRoot)).toBe(normalizeResolvedPath(resolvedCwd));
      expect(identity?.displayName).toBe("t3tools/t3code");
      expect(identity?.provider).toBe("github");
      expect(identity?.owner).toBe("t3tools");
      expect(identity?.name).toBe("t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("returns the git top-level root path when resolving from a nested workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-nested-root-test-",
      });
      const nestedWorkspace = path.join(repoRoot, "packages", "web");

      yield* fileSystem.makeDirectory(nestedWorkspace, { recursive: true });
      yield* git(repoRoot, ["init"]);
      yield* git(repoRoot, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(nestedWorkspace);
      const resolvedIdentityRoot =
        identity?.rootPath === undefined ? "" : NodeFS.realpathSync.native(identity.rootPath);
      const resolvedRepoRoot = NodeFS.realpathSync.native(repoRoot);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(normalizeResolvedPath(resolvedIdentityRoot)).toBe(
        normalizeResolvedPath(resolvedRepoRoot),
      );
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("returns null for non-git folders and repos without remotes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const nonGitDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-non-git-",
      });
      const gitDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-no-remote-",
      });

      yield* git(gitDir, ["init"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const nonGitIdentity = yield* resolver.resolve(nonGitDir);
      const noRemoteIdentity = yield* resolver.resolve(gitDir);

      expect(nonGitIdentity).toBeNull();
      expect(noRemoteIdentity).toBeNull();
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect.each(["add", "replace"] as const)(
    "refreshes the primary upstream after %s before cache expiry",
    (change) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-upstream-test-",
        });

        yield* git(cwd, ["init"]);
        yield* git(cwd, ["remote", "add", "origin", "git@github.com:julius/t3code.git"]);
        if (change === "replace") {
          yield* git(cwd, ["remote", "add", "upstream", "git@github.com:T3Tools/previous.git"]);
        }

        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const initialIdentity = yield* resolver.resolve(cwd);
        expect(initialIdentity?.canonicalKey).toBe(
          change === "add" ? "github.com/julius/t3code" : "github.com/t3tools/previous",
        );

        yield* git(cwd, [
          "remote",
          change === "add" ? "add" : "set-url",
          "upstream",
          "git@github.com:T3Tools/t3code.git",
        ]);
        expect(yield* resolver.resolve(cwd)).toEqual(initialIdentity);
        const identity = yield* resolver.resolve(cwd, { refresh: true });

        expect(identity).not.toBeNull();
        expect(identity?.locator.remoteName).toBe("upstream");
        expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
        expect(identity?.displayName).toBe("t3tools/t3code");
        expect(yield* resolver.resolve(cwd)).toEqual(identity);
      }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("uses the last remote path segment as the repository name for nested groups", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-nested-group-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@gitlab.com:T3Tools/platform/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("gitlab.com/t3tools/platform/t3code");
      expect(identity?.displayName).toBe("t3tools/platform/t3code");
      expect(identity?.owner).toBe("t3tools");
      expect(identity?.name).toBe("t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect(
    "keeps null identities cached across repeated resolves until the negative TTL expires",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-late-remote-test-",
        });

        yield* git(cwd, ["init"]);

        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const initialIdentity = yield* resolver.resolve(cwd);
        expect(initialIdentity).toBeNull();

        yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

        for (const _attempt of [1, 2, 3]) {
          const cachedIdentity = yield* resolver.resolve(cwd);
          expect(cachedIdentity).toBeNull();
        }

        yield* TestClock.adjust(Duration.millis(120));

        const refreshedIdentity = yield* resolver.resolve(cwd);
        expect(refreshedIdentity).not.toBeNull();
        expect(refreshedIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");
        expect(refreshedIdentity?.name).toBe("t3code");
      }).pipe(
        Effect.provide(
          Layer.merge(
            TestClock.layer(),
            makeRepositoryIdentityResolverTestLayer({
              negativeCacheTtl: Duration.millis(50),
              positiveCacheTtl: Duration.seconds(1),
            }),
          ),
        ),
      ),
  );

  it.effect("refreshes cached identities after the positive TTL when a remote changes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-remote-change-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const initialIdentity = yield* resolver.resolve(cwd);
      expect(initialIdentity).not.toBeNull();
      expect(initialIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");

      yield* git(cwd, ["remote", "set-url", "origin", "git@github.com:T3Tools/t3code-next.git"]);

      const cachedIdentity = yield* resolver.resolve(cwd);
      expect(cachedIdentity).not.toBeNull();
      expect(cachedIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");

      yield* TestClock.adjust(Duration.millis(180));

      const refreshedIdentity = yield* resolver.resolve(cwd);
      expect(refreshedIdentity).not.toBeNull();
      expect(refreshedIdentity?.canonicalKey).toBe("github.com/t3tools/t3code-next");
      expect(refreshedIdentity?.displayName).toBe("t3tools/t3code-next");
      expect(refreshedIdentity?.name).toBe("t3code-next");
    }).pipe(
      Effect.provide(
        Layer.merge(
          TestClock.layer(),
          makeRepositoryIdentityResolverTestLayer({
            negativeCacheTtl: Duration.millis(50),
            positiveCacheTtl: Duration.millis(100),
          }),
        ),
      ),
    ),
  );
});
