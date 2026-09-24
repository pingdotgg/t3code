import { assert, it } from "@effect/vitest";
import type { RepositoryIdentity, SourceControlProviderInfo } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { refineRepositoryIdentity } from "./refineRepositoryIdentity.ts";

const identity = (remoteUrl: string, provider: string) =>
  ({
    canonicalKey: "git.example.test/group/project",
    locator: { source: "git-remote", remoteName: "origin", remoteUrl },
    rootPath: "/repo",
    displayName: "group/project",
    provider,
    owner: "group",
    name: "project",
  }) satisfies RepositoryIdentity;

/** Answers every resolution as the signed-in CLIs would for this remote. */
const resolvingTo =
  (provider: SourceControlProviderInfo | null) =>
  (input: { readonly context: { readonly remoteName: string; readonly remoteUrl: string } }) =>
    Effect.succeed({ context: provider === null ? null : { ...input.context, provider } });

const gitlab: SourceControlProviderInfo = {
  kind: "gitlab",
  name: "GitLab Self-Hosted",
  baseUrl: "https://git.example.test",
};

it.effect("names a self-hosted GitLab its hostname does not", () =>
  Effect.gen(function* () {
    const unknown = identity("ssh://git@git.example.test:8888/group/project.git", "unknown");
    const refined = yield* refineRepositoryIdentity(resolvingTo(gitlab), unknown);
    assert.deepStrictEqual(refined, { ...unknown, provider: "gitlab" });
  }),
);

it.effect("leaves an unrecognised host alone when no CLI is signed in to it", () =>
  Effect.gen(function* () {
    const unknown = identity("git@git.example.test:group/project.git", "unknown");
    assert.deepStrictEqual(yield* refineRepositoryIdentity(resolvingTo(null), unknown), unknown);
  }),
);

it.effect("does not turn a Forgejo identity into GitLab", () =>
  Effect.gen(function* () {
    const forgejo = identity("git@forgejo.example.test:group/project.git", "forgejo");
    assert.deepStrictEqual(yield* refineRepositoryIdentity(resolvingTo(gitlab), forgejo), forgejo);
  }),
);

it.effect("gives an SSH Forgejo remote the web URL of the instance serving it", () =>
  Effect.gen(function* () {
    const unknown = identity("git@git.example.test:group/project.git", "unknown");
    const refined = yield* refineRepositoryIdentity(
      resolvingTo({ kind: "forgejo", name: "Forgejo", baseUrl: "http://git.example.test:3000/" }),
      unknown,
    );
    assert.deepStrictEqual(refined, {
      ...unknown,
      provider: "forgejo",
      webUrl: "http://git.example.test:3000/group/project",
    });
  }),
);
