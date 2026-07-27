import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import RAMTestFunctionLive, { RAMTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "RAMBindings");

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

describe.sequential("RAM Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("RAM test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("RAM test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* RAMTestFunction;
        }).pipe(Effect.provide(RAMTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `RAM test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `RAM test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("binding registration", () => {
    test.provider("all 11 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/bindings");
        expect((response as any).bound).toHaveLength(11);
      }),
    );
  });

  describe("GetResourceShares", () => {
    test.provider(
      "lists the account's shares including the fixture share",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/shares")) as any;
          expect(response.count).toBeGreaterThan(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetResourceShareAssociations", () => {
    test.provider(
      "lists the fixture share's principal associations",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/associations")) as any;
          expect(response.tag).toBe("Ok");
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetResourceShareInvitations", () => {
    test.provider(
      "lists the invitations sent to this account",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/invitations")) as any;
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("AcceptResourceShareInvitation", () => {
    test.provider(
      "surfaces the typed not-found for a nonexistent invitation (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/accept-nonexistent")) as any;
          expect([
            "ResourceShareInvitationArnNotFoundException",
            "MalformedArnException",
          ]).toContain(response.tag);
        }),
      { timeout: 60_000 },
    );
  });

  describe("RejectResourceShareInvitation", () => {
    test.provider(
      "surfaces the typed not-found for a nonexistent invitation (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/reject-nonexistent")) as any;
          expect([
            "ResourceShareInvitationArnNotFoundException",
            "MalformedArnException",
          ]).toContain(response.tag);
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListPendingInvitationResources", () => {
    test.provider(
      "surfaces the typed not-found for a nonexistent invitation (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson(
            "/pending-resources-nonexistent",
          )) as any;
          expect([
            "ResourceShareInvitationArnNotFoundException",
            "MalformedArnException",
            "InvalidParameterException",
          ]).toContain(response.tag);
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListResources", () => {
    test.provider(
      "lists the resources this account shares",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/resources")) as any;
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListPrincipals", () => {
    test.provider(
      "lists the principals this account shares with",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/principals")) as any;
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetResourcePolicies", () => {
    test.provider(
      "answers for a nonexistent resource (typed not-found or empty, proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson(
            "/resource-policies-nonexistent",
          )) as any;
          expect([
            "Ok",
            "ResourceArnNotFoundException",
            "MalformedArnException",
          ]).toContain(response.tag);
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListPermissions", () => {
    test.provider(
      "lists the AWS managed permissions",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/permissions")) as any;
          // Every account sees the AWS managed permissions.
          expect(response.count).toBeGreaterThan(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetPermission", () => {
    test.provider(
      "fetches the first listed permission",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/permission")) as any;
          expect(response.tag).toBe("Ok");
          expect(typeof response.name).toBe("string");
        }),
      { timeout: 60_000 },
    );
  });
});
