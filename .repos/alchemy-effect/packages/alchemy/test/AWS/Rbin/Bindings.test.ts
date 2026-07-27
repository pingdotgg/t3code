import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import RbinTestFunctionLive, { RbinTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "RbinBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The Lambda fixture occasionally answers a transient 5xx under load (cold
// re-init, IAM propagation on the freshly attached policy that the handler's
// `Effect.orDie` surfaces as a 500). Retry only 5xx; a genuine 4xx/assertion
// failure surfaces immediately.
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

const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

describe.sequential("Rbin Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("Rbin test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Rbin test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* RbinTestFunction;
        }).pipe(Effect.provide(RbinTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `Rbin test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Rbin test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("binding registration", () => {
    test.provider("both capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toEqual(["getRule", "listRules"]);
      }),
    );
  });

  describe("GetRule", () => {
    test.provider(
      "reads the bound rule's detail (injected identifier)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/rule")) as {
            identifier: string;
            resourceType: string;
            retentionDays: number;
            description: string;
          };
          expect(response.identifier).toBeTruthy();
          expect(response.resourceType).toBe("EBS_SNAPSHOT");
          expect(response.retentionDays).toBe(7);
          expect(response.description).toBe(
            "alchemy rbin bindings fixture rule",
          );
        }),
    );
  });

  describe("ListRules", () => {
    test.provider(
      "enumerates the Region's rules including the fixture's",
      (_stack) =>
        Effect.gen(function* () {
          const rule = (yield* getJson("/rule")) as { identifier: string };
          const response = (yield* getJson("/rules")) as { ids: string[] };
          expect(response.ids).toContain(rule.identifier);
        }),
    );
  });
});
