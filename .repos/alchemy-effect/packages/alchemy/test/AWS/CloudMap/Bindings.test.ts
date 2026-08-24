import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as sd from "@distilled.cloud/aws/servicediscovery";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import CloudMapTestFunctionLive, { CloudMapTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "CloudMapBindings");

const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let serviceId: string;
let customServiceId: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Retry transient 5xx from the shared fixture under parallel-suite load;
// genuine 4xx failures surface immediately.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
  );

class CloudMapOperationPending extends Data.TaggedError(
  "CloudMapOperationPending",
)<{ readonly operationId: string }> {}

/** Await a Cloud Map async operation out-of-band (bounded). */
const waitOperation = (operationId: string) =>
  sd.getOperation({ OperationId: operationId }).pipe(
    Effect.map((r) => r.Operation),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (op) => op?.Status === "SUCCESS" || op?.Status === "FAIL",
      times: 45,
    }),
    Effect.flatMap((op) =>
      op?.Status === "SUCCESS"
        ? Effect.void
        : Effect.fail(new CloudMapOperationPending({ operationId })),
    ),
  );

const registerOutOfBand = (instanceId: string, ipv4: string) =>
  sd
    .registerInstance({
      ServiceId: serviceId,
      InstanceId: instanceId,
      Attributes: { AWS_INSTANCE_IPV4: ipv4 },
    })
    .pipe(
      Effect.flatMap((r) =>
        r.OperationId !== undefined
          ? waitOperation(r.OperationId)
          : Effect.void,
      ),
    );

const deregisterOutOfBand = (instanceId: string, inServiceId?: string) =>
  sd
    .deregisterInstance({
      ServiceId: inServiceId ?? serviceId,
      InstanceId: instanceId,
    })
    .pipe(
      Effect.flatMap((r) =>
        r.OperationId !== undefined
          ? waitOperation(r.OperationId)
          : Effect.void,
      ),
      Effect.catchTag("InstanceNotFound", () => Effect.void),
    );

interface DiscoveredInstance {
  instanceId: string;
  healthStatus: string | undefined;
  attributes: Record<string, string>;
}

/** Call the deployed Lambda's /discover route (through the binding). */
const discoverViaLambda = Effect.gen(function* () {
  const response = yield* send(
    HttpClientRequest.get(`${baseUrl}/discover?health=ALL`),
  );
  const body = (yield* response.json) as unknown as {
    instances: DiscoveredInstance[];
  };
  return body.instances;
});

class UnexpectedInstances extends Data.TaggedError("UnexpectedInstances")<{
  readonly expected: string[];
  readonly actual: string[];
}> {}

/**
 * Poll the Lambda's /discover route until — restricted to the given id
 * prefix — exactly `expected` instance ids are visible (bounded; the
 * data-plane view is eventually consistent after register/deregister).
 */
const expectDiscovered = (prefix: string, expected: string[]) =>
  discoverViaLambda.pipe(
    Effect.flatMap((instances) => {
      const actual = instances
        .map((i) => i.instanceId)
        .filter((id): id is string => id !== undefined)
        .filter((id) => id.startsWith(prefix))
        .sort();
      const want = [...expected].sort();
      return actual.length === want.length &&
        actual.every((id, i) => id === want[i])
        ? Effect.succeed(instances)
        : Effect.fail(new UnexpectedInstances({ expected: want, actual }));
    }),
    Effect.retry({
      while: (e) => e._tag === "UnexpectedInstances",
      schedule: Schedule.max([
        Schedule.spaced("3 seconds"),
        Schedule.recurs(20),
      ]),
    }),
  );

class InstanceNotVisible extends Data.TaggedError("InstanceNotVisible")<{
  readonly instanceId: string;
}> {}

const expectInstanceState = (instanceId: string, present: boolean) =>
  sd.getInstance({ ServiceId: serviceId, InstanceId: instanceId }).pipe(
    Effect.map(() => true),
    Effect.catchTag("InstanceNotFound", () => Effect.succeed(false)),
    Effect.flatMap((exists) =>
      exists === present
        ? Effect.void
        : Effect.fail(new InstanceNotVisible({ instanceId })),
    ),
    Effect.retry({
      while: (e) => e._tag === "InstanceNotVisible",
      schedule: Schedule.max([
        Schedule.spaced("3 seconds"),
        Schedule.recurs(20),
      ]),
    }),
  );

describe("CloudMap Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "CloudMap test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("CloudMap test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* CloudMapTestFunction;
        }).pipe(Effect.provide(CloudMapTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      yield* Effect.logInfo(
        `CloudMap test setup: probing readiness at ${baseUrl}/info`,
      );
      // readiness = 200 AND the Output-backed env vars are visible. Lambda
      // applies the code update and the env-var configuration update
      // separately, so there is a brief window where the real handler serves
      // 200 while `FixtureService_*` env vars are still missing.
      const info = yield* HttpClient.get(`${baseUrl}/info`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? response.json
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.flatMap((body) =>
          (body as { serviceId?: string }).serviceId
            ? Effect.succeed(body)
            : Effect.fail(new Error("env vars not yet propagated")),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
      yield* Effect.logInfo(
        `CloudMap test setup: fixture info = ${JSON.stringify(info)}`,
      );
      serviceId = (info as { serviceId: string }).serviceId;
      customServiceId = (info as { customServiceId: string }).customServiceId;
      expect(serviceId).toBeTruthy();
      expect(customServiceId).toBeTruthy();
    }),
    { timeout: 300_000 },
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(
    // The out-of-band listInstances/deregisterInstance calls need the AWS
    // providers (Credentials/HttpClient/Region); afterAll effects run with
    // R=never, so provide them explicitly (Stack/Stage come from destroy()).
    Core.withProviders(
      Effect.gen(function* () {
        // deregister any instances the tests left behind so the services (and
        // then the namespace) can delete without ResourceInUse churn
        for (const cleanupServiceId of [serviceId, customServiceId]) {
          if (cleanupServiceId !== undefined) {
            const instances = yield* sd
              .listInstances({ ServiceId: cleanupServiceId })
              .pipe(
                Effect.map((r) => r.Instances ?? []),
                Effect.catchTag("ServiceNotFound", () => Effect.succeed([])),
              );
            yield* Effect.forEach(
              instances,
              (instance) =>
                instance.Id !== undefined
                  ? deregisterOutOfBand(instance.Id, cleanupServiceId)
                  : Effect.void,
              { concurrency: 4 },
            );
          }
        }
        yield* sharedStack.destroy();
      }),
      testOptions,
      "CloudMapBindings",
    ),
    { timeout: 240_000 },
  );

  describe("DiscoverInstances", () => {
    test.provider(
      "lambda discovers instances registered out-of-band; deregistration converges",
      (_stack) =>
        Effect.gen(function* () {
          // register two instances out-of-band via distilled
          yield* registerOutOfBand("disc-a", "10.0.0.1");
          yield* registerOutOfBand("disc-b", "10.0.0.2");

          // the deployed Lambda sees both through the DiscoverInstances binding
          const instances = yield* expectDiscovered("disc-", [
            "disc-a",
            "disc-b",
          ]);
          const discA = instances.find((i) => i.instanceId === "disc-a");
          expect(discA?.attributes.AWS_INSTANCE_IPV4).toBe("10.0.0.1");

          // deregister one; a bounded re-poll sees exactly the survivor
          yield* deregisterOutOfBand("disc-a");
          yield* expectDiscovered("disc-", ["disc-b"]);

          // cleanup
          yield* deregisterOutOfBand("disc-b");
          yield* expectInstanceState("disc-b", false);
        }),
      { timeout: 180_000 },
    );
  });

  describe("RegisterInstance", () => {
    test.provider(
      "lambda self-registers an instance through the binding",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/register`),
              {
                instanceId: "bind-reg",
                attributes: { AWS_INSTANCE_IPV4: "10.0.0.9" },
              },
            ),
          );
          expect(response.status).toBe(200);
          const body = (yield* response.json) as { operationId?: string };
          expect(body.operationId).toBeTruthy();

          // visible out-of-band once the async registration completes
          yield* expectInstanceState("bind-reg", true);
          const instance = yield* sd.getInstance({
            ServiceId: serviceId,
            InstanceId: "bind-reg",
          });
          expect(instance.Instance?.Attributes?.AWS_INSTANCE_IPV4).toBe(
            "10.0.0.9",
          );

          // cleanup
          yield* deregisterOutOfBand("bind-reg");
        }),
      { timeout: 180_000 },
    );
  });

  describe("DeregisterInstance", () => {
    test.provider(
      "lambda deregisters an instance through the binding",
      (_stack) =>
        Effect.gen(function* () {
          yield* registerOutOfBand("bind-dereg", "10.0.0.8");
          yield* expectInstanceState("bind-dereg", true);

          const response = yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/deregister`),
              { instanceId: "bind-dereg" },
            ),
          );
          expect(response.status).toBe(200);

          yield* expectInstanceState("bind-dereg", false);
        }),
      { timeout: 180_000 },
    );
  });

  describe("GetInstance + ListInstances", () => {
    test.provider(
      "lambda reads a registered instance through the control-plane bindings",
      (_stack) =>
        Effect.gen(function* () {
          yield* registerOutOfBand("read-a", "10.0.0.31");

          // GetInstance — full attribute map by id
          const single = yield* send(
            HttpClientRequest.get(`${baseUrl}/instance?id=read-a`),
          );
          expect(single.status).toBe(200);
          const singleBody = (yield* single.json) as {
            instanceId: string;
            attributes: Record<string, string>;
          };
          expect(singleBody.instanceId).toBe("read-a");
          expect(singleBody.attributes.AWS_INSTANCE_IPV4).toBe("10.0.0.31");

          // ListInstances — control-plane enumeration includes it
          const listed = yield* send(
            HttpClientRequest.get(`${baseUrl}/instances`),
          );
          expect(listed.status).toBe(200);
          const listedBody = (yield* listed.json) as {
            instances: { instanceId: string }[];
          };
          expect(listedBody.instances.map((i) => i.instanceId)).toContain(
            "read-a",
          );

          // cleanup
          yield* deregisterOutOfBand("read-a");
        }),
      { timeout: 180_000 },
    );
  });

  describe("DiscoverInstancesRevision", () => {
    test.provider(
      "lambda reads the instance-set revision through the binding",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/revision`),
          );
          expect(response.status).toBe(200);
          const body = (yield* response.json) as { revision: number };
          expect(typeof body.revision).toBe("number");
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetServiceAttributes", () => {
    test.provider(
      "lambda reads the service attributes declared on the Service resource",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/service-attributes`),
          );
          expect(response.status).toBe(200);
          const body = (yield* response.json) as {
            attributes: Record<string, string>;
          };
          expect(body.attributes).toEqual({ tier: "backend", version: "1" });
        }),
      { timeout: 120_000 },
    );
  });

  describe("UpdateInstanceCustomHealthStatus + GetInstancesHealthStatus + GetOperation", () => {
    test.provider(
      "lambda registers, awaits the operation, pushes custom health, and reads it back",
      (_stack) =>
        Effect.gen(function* () {
          // register an instance on the custom-health service via the binding
          const registered = yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/custom/register`),
              {
                instanceId: "cust-1",
                attributes: { AWS_INSTANCE_IPV4: "10.0.0.41" },
              },
            ),
          );
          expect(registered.status).toBe(200);
          const { operationId } = (yield* registered.json) as {
            operationId: string;
          };
          expect(operationId).toBeTruthy();

          // await the async registration THROUGH the GetOperation binding
          const operation = yield* send(
            HttpClientRequest.get(`${baseUrl}/operation?id=${operationId}`),
          ).pipe(
            Effect.flatMap((r) => r.json),
            Effect.map((body) => body as { status?: string }),
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (op): boolean =>
                op.status === "SUCCESS" || op.status === "FAIL",
              times: 45,
            }),
          );
          expect(operation.status).toBe("SUCCESS");

          const pushHealth = (status: "HEALTHY" | "UNHEALTHY") =>
            send(
              HttpClientRequest.bodyJsonUnsafe(
                HttpClientRequest.post(`${baseUrl}/custom/health`),
                { instanceId: "cust-1", status },
              ),
            );

          const readHealth = send(
            HttpClientRequest.get(`${baseUrl}/custom/health-status`),
          ).pipe(
            Effect.flatMap((r) => r.json),
            Effect.map(
              (body) =>
                (body as { status: Record<string, string | undefined> }).status[
                  "cust-1"
                ],
            ),
          );

          const expectHealth = (expected: "HEALTHY" | "UNHEALTHY") =>
            readHealth.pipe(
              Effect.repeat({
                schedule: Schedule.spaced("3 seconds"),
                until: (status): boolean => status === expected,
                times: 20,
              }),
              Effect.map((status) => expect(status).toBe(expected)),
            );

          // push UNHEALTHY then HEALTHY and observe both through the bindings
          yield* pushHealth("UNHEALTHY");
          yield* expectHealth("UNHEALTHY");
          yield* pushHealth("HEALTHY");
          yield* expectHealth("HEALTHY");

          // cleanup
          yield* deregisterOutOfBand("cust-1", customServiceId);
        }),
      { timeout: 300_000 },
    );
  });
});
