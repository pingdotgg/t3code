import { SourceControlProviderKind } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as BitbucketServerApi from "./BitbucketServerApi.ts";
import * as BitbucketServerSourceControlProvider from "./BitbucketServerSourceControlProvider.ts";

function makeProvider(bitbucket: Partial<BitbucketServerApi.BitbucketServerApi["Service"]>) {
  return BitbucketServerSourceControlProvider.make.pipe(
    Effect.provide(Layer.mock(BitbucketServerApi.BitbucketServerApi)(bitbucket)),
  );
}

it.effect("maps Data Center pull requests into bitbucket-server change requests", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequest: () =>
        Effect.succeed({
          number: 1,
          title: "Fixture PR",
          url: "https://bitbucket.example.com/projects/PROJ/repos/web/pull-requests/1",
          baseRefName: "main",
          headRefName: "feature/dc-fixture",
          state: "open",
          isDraft: true,
          updatedAt: Option.none(),
          headRepositoryNameWithOwner: "PROJ/web",
          headRepositoryOwnerLogin: "PROJ",
        }),
    });

    const changeRequest = yield* provider.getChangeRequest({ cwd: "/repo", reference: "1" });

    assert.deepStrictEqual(changeRequest, {
      provider: SourceControlProviderKind.make("bitbucket-server"),
      number: 1,
      title: "Fixture PR",
      url: "https://bitbucket.example.com/projects/PROJ/repos/web/pull-requests/1",
      baseRefName: "main",
      headRefName: "feature/dc-fixture",
      state: "open",
      isDraft: true,
      updatedAt: Option.none(),
      headRepositoryNameWithOwner: "PROJ/web",
      headRepositoryOwnerLogin: "PROJ",
    });
  }),
);

it.effect("wraps API failures with the operation while keeping the cause", () =>
  Effect.gen(function* () {
    const cause = new BitbucketServerApi.BitbucketServerHostMismatchError({
      remoteHost: "bitbucket.other.example",
      configuredHost: "bitbucket.example.com",
    });
    const provider = yield* makeProvider({
      getDefaultBranch: () => Effect.fail(cause),
    });

    const error = yield* provider.getDefaultBranch({ cwd: "/repo" }).pipe(Effect.flip);

    assert.strictEqual(error.provider, "bitbucket-server");
    assert.strictEqual(error.operation, "getDefaultBranch");
    assert.strictEqual(error.cause, cause);
  }),
);

it.effect("shows why a configured token was refused instead of the setup hint", () =>
  Effect.gen(function* () {
    const refused = {
      status: "unauthenticated" as const,
      account: Option.none(),
      host: Option.some("bitbucket.example.com"),
      detail: Option.some("bitbucket.example.com rejected the configured token (HTTP 401)."),
    };
    const unconfigured = {
      status: "unauthenticated" as const,
      account: Option.none(),
      host: Option.none(),
      detail: Option.some(BitbucketServerApi.CONFIGURATION_HINT),
    };
    const probe = (auth: typeof refused | typeof unconfigured) =>
      BitbucketServerSourceControlProvider.makeDiscovery.pipe(
        Effect.flatMap((spec) => spec.probeAuth),
        Effect.provide(
          Layer.mock(BitbucketServerApi.BitbucketServerApi)({ probeAuth: Effect.succeed(auth) }),
        ),
      );

    assert.deepStrictEqual(yield* probe(refused), { ...refused, status: "unknown" });
    assert.deepStrictEqual(yield* probe(unconfigured), unconfigured);
  }),
);

it.effect("uses the configured web origin for SSH identities and strips clone mounts", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      resolveRemote: () =>
        Effect.succeed({
          baseUrl: "https://code.example.com:8443/bitbucket",
          repository: "PROJ/web",
        }),
    });
    const refine = provider.refineRepositoryIdentity;
    assert.isDefined(refine);
    for (const remoteUrl of [
      "ssh://git@code.example.com:7999/PROJ/web.git",
      "https://code.example.com:8443/bitbucket/scm/PROJ/web.git",
    ]) {
      const identity = {
        canonicalKey: "code.example.com/proj/web",
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl,
        },
      };
      const result = yield* refine!({ identity, resolveContext: () => Effect.die("unused") });
      assert.deepStrictEqual(result, {
        ...identity,
        provider: SourceControlProviderKind.make("bitbucket-server"),
        displayName: "PROJ/web",
        owner: "PROJ",
        name: "web",
        webUrl: "https://code.example.com:8443/bitbucket/projects/PROJ/repos/web",
      });
      const other = { ...identity, provider: SourceControlProviderKind.make("github") };
      assert.strictEqual(
        yield* refine!({ identity: other, resolveContext: () => Effect.die("unused") }),
        other,
      );
    }
  }),
);
