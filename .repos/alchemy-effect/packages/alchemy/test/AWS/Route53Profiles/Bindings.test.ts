import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import ProfilesTestFunctionLive, { ProfilesTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "Route53ProfilesBindings");

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

describe.sequential("Route53Profiles Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "Route53Profiles bindings setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo(
        "Route53Profiles bindings setup: deploying fixture",
      );
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* ProfilesTestFunction;
        }).pipe(Effect.provide(ProfilesTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `Route53Profiles bindings setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Route53Profiles bindings setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 240_000 });

  describe("binding registration", () => {
    test.provider("the capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toEqual([
          "listProfileAssociations",
          "listProfileResourceAssociations",
        ]);
      }),
    );
  });

  describe("ListProfileAssociations", () => {
    test.provider(
      "lists the bound profile's VPC associations (injected profile id)",
      (_stack) =>
        Effect.gen(function* () {
          // The fixture's profile is never associated with a VPC, so an
          // empty list proves both the
          // route53profiles:ListProfileAssociations grant and the ProfileId
          // filter injection.
          const response = (yield* getJson("/associations")) as {
            count: number;
            resourceIds: string[];
          };
          expect(response.count).toBe(0);
          expect(response.resourceIds).toEqual([]);
        }),
    );
  });

  describe("ListProfileResourceAssociations", () => {
    test.provider(
      "lists the bound profile's attached DNS resources (injected profile id)",
      (_stack) =>
        Effect.gen(function* () {
          // No DNS resources are ever attached to the fixture's profile, so
          // an empty list proves both the
          // route53profiles:ListProfileResourceAssociations grant and the
          // ProfileId injection.
          const response = (yield* getJson("/resource-associations")) as {
            count: number;
            resourceArns: string[];
          };
          expect(response.count).toBe(0);
          expect(response.resourceArns).toEqual([]);
        }),
    );
  });
});
