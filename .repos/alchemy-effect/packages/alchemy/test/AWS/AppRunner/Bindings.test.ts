import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as apprunner from "@distilled.cloud/aws/apprunner";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import AppRunnerTestFunctionLive, {
  AppRunnerTestFunction,
} from "./fixtures/handler";

const { test } = Test.make({ providers: AWS.providers() });

/** Poll the service status out-of-band until it settles to `expected`. */
const waitForStatus = (serviceArn: string, expected: string) =>
  apprunner.describeService({ ServiceArn: serviceArn }).pipe(
    Effect.flatMap((r) =>
      (r.Service.Status ?? "").toUpperCase() === expected
        ? Effect.void
        : Effect.fail(
            new Error(
              `service is ${r.Service.Status}, waiting for ${expected}`,
            ),
          ),
    ),
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("10 seconds"),
        Schedule.recurs(36),
      ]),
    }),
  );

// The fixture deploys a real App Runner service (3-5 min provisioning,
// bills while running) plus a Lambda wired to it through the four runtime
// bindings, so the whole flow is gated behind AWS_TEST_SLOW=1 and always
// destroys what it created.
test.provider.skipIf(!process.env.AWS_TEST_SLOW)(
  "a Lambda manages an App Runner service through the runtime bindings",
  (stack) =>
    Effect.gen(function* () {
      // Clean slate in case a previous run died mid-flight.
      yield* stack.destroy();

      const { functionUrl } = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AppRunnerTestFunction;
        }).pipe(Effect.provide(AppRunnerTestFunctionLive)),
      );
      expect(functionUrl).toBeTruthy();
      const baseUrl = functionUrl!.replace(/\/+$/, "");

      // Readiness probe — fresh function URLs take seconds to serve 200s,
      // and the fresh IAM role's apprunner permissions propagate eventually.
      yield* HttpClient.get(`${baseUrl}/ping`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.fixed("2 seconds"),
            Schedule.recurs(60),
          ]),
        }),
      );

      // ListOperations: the CREATE_SERVICE operation is on the record.
      const operations = yield* HttpClient.get(`${baseUrl}/operations`).pipe(
        Effect.flatMap((response) => response.json),
        Effect.map(
          (json) =>
            json as {
              operations: { id?: string; type?: string; status?: string }[];
            },
        ),
        // The Lambda role's apprunner:ListOperations grant propagates
        // eventually — a 500 body parses as not-matching and retries.
        Effect.filterOrFail(
          (json) => Array.isArray(json.operations),
          () => new Error("operations not yet listable"),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.exponential("1 second"),
            Schedule.recurs(8),
          ]),
        }),
      );
      const createOp = operations.operations.find(
        (op) => op.type === "CREATE_SERVICE",
      );
      expect(createOp).toBeDefined();
      expect(createOp?.status).toBe("SUCCEEDED");

      // DescribeCustomDomains: no domain is associated, so the list is
      // empty but the DNSTarget (the service's default endpoint) resolves —
      // proving the binding's wiring and IAM grant.
      const customDomains = yield* HttpClient.get(
        `${baseUrl}/custom-domains`,
      ).pipe(
        Effect.flatMap((response) => response.json),
        Effect.map(
          (json) =>
            json as {
              dnsTarget?: string;
              customDomains: { domainName?: string; status?: string }[];
            },
        ),
        Effect.filterOrFail(
          (json) => Array.isArray(json.customDomains),
          () => new Error("custom domains not yet describable"),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.exponential("1 second"),
            Schedule.recurs(8),
          ]),
        }),
      );
      expect(customDomains.customDomains).toEqual([]);
      expect(customDomains.dnsTarget).toContain("awsapprunner.com");

      // PauseService: the service settles to PAUSED.
      const paused = yield* HttpClient.execute(
        HttpClientRequest.post(`${baseUrl}/pause`),
      ).pipe(
        Effect.flatMap((response) => response.json),
        Effect.map(
          (json) => json as { serviceArn: string; operationId?: string },
        ),
      );
      expect(paused.serviceArn).toContain(
        ":service/alchemy-test-apprunner-bind/",
      );
      yield* waitForStatus(paused.serviceArn, "PAUSED");

      // ResumeService: the service settles back to RUNNING.
      const resumed = yield* HttpClient.execute(
        HttpClientRequest.post(`${baseUrl}/resume`),
      ).pipe(
        Effect.flatMap((response) => response.json),
        Effect.map(
          (json) => json as { serviceArn: string; operationId?: string },
        ),
      );
      expect(resumed.serviceArn).toBe(paused.serviceArn);
      yield* waitForStatus(paused.serviceArn, "RUNNING");

      // StartDeployment: returns an operation id; the deployment then shows
      // up in ListOperations. (The provider's delete waits for the service
      // to settle, so the in-flight deployment doesn't block destroy.)
      const deployed = yield* HttpClient.execute(
        HttpClientRequest.post(`${baseUrl}/deploy`),
      ).pipe(
        Effect.flatMap((response) => response.json),
        Effect.map((json) => json as { operationId?: string }),
      );
      expect(deployed.operationId).toBeTruthy();

      const afterDeploy = yield* HttpClient.get(`${baseUrl}/operations`).pipe(
        Effect.flatMap((response) => response.json),
        Effect.map(
          (json) => json as { operations: { id?: string; type?: string }[] },
        ),
      );
      expect(
        afterDeploy.operations.some((op) => op.id === deployed.operationId),
      ).toBe(true);

      // Destroy immediately — App Runner services bill while running.
      yield* stack.destroy();
      const after = yield* apprunner
        .describeService({ ServiceArn: paused.serviceArn })
        .pipe(
          Effect.map((r) => (r.Service.Status ?? "UNKNOWN").toUpperCase()),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed("GONE" as const),
          ),
        );
      expect(["GONE", "DELETED"]).toContain(after);
    }),
  // create (~3-5 min) + pause (~1-2 min) + resume (~1-2 min) + delete
  // (~2-3 min), one sequential test.
  { timeout: 1_200_000 },
);
