import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import CodeConnectionsTestFunctionLive, {
  CodeConnectionsTestFunction,
  fixtureConnectionName,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "CodeConnectionsBindings");

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

describe.sequential("CodeConnections Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "CodeConnections test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("CodeConnections test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* CodeConnectionsTestFunction;
        }).pipe(Effect.provide(CodeConnectionsTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `CodeConnections test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `CodeConnections test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("binding registration", () => {
    test.provider("all capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/bindings`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect((response as any).bound).toHaveLength(4);
      }),
    );
  });

  describe("GetConnection", () => {
    test.provider("reads the fixture connection's live state", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/connection`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect((response as any).name).toBe(fixtureConnectionName);
        // The OAuth handshake is a manual console step, so the fixture
        // connection stays PENDING.
        expect((response as any).status).toBe("PENDING");
        expect((response as any).providerType).toBe("GitHub");
      }),
    );
  });

  describe("ListConnections", () => {
    test.provider(
      "lists the fixture connection among the account's connections",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/connections`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect((response as any).names).toContain(fixtureConnectionName);
        }),
    );
  });

  describe("ListHosts", () => {
    test.provider(
      "enumerates the account's hosts (empty unless a self-managed provider is registered)",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/hosts`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect(Array.isArray((response as any).names)).toBe(true);
        }),
    );
  });

  describe("ListRepositoryLinks", () => {
    test.provider(
      "enumerates the account's repository links (empty unless Git sync is configured)",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/repository-links`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect(Array.isArray((response as any).repositories)).toBe(true);
        }),
    );
  });
});
