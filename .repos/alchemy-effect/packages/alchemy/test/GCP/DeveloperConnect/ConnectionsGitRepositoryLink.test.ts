import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as developerconnect from "@distilled.cloud/gcp/developerconnect_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

// Git links need a connection whose GitHub App install is COMPLETE; a fresh
// connection stays PENDING_USER_OAUTH and link create fails with BadRequest
// ("connection must have installation_state COMPLETE"). Set
// GCP_TEST_DEVELOPERCONNECT_GITHUB_TOKEN_SECRET (OAuth token secret version)
// and GCP_TEST_DEVELOPERCONNECT_GITHUB_INSTALLATION_ID to run.
const githubTokenSecret =
  process.env.GCP_TEST_DEVELOPERCONNECT_GITHUB_TOKEN_SECRET;
const githubInstallationId =
  process.env.GCP_TEST_DEVELOPERCONNECT_GITHUB_INSTALLATION_ID;
const runLinkLifecycle = !!githubTokenSecret && !!githubInstallationId;
const githubConfig = {
  githubApp: "DEVELOPER_CONNECT",
  authorizerCredential: { oauthTokenSecretVersion: githubTokenSecret },
  appInstallationId: githubInstallationId,
};

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const cloneUri =
  process.env.GCP_DEVELOPERCONNECT_CLONE_URI ??
  "https://github.com/octocat/Hello-World.git";

const waitUntilGone = (name: string) =>
  developerconnect
    .getProjectsLocationsConnectionsGitRepositoryLinks({ name })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

const waitUntilConnectionGone = (name: string) =>
  developerconnect.getProjectsLocationsConnections({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsConnectionsGitRepositoryLinks on a missing link fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        developerconnect.getProjectsLocationsConnectionsGitRepositoryLinks({
          name: `projects/${project}/locations/us-central1/connections/alchemy-missing-connection/gitRepositoryLinks/alchemy-missing-link`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:developerconnect", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLinkLifecycle)(
  "create, update, replace, and delete a git repository link",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const github = yield* GCP.DeveloperConnect.Connection("Github", {
            location: "us-central1",
            githubConfig,
            labels: { env: "test" },
          });
          const source =
            yield* GCP.DeveloperConnect.ConnectionsGitRepositoryLink("Source", {
              connection: github.name,
              cloneUri,
              labels: { env: "test" },
            });
          return { github, source };
        }),
      );

      expect(created.source.gitRepositoryLinkId).toEqual(expect.any(String));
      expect(created.source.name).toContain("/gitRepositoryLinks/");
      expect(created.source.connection).toEqual(created.github.name);
      expect(created.source.cloneUri).toEqual(cloneUri);
      expect(created.source.labels).toMatchObject({ env: "test" });

      const fetched =
        yield* developerconnect.getProjectsLocationsConnectionsGitRepositoryLinks(
          {
            name: created.source.name,
          },
        );
      expect(fetched.name).toEqual(created.source.name);
      expect(fetched.cloneUri).toEqual(cloneUri);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const github = yield* GCP.DeveloperConnect.Connection("Github", {
            connectionId: created.github.connectionId,
            location: "us-central1",
            githubConfig,
            labels: { env: "test" },
          });
          const source =
            yield* GCP.DeveloperConnect.ConnectionsGitRepositoryLink("Source", {
              connection: github.name,
              gitRepositoryLinkId: created.source.gitRepositoryLinkId,
              cloneUri,
              labels: { env: "prod", role: "source" },
            });
          return { github, source };
        }),
      );

      expect(updated.source.connection).toEqual(created.github.name);
      expect(updated.source.labels).toMatchObject({
        env: "prod",
        role: "source",
      });

      const fetchedUpdate =
        yield* developerconnect.getProjectsLocationsConnectionsGitRepositoryLinks(
          {
            name: updated.source.name,
          },
        );
      expect(fetchedUpdate.labels?.env).toEqual("prod");
      expect(fetchedUpdate.labels?.role).toEqual("source");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(updated.source.name);
      expect(gone).toEqual("gone");
      const connectionGone = yield* waitUntilConnectionGone(
        created.github.name,
      );
      expect(connectionGone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:developerconnect", "live"],
    timeout: 90_000,
  },
);
