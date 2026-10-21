import { SourceControlProviderKind } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as BitbucketApi from "./BitbucketApi.ts";
import * as BitbucketSourceControlProvider from "./BitbucketSourceControlProvider.ts";
import {
  BitbucketPullRequestSchema,
  normalizeBitbucketPullRequestRecord,
} from "./bitbucketPullRequests.ts";

const decodePullRequest = Schema.decodeEffect(BitbucketPullRequestSchema);

function makeProvider(bitbucket: Partial<BitbucketApi.BitbucketApi["Service"]>) {
  return BitbucketSourceControlProvider.make.pipe(
    Effect.provide(Layer.mock(BitbucketApi.BitbucketApi)(bitbucket)),
  );
}

it.effect("maps Bitbucket PR summaries into provider-neutral change requests", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequest: () =>
        decodePullRequest({
          id: 42,
          title: "Add Bitbucket provider",
          links: { html: { href: "https://bitbucket.org/pingdotgg/t3code/pull-requests/42" } },
          source: {
            branch: { name: "feature/source-control" },
            commit: { hash: "a".repeat(40) },
            repository: { full_name: "fork/t3code" },
          },
          destination: {
            branch: { name: "main" },
            repository: { full_name: "pingdotgg/t3code" },
          },
          state: "OPEN",
        }).pipe(Effect.orDie, Effect.map(normalizeBitbucketPullRequestRecord)),
    });

    const changeRequest = yield* provider.getChangeRequest({
      cwd: "/repo",
      reference: "42",
    });

    assert.deepStrictEqual(changeRequest, {
      provider: SourceControlProviderKind.make("bitbucket"),
      number: 42,
      title: "Add Bitbucket provider",
      url: "https://bitbucket.org/pingdotgg/t3code/pull-requests/42",
      baseRefName: "main",
      headRefName: "feature/source-control",
      headSha: "a".repeat(40),
      state: "open",
      updatedAt: Option.none(),
      isCrossRepository: true,
      headRepositoryNameWithOwner: "fork/t3code",
      headRepositoryOwnerLogin: "fork",
    });
  }),
);
