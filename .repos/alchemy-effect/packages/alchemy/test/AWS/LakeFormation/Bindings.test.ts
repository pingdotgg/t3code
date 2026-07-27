import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import LakeFormationTestFunctionLive, {
  LakeFormationTestFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "LakeFormationBindings");

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

// Retry only 5xx (cold re-init, IAM propagation); a genuine 4xx/assertion
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

describe.sequential("LakeFormation Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "LakeFormation test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("LakeFormation test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* LakeFormationTestFunction;
        }).pipe(Effect.provide(LakeFormationTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `LakeFormation test setup: fixture not ready yet (${String(error)})`,
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

  describe("GetDataLakePrincipal", () => {
    test.provider(
      "returns the calling principal",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/principal")) as any;
          expect(response.tag).toBe("Ok");
          // the identity is the Lambda's assumed-role session
          expect(response.identity).toBeTruthy();
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListLFTags", () => {
    test.provider(
      "lists visible tag definitions",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/tags")) as any;
          expect(response.tag).toBe("Ok");
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetLFTag", () => {
    test.provider(
      "typed error for a missing tag key",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/tag-missing")) as any;
          expect([
            "EntityNotFoundException",
            "AccessDeniedException",
          ]).toContain(response.tag);
        }),
      { timeout: 60_000 },
    );
  });

  describe("ListPermissions", () => {
    test.provider(
      "lists grants visible to the caller",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/permissions")) as any;
          expect(response.tag).toBe("Ok");
          expect(response.count).toBeGreaterThanOrEqual(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("SearchDatabasesByLFTags", () => {
    test.provider(
      "typed rejection for a nonexistent tag key",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/search-databases")) as any;
          expect([
            "Ok",
            "EntityNotFoundException",
            "AccessDeniedException",
          ]).toContain(response.tag);
          expect(response.count).toBe(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("SearchTablesByLFTags", () => {
    test.provider(
      "typed rejection for a nonexistent tag key",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/search-tables")) as any;
          expect([
            "Ok",
            "EntityNotFoundException",
            "AccessDeniedException",
          ]).toContain(response.tag);
          expect(response.count).toBe(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetResourceLFTags", () => {
    test.provider(
      "reads the fixture database's LF-tags",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/resource-tags")) as any;
          // Ok (no tags assigned) under the default catalog settings; a
          // Lake-Formation-locked catalog surfaces the typed denial instead.
          expect([
            "Ok",
            "AccessDeniedException",
            "EntityNotFoundException",
          ]).toContain(response.tag);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetEffectivePermissionsForPath", () => {
    test.provider(
      "empty permissions (or typed rejection) for an unregistered path",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/effective-permissions")) as any;
          // verified live: an unregistered path returns an empty permission
          // list rather than EntityNotFound
          expect([
            "Ok",
            "EntityNotFoundException",
            "InvalidInputException",
          ]).toContain(response.tag);
          expect(response.count).toBe(0);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetTemporaryGlueTableCredentials", () => {
    test.provider(
      "typed rejection proves lakeformation:GetDataAccess reaches the API",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/table-credentials")) as any;
          expect([
            "AccessDeniedException",
            "EntityNotFoundException",
            "InvalidInputException",
            "PermissionTypeMismatchException",
          ]).toContain(response.tag);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetTemporaryGluePartitionCredentials", () => {
    test.provider(
      "typed rejection proves lakeformation:GetDataAccess reaches the API",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/partition-credentials")) as any;
          expect([
            "AccessDeniedException",
            "EntityNotFoundException",
            "InvalidInputException",
            "PermissionTypeMismatchException",
          ]).toContain(response.tag);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetTemporaryDataLocationCredentials", () => {
    test.provider(
      "typed rejection for an unregistered location",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/location-credentials")) as any;
          expect([
            "AccessDeniedException",
            "EntityNotFoundException",
            "InvalidInputException",
            "ConflictException",
          ]).toContain(response.tag);
        }),
      { timeout: 60_000 },
    );
  });
});
