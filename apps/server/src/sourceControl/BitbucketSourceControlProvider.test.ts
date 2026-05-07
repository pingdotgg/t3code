import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import * as BitbucketApi from "./BitbucketApi.ts";
import * as BitbucketSourceControlProvider from "./BitbucketSourceControlProvider.ts";

function makeProvider(bitbucket: Partial<BitbucketApi.BitbucketApiShape>) {
  return BitbucketSourceControlProvider.make().pipe(
    Effect.provide(Layer.mock(BitbucketApi.BitbucketApi)(bitbucket)),
  );
}

it.effect("maps Bitbucket PR summaries into provider-neutral change requests", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequest: () =>
        Effect.succeed({
          number: 42,
          title: "Add Bitbucket provider",
          url: "https://bitbucket.org/pingdotgg/t3code/pull-requests/42",
          baseRefName: "main",
          headRefName: "feature/source-control",
          state: "open",
          updatedAt: Option.none(),
          isCrossRepository: true,
          headRepositoryNameWithOwner: "fork/t3code",
          headRepositoryOwnerLogin: "fork",
        }),
    });

    const changeRequest = yield* provider.getChangeRequest({
      cwd: "/repo",
      reference: "42",
    });

    assert.deepStrictEqual(changeRequest, {
      provider: "bitbucket",
      number: 42,
      title: "Add Bitbucket provider",
      url: "https://bitbucket.org/pingdotgg/t3code/pull-requests/42",
      baseRefName: "main",
      headRefName: "feature/source-control",
      state: "open",
      updatedAt: Option.none(),
      isCrossRepository: true,
      headRepositoryNameWithOwner: "fork/t3code",
      headRepositoryOwnerLogin: "fork",
    });
  }),
);

it.effect("lists Bitbucket PRs through provider-neutral input names", () =>
  Effect.gen(function* () {
    let listInput: Parameters<BitbucketApi.BitbucketApiShape["listPullRequests"]>[0] | null = null;
    const provider = yield* makeProvider({
      listPullRequests: (input) => {
        listInput = input;
        return Effect.succeed([]);
      },
    });

    yield* provider.listChangeRequests({
      cwd: "/repo",
      headSelector: "feature/provider",
      state: "all",
      limit: 10,
    });

    assert.deepStrictEqual(listInput, {
      cwd: "/repo",
      headSelector: "feature/provider",
      state: "all",
      limit: 10,
    });
  }),
);

it.effect("creates Bitbucket PRs through provider-neutral input names", () =>
  Effect.gen(function* () {
    let createInput: Parameters<BitbucketApi.BitbucketApiShape["createPullRequest"]>[0] | null =
      null;
    const provider = yield* makeProvider({
      createPullRequest: (input) => {
        createInput = input;
        return Effect.void;
      },
    });

    yield* provider.createChangeRequest({
      cwd: "/repo",
      baseRefName: "main",
      headSelector: "owner:feature/provider",
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });

    assert.deepStrictEqual(createInput, {
      cwd: "/repo",
      baseBranch: "main",
      headSelector: "owner:feature/provider",
      source: {
        owner: "owner",
        refName: "feature/provider",
      },
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });
  }),
);

it.effect("uses Bitbucket API repository detection for default branch lookup", () =>
  Effect.gen(function* () {
    let cwdInput: string | null = null;
    const provider = yield* makeProvider({
      getDefaultBranch: (input) => {
        cwdInput = input.cwd;
        return Effect.succeed("main");
      },
    });

    const defaultBranch = yield* provider.getDefaultBranch({ cwd: "/repo" });

    assert.strictEqual(defaultBranch, "main");
    assert.strictEqual(cwdInput, "/repo");
  }),
);
