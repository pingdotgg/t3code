import { SourceControlSignInError, type SourceControlProviderKind } from "@t3tools/contracts";
import {
  defineSourceControlDriver,
  withOwnServices,
  type SourceControlSignIn,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { definition } from "../shared/definition.ts";

import * as GitHubAppAccess from "./GitHubAppAccess.ts";
import * as GitHubAppSignIn from "./GitHubAppSignIn.ts";
import * as GitHubMediaFetch from "./gitHubMediaFetch.ts";
import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
import * as GitHubPullRequestProvider from "./GitHubPullRequestProvider.ts";
import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";

// `GitHubRest.layerWithDependencies` carries the quota reserve every GitHub reader shares, so it
// must be built once; the driver is.
const services = GitHubPullRequestApi.layer.pipe(
  Layer.provideMerge(GitHubAppAccess.layer),
  Layer.provideMerge(GitHubRest.layerWithDependencies),
);

const makeSignIn = Effect.gen(function* () {
  const appSignIn = yield* GitHubAppSignIn.GitHubAppSignIn;
  const appAccess = yield* GitHubAppAccess.GitHubAppAccess;
  const kind: SourceControlProviderKind = definition.kind;
  return {
    start: appSignIn.start,
    wait: (host) =>
      appSignIn.wait(host).pipe(
        Effect.andThen(
          appAccess.viewer(host).pipe(
            Effect.mapError(
              (cause) =>
                new SourceControlSignInError({
                  provider: kind,
                  host,
                  reason: "failed",
                  detail: "Signed in, but GitHub would not say which account it belongs to.",
                  cause,
                }),
            ),
          ),
        ),
        Effect.map((account) => ({ account })),
      ),
    cancel: appSignIn.cancel,
    access: appAccess.reach,
  } satisfies SourceControlSignIn;
});

const makeInstance = Effect.all({
  sourceControl: GitHubSourceControlProvider.make,
  discovery: GitHubSourceControlProvider.makeDiscovery,
  pullRequests: GitHubPullRequestProvider.make,
  fetchMedia: GitHubMediaFetch.make,
  signIn: makeSignIn,
});

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(makeInstance, services),
});
