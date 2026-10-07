import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

/**
 * A GitHub connection must be OAuth-authorized before it can mint tokens;
 * set GCP_TEST_CLOUDBUILD_REPO to a repository URL an authorized
 * connection can reach.
 */
export const remoteUri =
  process.env.GCP_TEST_CLOUDBUILD_REPO ??
  "https://github.com/octocat/Hello-World.git";

/** Linked repository the host reads tokens and refs for. */
export const Source = Effect.gen(function* () {
  const connection = yield* GCP.CloudBuild.Connection("Github", {
    githubConfig: {},
  });
  return yield* GCP.CloudBuild.Repository("Source", {
    connection: connection.name,
    remoteUri,
  });
});

/**
 * Effect-native Cloud Run service exercising every Cloud Build binding as
 * its own runtime service account. Deployed from
 * {@link ../Bindings.test.ts}.
 */
export default class CloudBuildBindingsHost extends GCP.Function<CloudBuildBindingsHost>()(
  "CloudBuildBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const readToken = yield* GCP.CloudBuild.AccessReadToken(Source);
    const readWriteToken = yield* GCP.CloudBuild.AccessReadWriteToken(Source);
    const fetchGitRefs = yield* GCP.CloudBuild.FetchGitRefs(Source);

    return {
      fetch: serveProbes({
        accessReadToken: readToken(),
        accessReadWriteToken: readWriteToken(),
        fetchGitRefs: fetchGitRefs({ refType: "BRANCH" }),
      }),
    };
  }).pipe(
    Effect.provide(GCP.CloudBuild.AccessReadTokenHttp),
    Effect.provide(GCP.CloudBuild.AccessReadWriteTokenHttp),
    Effect.provide(GCP.CloudBuild.FetchGitRefsHttp),
  ),
) {}
