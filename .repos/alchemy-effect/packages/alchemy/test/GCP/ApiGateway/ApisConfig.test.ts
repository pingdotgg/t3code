import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as apigateway from "@distilled.cloud/gcp/apigateway_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "@/GCP/Environment";
import { waitForOperation } from "@/GCP/Operation";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// API create LRO ~2m14s and delete ~2m51s; config create is similarly
// slow, so the lifecycle runs past 5 minutes.
const runLifecycle = !!process.env.GCP_TEST_SLOW && !process.env.FAST;
const parentOf = (project: string) => `projects/${project}/locations/global`;
const parentApiId = "alch-apigw-cfg";
const parentApiNameOf = (project: string) =>
  `${parentOf(project)}/apis/${parentApiId}`;

const openApi = `swagger: "2.0"
info:
  title: alchemy-apigateway-test
  description: alchemy test
  version: "1.0.0"
schemes:
  - https
produces:
  - application/json
paths:
  /hello:
    get:
      summary: hello
      operationId: helloGet
      x-google-backend:
        address: https://httpbin.org/get
      responses:
        "200":
          description: A successful response
`;

const waitUntilGone = (name: string) =>
  apigateway.getProjectsLocationsApisConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const getApi = (name: string) =>
  apigateway
    .getProjectsLocationsApis({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitApiActive = (name: string) =>
  getApi(name).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (api) =>
        api !== undefined && (api.state === "ACTIVE" || api.state === "FAILED"),
      times: 10,
    }),
  );

const waitOperation = (operation: apigateway.ApigatewayOperation) =>
  waitForOperation(
    operation,
    (name) => apigateway.getProjectsLocationsOperations({ name }),
    { budget: "10 minutes" },
  );

const ensureParentApi = Effect.gen(function* () {
  const { project } = yield* GcpEnvironment.current;
  const parent = parentOf(project);
  const parentApiName = parentApiNameOf(project);
  const existing = yield* getApi(parentApiName);
  if (existing !== undefined) {
    if (existing.state !== "ACTIVE") {
      yield* waitApiActive(parentApiName);
    }
    return parentApiName;
  }
  const created = yield* apigateway
    .createProjectsLocationsApis({
      parent,
      apiId: parentApiId,
      body: { displayName: parentApiId },
    })
    .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
  if (created !== undefined) {
    yield* waitOperation(created);
  }
  yield* waitApiActive(parentApiName);
  return parentApiName;
});

const deleteParentApi = Effect.gen(function* () {
  const { project } = yield* GcpEnvironment.current;
  const parentApiName = parentApiNameOf(project);
  const operation = yield* apigateway
    .deleteProjectsLocationsApis({ name: parentApiName })
    .pipe(
      Effect.retry({
        while: (error) => error._tag === "Conflict",
        times: 8,
        schedule: Schedule.spaced("2 seconds"),
      }),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );
  if (operation !== undefined) {
    yield* waitOperation(operation);
  }
});

test.provider(
  "getProjectsLocationsApisConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = parentOf(project);
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigateway.getProjectsLocationsApisConfigs({
          name: `${parent}/apis/missing/configs/alchemy-missing-config`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:apigateway", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an API Gateway API config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const api = yield* ensureParentApi;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ApiGateway.ApisConfig("V1", {
            api,
            displayName: "v1",
            openapiDocuments: [
              {
                document: {
                  path: "openapi.yaml",
                  contents: openApi,
                },
              },
            ],
            labels: { env: "test" },
          });
        }),
      );

      expect(created.apiConfigId).toEqual(expect.any(String));
      expect(created.api).toEqual(api);
      expect(created.location).toEqual("global");
      expect(created.displayName).toEqual("v1");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.name).toEqual(`${api}/configs/${created.apiConfigId}`);

      const fetched = yield* apigateway.getProjectsLocationsApisConfigs({
        name: created.name,
        view: "FULL",
      });
      // The API reports the project number in names; the resource keeps the
      // project-id form it was addressed by.
      expect(fetched.name).toEqual(
        expect.stringMatching(
          new RegExp(`/apis/[^/]+/configs/${created.apiConfigId}$`),
        ),
      );
      expect(fetched.displayName).toEqual("v1");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.ApiGateway.ApisConfig("V1", {
            api,
            apiConfigId: created.apiConfigId,
            displayName: "v1-prod",
            openapiDocuments: [
              {
                document: {
                  path: "openapi.yaml",
                  contents: openApi,
                },
              },
            ],
            labels: { env: "prod", team: "gateway" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("v1-prod");
      expect(updated.labels).toMatchObject({ env: "prod", team: "gateway" });

      const fetchedUpdate = yield* apigateway.getProjectsLocationsApisConfigs({
        name: updated.name,
      });
      expect(fetchedUpdate.displayName).toEqual("v1-prod");
      expect(fetchedUpdate.labels?.team).toEqual("gateway");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(
      logLevel,
      Effect.ensuring(
        stack.destroy().pipe(Effect.andThen(deleteParentApi), Effect.ignore),
      ),
    ),
  {
    tags: ["provider:gcp", "provider:gcp:apigateway", "live"],
    timeout: 900_000,
    retry: 0,
  },
);
