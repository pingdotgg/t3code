import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import AppRegistryTestFunctionLive, {
  AppRegistryTestFunction,
} from "./handler";
import { makeAppRegistryTestLease } from "./TestLease.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "AppRegistryBindings");
const serviceLease = makeAppRegistryTestLease();

beforeAll(serviceLease.acquire, { timeout: 3_600_000 });

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

// The shared Lambda fixture occasionally answers a transient 5xx under load
// (cold re-init, IAM propagation on the freshly attached policy that the
// handler's `Effect.orDie` surfaces as a 500). Retry only 5xx; a genuine
// 4xx/assertion failure surfaces immediately.
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

describe.sequential("AppRegistry Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "AppRegistry test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("AppRegistry test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* AppRegistryTestFunction;
        }).pipe(Effect.provide(AppRegistryTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `AppRegistry test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `AppRegistry test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });
  afterAll(serviceLease.release);

  describe("binding registration", () => {
    test.provider("all 9 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/bindings`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect((response as any).bound).toHaveLength(9);
      }),
    );
  });

  describe("GetApplication", () => {
    test.provider("reads the fixture application's metadata", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/application`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect(typeof (response as any).name).toBe("string");
        expect((response as any).name.length).toBeGreaterThan(0);
        expect(typeof (response as any).associatedResourceCount).toBe("number");
      }),
    );
  });

  describe("GetAttributeGroup", () => {
    test.provider("reads the fixture group's JSON attributes", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/attribute-group`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect((response as any).attributes.owner).toBe("alchemy-test");
        expect((response as any).attributes.tier).toBe("bindings");
      }),
    );
  });

  describe("ListAssociatedAttributeGroups", () => {
    test.provider("lists the associated attribute group", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/associated-attribute-groups`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect((response as any).count).toBeGreaterThanOrEqual(1);
      }),
    );
  });

  describe("ListAttributeGroupsForApplication", () => {
    test.provider("lists the associated attribute group details", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/attribute-groups-details`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect((response as any).names.length).toBeGreaterThanOrEqual(1);
      }),
    );
  });

  describe("ListAssociatedResources", () => {
    test.provider("lists the application's associated resources", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/associated-resources`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect(typeof (response as any).count).toBe("number");
      }),
    );
  });

  describe("GetAssociatedResource", () => {
    test.provider(
      "returns the typed not-found error for an unknown resource",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/associated-resource-not-found`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect((response as any).found).toBe(false);
        }),
    );
  });

  describe("ListApplications", () => {
    test.provider(
      "account listing includes the fixture application",
      (_stack) =>
        Effect.gen(function* () {
          const app = yield* send(
            HttpClientRequest.get(`${baseUrl}/application`),
          ).pipe(Effect.flatMap((r) => r.json));
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/applications`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect((response as any).names).toContain((app as any).name);
        }),
    );
  });

  describe("ListAttributeGroups", () => {
    test.provider(
      "account listing includes the fixture attribute group",
      (_stack) =>
        Effect.gen(function* () {
          const group = yield* send(
            HttpClientRequest.get(`${baseUrl}/attribute-group`),
          ).pipe(Effect.flatMap((r) => r.json));
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/attribute-groups`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect((response as any).names).toContain((group as any).name);
        }),
    );
  });

  describe("SyncResource", () => {
    test.provider(
      "surfaces a typed error for a nonexistent stack (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.post(`${baseUrl}/sync-resource`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect([
            "ResourceNotFoundException",
            "ValidationException",
          ]).toContain((response as any).tag);
        }),
    );
  });
});
