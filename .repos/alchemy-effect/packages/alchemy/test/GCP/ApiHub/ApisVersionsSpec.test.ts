import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as apihub from "@distilled.cloud/gcp/apihub_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Needs a provisioned API Hub instance in us-central1 (one per project,
// behind a host project registration); without one writes fail with
// BadRequest ("Invalid resource state … API Hub instance …"). Set
// GCP_TEST_APIHUB_INSTANCE=1 when the hub exists.
const runLifecycle = !!process.env.GCP_TEST_APIHUB_INSTANCE;
const location = "us-central1";

const openApiV1 = `openapi: 3.0.0
info:
  title: pets
  version: 1.0.0
paths:
  /pets:
    get:
      operationId: listPets
      responses:
        "200":
          description: ok
`;

const openApiV2 = `openapi: 3.0.0
info:
  title: pets
  version: 2.0.0
paths:
  /pets:
    get:
      operationId: listPets
      responses:
        "200":
          description: ok
  /pets/{id}:
    get:
      operationId: getPet
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: ok
`;

const waitUntilGone = (name: string) =>
  apihub.getProjectsLocationsApisVersionsSpecs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsApisVersionsSpecs on a missing spec fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apihub.getProjectsLocationsApisVersionsSpecs({
          name: `projects/${project}/locations/${location}/apis/alchemy-missing/versions/v1/specs/openapi`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apihub", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an API Hub spec",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* GCP.ApiHub.Api("Pets", {
            location,
            displayName: "pets",
          });
          const version = yield* GCP.ApiHub.ApisVersion("V1", {
            api: api.name,
            location,
            displayName: "v1",
          });
          const spec = yield* GCP.ApiHub.ApisVersionsSpec("OpenApi", {
            version: version.name,
            location,
            displayName: "openapi.yaml",
            contents: {
              contents: openApiV1,
              mimeType: "application/yaml",
            },
          });
          return { api, version, spec };
        }),
      );

      expect(created.spec.name).toContain("/specs/");
      expect(created.spec.version).toEqual(created.version.name);
      expect(created.spec.displayName).toEqual("openapi.yaml");

      const fetched = yield* apihub.getProjectsLocationsApisVersionsSpecs({
        name: created.spec.name,
      });
      expect(fetched.name).toEqual(created.spec.name);
      expect(fetched.displayName).toContain("alchemy-");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* GCP.ApiHub.Api("Pets", {
            apiId: created.api.apiId,
            location,
            displayName: "pets",
          });
          const version = yield* GCP.ApiHub.ApisVersion("V1", {
            api: api.name,
            versionId: created.version.versionId,
            location,
            displayName: "v1",
          });
          const spec = yield* GCP.ApiHub.ApisVersionsSpec("OpenApi", {
            version: version.name,
            specId: created.spec.specId,
            location,
            displayName: "openapi-v2.yaml",
            contents: {
              contents: openApiV2,
              mimeType: "application/yaml",
            },
          });
          return { api, version, spec };
        }),
      );

      expect(updated.spec.name).toEqual(created.spec.name);
      expect(updated.spec.displayName).toEqual("openapi-v2.yaml");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.spec.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:apihub", "live"], timeout: 90_000 },
);
