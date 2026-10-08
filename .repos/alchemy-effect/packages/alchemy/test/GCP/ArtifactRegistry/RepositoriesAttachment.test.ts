import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as artifactregistry from "@distilled.cloud/gcp/artifactregistry_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const PACKAGE_ID = "sbom";
const VERSION_ID = "1.0.0";
const FILENAME = "sbom.json";
const BODY = new TextEncoder().encode('{"spdxVersion":"SPDX-2.3"}');

const waitUntilGone = (name: string) =>
  artifactregistry.getProjectsLocationsRepositoriesAttachments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const waitForFile = (name: string) =>
  artifactregistry.getProjectsLocationsRepositoriesFiles({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("missing" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "found",
      times: 10,
    }),
  );

const uploadFile = (repositoryName: string) =>
  Effect.gen(function* () {
    const creds = yield* yield* Credentials;
    const client = yield* HttpClient.HttpClient;
    const url =
      `https://artifactregistry.googleapis.com/upload/v1/${repositoryName}/genericArtifacts:create` +
      `?uploadType=media&filename=${FILENAME}&packageId=${PACKAGE_ID}&versionId=${VERSION_ID}`;
    const response = yield* client.execute(
      HttpClientRequest.post(url).pipe(
        HttpClientRequest.setHeader(
          "Authorization",
          `Bearer ${Redacted.value(creds.accessToken)}`,
        ),
        HttpClientRequest.bodyUint8Array(BODY, "application/json"),
      ),
    );
    if (response.status === 409) return;
    if (response.status < 200 || response.status >= 300) {
      const body = yield* response.text.pipe(
        Effect.catch(() => Effect.succeed("")),
      );
      return yield* Effect.fail(
        new Error(`generic artifact upload failed: ${response.status} ${body}`),
      );
    }
  }).pipe(
    Effect.retry({
      times: 5,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

test.provider.skipIf(!!process.env.FAST)(
  "create, replace, and delete a repository attachment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const repo = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ArtifactRegistry.Repository("Generic", {
            location: "us-central1",
            format: "GENERIC",
            description: "attachment parent",
          });
        }),
      );

      yield* uploadFile(repo.name);
      const fileName = `${repo.name}/files/${PACKAGE_ID}:${VERSION_ID}:${FILENAME}`;
      const versionName = `${repo.name}/packages/${PACKAGE_ID}/versions/${VERSION_ID}`;
      const file = yield* waitForFile(fileName);
      expect(file).toEqual("found");

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const artifacts = yield* GCP.ArtifactRegistry.Repository("Generic", {
            repositoryId: repo.repositoryId,
            location: "us-central1",
            format: "GENERIC",
            description: "attachment parent",
          });
          const attachment = yield* GCP.ArtifactRegistry.RepositoriesAttachment(
            "Sbom",
            {
              repository: artifacts.name,
              target: versionName,
              type: "application/spdx+json",
              files: [fileName],
              annotations: { env: "test" },
            },
          );
          return { artifacts, attachment };
        }),
      );

      expect(created.attachment.name).toContain("/attachments/");
      expect(created.attachment.repository).toEqual(created.artifacts.name);
      expect(created.attachment.target).toEqual(versionName);
      expect(created.attachment.type).toEqual("application/spdx+json");
      expect(created.attachment.annotations).toMatchObject({ env: "test" });
      expect(created.attachment.files.length).toBeGreaterThan(0);

      const fetched =
        yield* artifactregistry.getProjectsLocationsRepositoriesAttachments({
          name: created.attachment.name,
        });
      expect(fetched.name).toEqual(created.attachment.name);
      expect(fetched.annotations?.env).toEqual("test");
      expect(fetched.annotations?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const artifacts = yield* GCP.ArtifactRegistry.Repository("Generic", {
            repositoryId: repo.repositoryId,
            location: "us-central1",
            format: "GENERIC",
            description: "attachment parent",
          });
          const attachment = yield* GCP.ArtifactRegistry.RepositoriesAttachment(
            "Sbom",
            {
              repository: artifacts.name,
              attachmentId: created.attachment.attachmentId,
              target: versionName,
              type: "application/spdx+json",
              files: [fileName],
              annotations: { env: "prod", role: "sbom" },
            },
          );
          return { artifacts, attachment };
        }),
      );

      expect(updated.attachment.annotations).toMatchObject({
        env: "prod",
        role: "sbom",
      });

      const refetched =
        yield* artifactregistry.getProjectsLocationsRepositoriesAttachments({
          name: updated.attachment.name,
        });
      expect(refetched.annotations?.env).toEqual("prod");
      expect(refetched.annotations?.role).toEqual("sbom");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(updated.attachment.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:artifactregistry", "live"],
    timeout: 180_000,
  },
);
