import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as OriginCli from "./OriginCli.ts";
import { parseOriginAuthStatus } from "./originAuthStatus.ts";
import * as OriginSourceControlProvider from "./OriginSourceControlProvider.ts";

const processResult = (
  stdout: string,
  options?: {
    readonly stderr?: string;
    readonly exitCode?: ChildProcessSpawner.ExitCode;
  },
): VcsProcess.VcsProcessOutput => ({
  exitCode: options?.exitCode ?? ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: options?.stderr ?? "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

function makeProvider(origin: Partial<OriginCli.OriginCli["Service"]>) {
  return OriginSourceControlProvider.make.pipe(
    Effect.provide(Layer.mock(OriginCli.OriginCli)(origin)),
  );
}

it.effect("maps Origin PR summaries into provider-neutral change requests", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequest: () =>
        Effect.succeed({
          number: 13,
          title: "Add Origin provider",
          url: "https://cursor.com/codebase/acme/checkout/pull/13",
          baseRefName: "main",
          headRefName: "feature/origin",
          state: "open",
        }),
    });

    const changeRequest = yield* provider.getChangeRequest({
      cwd: "/repo",
      reference: "13",
    });

    assert.deepStrictEqual(changeRequest, {
      provider: "cursor-origin",
      number: 13,
      title: "Add Origin provider",
      url: "https://cursor.com/codebase/acme/checkout/pull/13",
      baseRefName: "main",
      headRefName: "feature/origin",
      state: "open",
      updatedAt: Option.none(),
    });
  }),
);

it.effect("lists Origin pull requests with updatedAt from CLI JSON", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      listPullRequests: () =>
        Effect.succeed([
          {
            number: 7,
            title: "Merged work",
            url: "https://cursor.com/codebase/acme/checkout/pull/7",
            baseRefName: "main",
            headRefName: "feature/merged",
            state: "merged",
            updatedAt: Option.some(DateTime.makeUnsafe("2026-01-02T00:00:00.000Z")),
          },
        ]),
    });

    const changeRequests = yield* provider.listChangeRequests({
      cwd: "/repo",
      headSelector: "feature/merged",
      state: "merged",
      limit: 10,
    });

    assert.strictEqual(changeRequests[0]?.provider, "cursor-origin");
    assert.strictEqual(changeRequests[0]?.state, "merged");
    assert.deepStrictEqual(
      changeRequests[0]?.updatedAt,
      Option.some(DateTime.makeUnsafe("2026-01-02T00:00:00.000Z")),
    );
  }),
);

it.effect("passes the remote repository identity into Origin PR lookups", () =>
  Effect.gen(function* () {
    type ListPullRequestsInput = Parameters<OriginCli.OriginCli["Service"]["listPullRequests"]>[0];
    let listInput: ListPullRequestsInput | undefined;
    const provider = yield* makeProvider({
      listPullRequests: (input: ListPullRequestsInput) => {
        listInput = input;
        return Effect.succeed([]);
      },
    });

    yield* provider.listChangeRequests({
      cwd: "/repo",
      headSelector: "feature/origin",
      state: "open",
      context: {
        provider: {
          kind: "cursor-origin",
          name: "Cursor Origin",
          baseUrl: "https://origin.cursor.com",
        },
        remoteName: "origin",
        remoteUrl: "git@origin.cursor.com:acme/checkout.git",
      },
    });

    assert.strictEqual(listInput?.nameWithOwner, "acme/checkout");
  }),
);

it.effect("adds safe request context while retaining Origin CLI causes", () =>
  Effect.gen(function* () {
    const cause = new OriginCli.OriginPullRequestNotFoundError({
      command: "origin",
      cwd: "/repo",
      cause: new Error("raw upstream detail that should remain in the cause"),
    });
    const provider = yield* makeProvider({
      getPullRequest: () => Effect.fail(cause),
    });

    const error = yield* provider
      .getChangeRequest({
        cwd: "/repo",
        reference: "https://user:secret@origin.cursor.com/acme/checkout/pull/13?token=secret",
      })
      .pipe(Effect.flip);

    assert.deepStrictEqual(
      {
        provider: error.provider,
        operation: error.operation,
        command: error.command,
        cwd: error.cwd,
        reference: error.reference,
        detail: error.detail,
      },
      {
        provider: "cursor-origin",
        operation: "getChangeRequest",
        command: "origin",
        cwd: "/repo",
        reference: "https://origin.cursor.com/acme/checkout/pull/13",
        detail: "Pull request not found. Check the PR number or URL and try again.",
      },
    );
    assert.strictEqual(error.cause, cause);
    assert.equal(error.message.includes("raw upstream detail"), false);
  }),
);

it("parses Origin CLI auth status without exposing tokens", () => {
  const auth = OriginSourceControlProvider.discovery.parseAuth(
    processResult("Logged in to origin.cursor.com as origin-user\n"),
  );

  assert.strictEqual(auth.status, "authenticated");
  assert.deepStrictEqual(auth.account, Option.some("origin-user"));
  assert.deepStrictEqual(auth.host, Option.some("origin.cursor.com"));
});

it("treats a failed Origin auth probe as unauthenticated", () => {
  const auth = OriginSourceControlProvider.discovery.parseAuth(
    processResult("not logged in\n", { exitCode: ChildProcessSpawner.ExitCode(1) }),
  );

  assert.strictEqual(auth.status, "unauthenticated");
  assert.equal(Option.getOrNull(auth.detail)?.includes("not logged in"), true);
});

it("does not treat negated Origin login copy as authenticated", () => {
  const auth = OriginSourceControlProvider.discovery.parseAuth(
    processResult("Not logged in as theo\n", { exitCode: ChildProcessSpawner.ExitCode(1) }),
  );

  assert.strictEqual(auth.status, "unauthenticated");
  assert.equal(Option.getOrNull(auth.account), null);
});

it("extracts the account from Origin auth status text", () => {
  assert.deepStrictEqual(parseOriginAuthStatus("Logged in as theo\n"), {
    parsed: true,
    host: "origin.cursor.com",
    account: "theo",
  });
});

it("does not treat negated Origin auth output as an account", () => {
  assert.deepStrictEqual(parseOriginAuthStatus("Not logged in as theo\n"), {
    parsed: false,
    host: null,
    account: null,
  });
  assert.deepStrictEqual(parseOriginAuthStatus("No account: run origin auth login\n"), {
    parsed: false,
    host: null,
    account: null,
  });
});
