import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import NotificationsTestFunctionLive, {
  NotificationsTestFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "NotificationsBindings");

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

const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

describe.sequential("Notifications Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "Notifications test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Notifications test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* NotificationsTestFunction;
        }).pipe(Effect.provide(NotificationsTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `Notifications test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Notifications test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("binding registration", () => {
    test.provider("all 10 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/bindings");
        expect((response as any).bound).toHaveLength(10);
      }),
    );
  });

  describe("ListNotificationEvents", () => {
    test.provider(
      "lists the last week's notification events",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/events")) as any;
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetNotificationEvent", () => {
    test.provider(
      "surfaces the typed not-found for a nonexistent event (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/event-nonexistent")) as any;
          // Either typed rejection proves the grant reached the API — an
          // IAM gap would surface AccessDeniedException and 500 the route.
          expect([
            "ResourceNotFoundException",
            "ValidationException",
          ]).toContain(response.tag);
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListManagedNotificationConfigurations", () => {
    test.provider(
      "lists the AWS Health managed configurations",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/managed-configs")) as any;
          // Every account has the AWS Health categories.
          expect(response.count).toBeGreaterThan(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetManagedNotificationConfiguration", () => {
    test.provider(
      "fetches the first managed configuration",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/managed-config")) as any;
          expect(response.tag).toBe("Ok");
          expect(typeof response.name).toBe("string");
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListManagedNotificationEvents", () => {
    test.provider(
      "lists the last week's managed notification events",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/managed-events")) as any;
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetManagedNotificationEvent", () => {
    test.provider(
      "fetches the first managed event (or reports none, both proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/managed-event")) as any;
          expect(["Ok", "NoEvents"]).toContain(response.tag);
          if (response.tag === "Ok") {
            expect(response.configurationArn).toContain(
              ":managed-notification-configuration/",
            );
          }
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListManagedNotificationChildEvents", () => {
    test.provider(
      "lists an aggregate's children (or the typed rejection for a non-aggregate)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/managed-child-events")) as any;
          expect([
            "Ok",
            "ValidationException",
            "ResourceNotFoundException",
            "NoEvents",
          ]).toContain(response.tag);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetManagedNotificationChildEvent", () => {
    test.provider(
      "surfaces the typed not-found for a nonexistent child event (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson(
            "/managed-child-event-nonexistent",
          )) as any;
          expect([
            "ResourceNotFoundException",
            "ValidationException",
          ]).toContain(response.tag);
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListManagedNotificationChannelAssociations", () => {
    test.provider(
      "lists the first managed configuration's channel associations",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson(
            "/managed-channel-associations",
          )) as any;
          expect(response.tag).toBe("Ok");
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListChannels", () => {
    test.provider(
      "lists the fixture configuration's channels (proving ARN injection + the scoped grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/channels")) as any;
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 60_000 },
    );
  });
});
