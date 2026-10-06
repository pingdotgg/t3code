import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as cloudbuild from "@distilled.cloud/gcp/cloudbuild_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);
const remoteUri =
  process.env.GCP_CLOUDBUILD_REMOTE_URI ??
  "https://github.com/octocat/Hello-World.git";
const standingConnection = process.env.GCP_CLOUDBUILD_CONNECTION;
const runLifecycle = !!standingConnection && !process.env.FAST;

const waitUntilRepositoryGone = (name: string) =>
  cloudbuild.getProjectsLocationsConnectionsRepositories({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const waitUntilConnectionGone = (name: string) =>
  cloudbuild.getProjectsLocationsConnections({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "get and binding ops on a missing repository are NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const missingRepositoryName = `projects/${project}/locations/us-central1/connections/alchemy-missing-connection/repositories/alchemy-missing-repository`;
      yield* stack.destroy();

      const getError = yield* Effect.flip(
        cloudbuild.getProjectsLocationsConnectionsRepositories({
          name: missingRepositoryName,
        }),
      );
      expect(getError._tag).toBe("NotFound");

      const readError = yield* Effect.flip(
        cloudbuild.accessReadTokenProjectsLocationsConnectionsRepositories({
          repository: missingRepositoryName,
          body: {},
        }),
      );
      expect(readError._tag).toBe("NotFound");

      const writeError = yield* Effect.flip(
        cloudbuild.accessReadWriteTokenProjectsLocationsConnectionsRepositories(
          {
            repository: missingRepositoryName,
            body: {},
          },
        ),
      );
      expect(writeError._tag).toBe("NotFound");

      const refsError = yield* Effect.flip(
        cloudbuild.fetchGitRefsProjectsLocationsConnectionsRepositories({
          repository: missingRepositoryName,
          refType: "BRANCH",
        }),
      );
      expect(refsError._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudbuild", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create repository on a pending GitHub connection is BadRequest",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const connection = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudBuild.Connection("Github", {
            location: "us-central1",
            githubConfig: {},
          });
        }),
      );

      const error = yield* Effect.flip(
        cloudbuild.createProjectsLocationsConnectionsRepositories({
          parent: connection.name,
          repositoryId: "alchemy-probe-source",
          body: { remoteUri },
        }),
      );
      expect(error._tag).toBe("BadRequest");
      expect(error.message.toLowerCase()).toContain("installation");

      yield* stack.destroy();

      const gone = yield* waitUntilConnectionGone(connection.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudbuild", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, replace, and delete a repository",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudBuild.Repository("Source", {
            connection: standingConnection!,
            remoteUri,
            annotations: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/repositories/");
      expect(created.repositoryId).toEqual(expect.any(String));
      expect(created.connection).toContain("/connections/");
      expect(created.location).toEqual(expect.any(String));
      expect(created.remoteUri).toEqual(remoteUri);
      expect(created.annotations).toMatchObject({ env: "test" });

      const fetched =
        yield* cloudbuild.getProjectsLocationsConnectionsRepositories({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.remoteUri).toEqual(remoteUri);
      expect(fetched.annotations?.env).toEqual("test");
      expect(fetched.annotations?.["alchemy-id"]).toEqual(expect.any(String));

      const listed =
        yield* cloudbuild.listProjectsLocationsConnectionsRepositories({
          parent: created.connection,
        });
      expect(
        (listed.repositories ?? []).some(
          (repository) => repository.name === created.name,
        ),
      ).toEqual(true);

      const readToken =
        yield* cloudbuild.accessReadTokenProjectsLocationsConnectionsRepositories(
          {
            repository: created.name,
            body: {},
          },
        );
      expect(readToken.token).toEqual(expect.any(String));
      expect((readToken.token ?? "").length).toBeGreaterThan(0);

      const writeToken =
        yield* cloudbuild.accessReadWriteTokenProjectsLocationsConnectionsRepositories(
          {
            repository: created.name,
            body: {},
          },
        );
      expect(writeToken.token).toEqual(expect.any(String));
      expect((writeToken.token ?? "").length).toBeGreaterThan(0);

      const refs =
        yield* cloudbuild.fetchGitRefsProjectsLocationsConnectionsRepositories({
          repository: created.name,
          refType: "BRANCH",
        });
      // Every repository has at least its default branch.
      expect(refs.refNames?.length ?? 0).toBeGreaterThan(0);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.CloudBuild.Repository("Source", {
            connection: standingConnection!,
            repositoryId: created.repositoryId,
            remoteUri,
            annotations: { env: "prod", role: "source" },
          });
        }),
      );

      expect(replaced.repositoryId).toEqual(created.repositoryId);
      expect(replaced.connection).toEqual(created.connection);
      expect(replaced.annotations).toMatchObject({
        env: "prod",
        role: "source",
      });

      const fetchedReplace =
        yield* cloudbuild.getProjectsLocationsConnectionsRepositories({
          name: replaced.name,
        });
      expect(fetchedReplace.annotations?.env).toEqual("prod");
      expect(fetchedReplace.annotations?.role).toEqual("source");

      yield* stack.destroy();

      const gone = yield* waitUntilRepositoryGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:cloudbuild", "live"],
    timeout: 90_000,
  },
);
