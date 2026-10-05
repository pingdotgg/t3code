import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

/**
 * Git links need a connection whose GitHub App install is COMPLETE; a fresh
 * connection stays PENDING_USER_OAUTH and link create fails with BadRequest
 * ("connection must have installation_state COMPLETE"). Set
 * `GCP_TEST_DEVELOPERCONNECT_GITHUB_TOKEN_SECRET` (OAuth token secret
 * version) and `GCP_TEST_DEVELOPERCONNECT_GITHUB_INSTALLATION_ID` to run.
 * The values are forwarded to the host's environment so the deployed
 * runtime binds the same set.
 */
const githubTokenSecret =
  process.env.GCP_TEST_DEVELOPERCONNECT_GITHUB_TOKEN_SECRET ?? "";
const githubInstallationId =
  process.env.GCP_TEST_DEVELOPERCONNECT_GITHUB_INSTALLATION_ID ?? "";
export const linkEnabled = !!githubTokenSecret && !!githubInstallationId;

const cloneUri =
  process.env.GCP_DEVELOPERCONNECT_CLONE_URI ??
  "https://github.com/octocat/Hello-World.git";

/** GitHub connection; declared only when {@link linkEnabled}. */
export const Github = GCP.DeveloperConnect.Connection("Github", {
  githubConfig: {
    githubApp: "DEVELOPER_CONNECT",
    authorizerCredential: { oauthTokenSecretVersion: githubTokenSecret },
    appInstallationId: githubInstallationId,
  },
});

/** Repository link the bindings bind; declared only when {@link linkEnabled}. */
export const Source = Effect.gen(function* () {
  const github = yield* Github;
  return yield* GCP.DeveloperConnect.ConnectionsGitRepositoryLink("Source", {
    connection: github.name,
    cloneUri,
  });
});

const linkProbes = Effect.gen(function* () {
  const fetchReadToken = yield* GCP.DeveloperConnect.FetchReadToken(Source);
  const fetchReadWriteToken =
    yield* GCP.DeveloperConnect.FetchReadWriteToken(Source);
  const fetchGitRefs = yield* GCP.DeveloperConnect.FetchGitRefs(Source);
  return {
    fetchReadToken: fetchReadToken().pipe(
      Effect.map((read) => ({ hasToken: !!read.token })),
    ),
    fetchReadWriteToken: fetchReadWriteToken().pipe(
      Effect.map((write) => ({ hasToken: !!write.token })),
    ),
    fetchGitRefs: fetchGitRefs({ refType: "BRANCH" }),
  };
});

/**
 * Effect-native Cloud Run service exercising every Developer Connect binding
 * as its own runtime service account. Deployed from
 * {@link ../Bindings.test.ts}.
 */
export default class DeveloperConnectBindingsHost extends GCP.Function<DeveloperConnectBindingsHost>()(
  "DeveloperConnectBindingsHost",
  {
    main: import.meta.url,
    invokerIamDisabled: true,
    env: {
      GCP_TEST_DEVELOPERCONNECT_GITHUB_TOKEN_SECRET: githubTokenSecret,
      GCP_TEST_DEVELOPERCONNECT_GITHUB_INSTALLATION_ID: githubInstallationId,
      GCP_DEVELOPERCONNECT_CLONE_URI: cloneUri,
    },
  },
  Effect.gen(function* () {
    const link = linkEnabled ? yield* linkProbes : {};
    return { fetch: serveProbes({ ...link }) };
  }).pipe(
    Effect.provide(GCP.DeveloperConnect.FetchReadTokenHttp),
    Effect.provide(GCP.DeveloperConnect.FetchReadWriteTokenHttp),
    Effect.provide(GCP.DeveloperConnect.FetchGitRefsHttp),
  ),
) {}
