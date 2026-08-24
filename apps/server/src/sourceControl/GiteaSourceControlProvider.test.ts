import { assert, it } from "@effect/vitest";
import type { SourceControlProviderError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as GiteaCli from "./GiteaCli.ts";
import * as GiteaSourceControlProvider from "./GiteaSourceControlProvider.ts";

function makeProvider(gitea: Partial<GiteaCli.GiteaCli["Service"]>) {
  return GiteaSourceControlProvider.make.pipe(Effect.provide(Layer.mock(GiteaCli.GiteaCli)(gitea)));
}

/** Serializes tea's login list for discovery inputs. */
function loginsJson(logins: ReadonlyArray<Record<string, string>>): string {
  // @effect-diagnostics-next-line preferSchemaOverJson:off
  return JSON.stringify(logins);
}

const SELF_HOSTED_LOGIN = {
  name: "self-hosted",
  url: "https://git.example.com",
  ssh_host: "git.example.com",
  user: "mario",
  default: "true",
};

it.effect("maps Gitea PR summaries into provider-neutral change requests", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequest: () =>
        Effect.succeed({
          number: 42,
          title: "Add Gitea provider",
          url: "https://git.example.com/owner/repo/pulls/42",
          baseRefName: "main",
          headRefName: "t3code/abcd1234",
          state: "open",
          isCrossRepository: true,
          headRepositoryNameWithOwner: "fork/repo",
          headRepositoryOwnerLogin: "fork",
        }),
    });

    const changeRequest = yield* provider.getChangeRequest({ cwd: "/repo", reference: "42" });

    assert.deepStrictEqual(changeRequest, {
      provider: "gitea",
      number: 42,
      title: "Add Gitea provider",
      url: "https://git.example.com/owner/repo/pulls/42",
      baseRefName: "main",
      headRefName: "t3code/abcd1234",
      state: "open",
      updatedAt: Option.none(),
      isCrossRepository: true,
      headRepositoryNameWithOwner: "fork/repo",
      headRepositoryOwnerLogin: "fork",
    });
  }),
);

it.effect("adds repository context while retaining Gitea CLI causes", () =>
  Effect.gen(function* () {
    const cause = new GiteaCli.GiteaCliCommandError({
      operation: "execute",
      command: "tea",
      cwd: "/repo",
      cause: new Error("raw upstream detail that should remain in the cause"),
    });
    const provider = yield* makeProvider({ createRepository: () => Effect.fail(cause) });

    const error = yield* provider
      .createRepository({ cwd: "/repo", repository: "owner/repo", visibility: "private" })
      .pipe(Effect.flip);

    assert.deepStrictEqual(
      {
        provider: error.provider,
        operation: error.operation,
        command: error.command,
        cwd: error.cwd,
        repository: error.repository,
        detail: error.detail,
      },
      {
        provider: "gitea",
        operation: "createRepository",
        command: "tea",
        cwd: "/repo",
        repository: "owner/repo",
        detail: "Gitea CLI command failed.",
      },
    );
    assert.strictEqual(error.cause, cause);
    assert.equal(error.message.includes("raw upstream detail"), false);
  }),
);

it.effect("reports the right operation for each failing Gitea call", () =>
  Effect.gen(function* () {
    const cause = new GiteaCli.GiteaCliAuthenticationError({
      operation: "execute",
      command: "tea",
      cwd: "/repo",
      cause: new Error("http 401"),
    });
    const provider = yield* makeProvider({
      listPullRequests: () => Effect.fail(cause),
      getPullRequest: () => Effect.fail(cause),
      createPullRequest: () => Effect.fail(cause),
      getDefaultBranch: () => Effect.fail(cause),
      checkoutPullRequest: () => Effect.fail(cause),
      getRepositoryCloneUrls: () => Effect.fail(cause),
    });

    const operations: ReadonlyArray<
      readonly [string, Effect.Effect<void, SourceControlProviderError>]
    > = [
      [
        "listChangeRequests",
        provider
          .listChangeRequests({ cwd: "/repo", headSelector: "x", state: "open" })
          .pipe(Effect.asVoid),
      ],
      [
        "getChangeRequest",
        provider.getChangeRequest({ cwd: "/repo", reference: "42" }).pipe(Effect.asVoid),
      ],
      [
        "createChangeRequest",
        provider
          .createChangeRequest({
            cwd: "/repo",
            baseRefName: "main",
            headSelector: "x",
            title: "t",
            bodyFile: "/tmp/b.md",
          })
          .pipe(Effect.asVoid),
      ],
      ["getDefaultBranch", provider.getDefaultBranch({ cwd: "/repo" }).pipe(Effect.asVoid)],
      ["checkoutChangeRequest", provider.checkoutChangeRequest({ cwd: "/repo", reference: "42" })],
      [
        "getRepositoryCloneUrls",
        provider
          .getRepositoryCloneUrls({ cwd: "/repo", repository: "owner/repo" })
          .pipe(Effect.asVoid),
      ],
    ];

    for (const [operation, effect] of operations) {
      const error = yield* Effect.flip(effect);
      assert.strictEqual(error.provider, "gitea");
      assert.strictEqual(error.operation, operation);
      assert.strictEqual(error.cwd, "/repo");
      assert.strictEqual(error.cause, cause);
    }
  }),
);

it.effect("passes provider-neutral list input straight through to tea", () =>
  Effect.gen(function* () {
    let listInput: Parameters<GiteaCli.GiteaCli["Service"]["listPullRequests"]>[0] | null = null;
    const provider = yield* makeProvider({
      listPullRequests: (input) => {
        listInput = input;
        return Effect.succeed([]);
      },
    });

    yield* provider.listChangeRequests({
      cwd: "/repo",
      headSelector: "t3code/abcd1234",
      state: "all",
      limit: 10,
    });

    assert.deepStrictEqual(listInput, {
      cwd: "/repo",
      headSelector: "t3code/abcd1234",
      state: "all",
      limit: 10,
    });
  }),
);

it.effect("splits an owner:branch head selector into a cross-repository source", () =>
  Effect.gen(function* () {
    let createInput: Parameters<GiteaCli.GiteaCli["Service"]["createPullRequest"]>[0] | null = null;
    const provider = yield* makeProvider({
      createPullRequest: (input) => {
        createInput = input;
        return Effect.void;
      },
    });

    yield* provider.createChangeRequest({
      cwd: "/repo",
      baseRefName: "main",
      headSelector: "contributor:feature",
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });

    assert.deepStrictEqual(createInput, {
      cwd: "/repo",
      baseBranch: "main",
      headSelector: "contributor:feature",
      source: { owner: "contributor", refName: "feature" },
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });
  }),
);

it("reports the default tea login as the authenticated account", () => {
  const auth = GiteaSourceControlProvider.discovery.parseAuth({
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout: loginsJson([SELF_HOSTED_LOGIN]),
    stderr: "",
  });

  assert.deepStrictEqual(
    { status: auth.status, account: auth.account, host: auth.host },
    {
      status: "authenticated",
      account: Option.some("mario"),
      host: Option.some("git.example.com"),
    },
  );
});

it("mentions the other instances when several Gitea logins are configured", () => {
  const auth = GiteaSourceControlProvider.discovery.parseAuth({
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout: loginsJson([
      { ...SELF_HOSTED_LOGIN, default: "false" },
      {
        name: "work",
        url: "https://code.work.internal:3000",
        ssh_host: "code.work.internal",
        user: "worker",
        default: "true",
      },
    ]),
    stderr: "",
  });

  assert.strictEqual(auth.status, "authenticated");
  assert.deepStrictEqual(auth.account, Option.some("worker"));
  assert.equal(Option.getOrElse(auth.detail, () => "").includes("2 Gitea instances"), true);
});

it("reports unauthenticated when tea has no logins", () => {
  const auth = GiteaSourceControlProvider.discovery.parseAuth({
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout: "[]",
    stderr: "",
  });

  assert.strictEqual(auth.status, "unauthenticated");
  assert.deepStrictEqual(auth.account, Option.none());
});

it("reports unauthenticated when tea exits non-zero", () => {
  const auth = GiteaSourceControlProvider.discovery.parseAuth({
    exitCode: ChildProcessSpawner.ExitCode(1),
    stdout: "",
    stderr: "Error: no logins configured",
  });

  assert.strictEqual(auth.status, "unauthenticated");
});

it("survives malformed tea output instead of throwing", () => {
  const auth = GiteaSourceControlProvider.discovery.parseAuth({
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout: "not json at all",
    stderr: "",
  });

  assert.strictEqual(auth.status, "unauthenticated");
});

it("refines an unknown remote whose host tea is authenticated against", () => {
  const provider = GiteaSourceControlProvider.discovery.refineUnknownRemote?.({
    cwd: "/repo",
    context: {
      provider: {
        kind: "unknown",
        name: "git.example.com",
        baseUrl: "https://git.example.com",
      },
      remoteName: "origin",
      remoteUrl: "git@git.example.com:owner/repo.git",
    },
    auth: {
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout: loginsJson([SELF_HOSTED_LOGIN]),
      stderr: "",
    },
  });

  assert.deepStrictEqual(provider, {
    kind: "gitea",
    name: "Gitea Self-Hosted",
    baseUrl: "https://git.example.com",
  });
});

it("refines a remote host carrying a port that the login does not", () => {
  const provider = GiteaSourceControlProvider.discovery.refineUnknownRemote?.({
    cwd: "/repo",
    context: {
      provider: {
        kind: "unknown",
        name: "git.example.com:3000",
        baseUrl: "https://git.example.com:3000",
      },
      remoteName: "origin",
      remoteUrl: "https://git.example.com:3000/owner/repo.git",
    },
    auth: {
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout: loginsJson([SELF_HOSTED_LOGIN]),
      stderr: "",
    },
  });

  assert.strictEqual(provider?.kind, "gitea");
  assert.strictEqual(provider?.baseUrl, "https://git.example.com:3000");
});

it("does not refine a host tea knows nothing about", () => {
  const provider = GiteaSourceControlProvider.discovery.refineUnknownRemote?.({
    cwd: "/repo",
    context: {
      provider: {
        kind: "unknown",
        name: "git.unrelated.example",
        baseUrl: "https://git.unrelated.example",
      },
      remoteName: "origin",
      remoteUrl: "git@git.unrelated.example:owner/repo.git",
    },
    auth: {
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout: loginsJson([SELF_HOSTED_LOGIN]),
      stderr: "",
    },
  });

  assert.strictEqual(provider, null);
});
