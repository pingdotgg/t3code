import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import AccessAnalyzerTestFunctionLive, {
  AccessAnalyzerTestFunction,
} from "./handler";
import { makeAccessAnalyzerTestLease } from "./TestLease.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "AccessAnalyzerBindings");
const testLease = makeAccessAnalyzerTestLease();

beforeAll(testLease.acquire, { timeout: 240_000 });
afterAll(testLease.release);

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let functionRoleArn: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under
// full-suite parallel load (cold re-init, IAM propagation on the freshly
// attached access-analyzer policy that the handler's `Effect.orDie` surfaces
// as a 500). Retry only 5xx; a genuine 4xx/assertion failure surfaces
// immediately.
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

describe.sequential("AccessAnalyzer Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "AccessAnalyzer test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("AccessAnalyzer test setup: deploying fixture");
      const { functionUrl, roleArn } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* AccessAnalyzerTestFunction;
        }).pipe(Effect.provide(AccessAnalyzerTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      functionRoleArn = roleArn;

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `AccessAnalyzer test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `AccessAnalyzer test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("binding registration", () => {
    test.provider("all 24 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/bindings`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect((response as any).bound).toHaveLength(24);
      }),
    );
  });

  describe("ValidatePolicy", () => {
    test.provider("validates a well-formed identity policy", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.post(`${baseUrl}/validate-policy`),
        ).pipe(Effect.flatMap((r) => r.json));
        // The sample policy is syntactically valid — no ERROR findings.
        expect((response as any).findingTypes).not.toContain("ERROR");
      }),
    );
  });

  describe("CheckNoNewAccess", () => {
    test.provider(
      "passes when the new policy is a subset of the existing one",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.post(`${baseUrl}/check-no-new-access`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect((response as any).result).toBe("PASS");
        }),
    );
  });

  describe("CheckAccessNotGranted", () => {
    test.provider(
      "passes when the policy does not grant the checked action",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.post(`${baseUrl}/check-access-not-granted`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect((response as any).result).toBe("PASS");
        }),
    );
  });

  describe("CheckNoPublicAccess", () => {
    test.provider(
      "passes for a bucket policy scoped to a single account",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.post(`${baseUrl}/check-no-public-access`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect((response as any).result).toBe("PASS");
        }),
    );
  });

  describe("ListFindingsV2", () => {
    test.provider("lists the fixture analyzer's findings", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/list-findings`),
        ).pipe(Effect.flatMap((r) => r.json));
        // A fresh unused-access analyzer typically has zero findings —
        // assert the call round-trips with a well-formed page.
        expect(typeof (response as any).count).toBe("number");
      }),
    );
  });

  describe("GetFindingV2", () => {
    test.provider(
      "returns the typed not-found error for an unknown finding id",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/get-finding-not-found`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect((response as any).found).toBe(false);
        }),
    );
  });

  describe("ListAnalyzedResources", () => {
    test.provider("lists the analyzer's analyzed resources", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/list-analyzed-resources`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect(typeof (response as any).count).toBe("number");
      }),
    );
  });

  describe("GetFindingsStatistics", () => {
    test.provider("returns the analyzer's statistics", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/findings-statistics`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect(Array.isArray((response as any).statistics)).toBe(true);
      }),
    );
  });

  describe("ApplyArchiveRule", () => {
    test.provider("applies the fixture archive rule", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.post(`${baseUrl}/apply-archive-rule`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect((response as any).applied).toBe(true);
      }),
    );
  });

  describe("ListPolicyGenerations", () => {
    test.provider("lists the account's policy generations", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/list-policy-generations`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect(typeof (response as any).count).toBe("number");
      }),
    );
  });

  describe("StartPolicyGeneration / GetGeneratedPolicy / CancelPolicyGeneration", () => {
    // A real policy generation needs a CloudTrail trail + access role (the
    // live API rejects trail-less starts with ValidationException "Missing
    // cloudTrailDetails"). The fixture drives all three bindings through
    // their typed ValidationException paths — an IAM gap would surface
    // AccessDeniedException instead, so these tags prove the grants and the
    // typed error unions end-to-end.
    test.provider(
      "surfaces the typed ValidationException path for all three bindings",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/policy-generation`),
              { principalArn: functionRoleArn },
            ),
          ).pipe(Effect.flatMap((r) => r.json));
          expect(["Started", "ValidationException"]).toContain(
            (response as any).startTag,
          );
          expect((response as any).getTag).toBe("ValidationException");
          expect((response as any).cancelTag).toBe("ValidationException");
        }),
    );
  });
});
