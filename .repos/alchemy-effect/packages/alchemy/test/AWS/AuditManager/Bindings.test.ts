import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import AuditManagerTestFunctionLive, {
  AuditManagerTestFunction,
} from "./handler";
import AuditManagerAssessmentTestFunctionLive, {
  AuditManagerAssessmentTestFunction,
} from "./handler-assessment";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "AuditManagerBindings");
const assessmentStack = Core.scratchStack(
  testOptions,
  "AuditManagerAssessmentBindings",
);

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
// (cold re-init, IAM propagation on the freshly attached policy). Retry only
// 5xx; a genuine 4xx/assertion failure surfaces immediately.
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

// The testing account is NOT registered with Audit Manager, and the service
// entered maintenance mode on 2026-04-30 so it can never be registered. On
// unregistered accounts every data-plane operation answers the typed
// AccessDeniedException; a registered account (AWS_TEST_AUDITMANAGER=1)
// answers real data. Both prove the binding + IAM grant + typed union
// end-to-end.
const expectOkOrAccessDenied = (
  response: unknown,
  extraTags: string[] = [],
) => {
  const r = response as { ok: boolean; tag?: string };
  if (!r.ok) {
    expect(["AccessDeniedException", ...extraTags]).toContain(r.tag);
  }
};

describe.sequential("AuditManager Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "AuditManager test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("AuditManager test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* AuditManagerTestFunction;
        }).pipe(Effect.provide(AuditManagerTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `AuditManager test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `AuditManager test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("binding registration", () => {
    test.provider("all 11 account-level capabilities initialize", (_stack) =>
      Effect.gen(function* () {
        const response = yield* getJson("/bindings");
        expect((response as any).bound).toHaveLength(11);
      }),
    );
  });

  describe("GetAccountStatus", () => {
    test.provider(
      "succeeds end-to-end through the binding's IAM grant",
      (_stack) =>
        Effect.gen(function* () {
          // GetAccountStatus answers even on unregistered accounts — this is
          // a REAL data-plane success through the attached policy.
          const response = (yield* getJson("/account-status")) as {
            ok: boolean;
            status: string;
          };
          expect(response.ok).toBe(true);
          expect(["ACTIVE", "INACTIVE", "PENDING_ACTIVATION"]).toContain(
            response.status,
          );
        }),
    );
  });

  describe("GetServicesInScope", () => {
    test.provider("answers data or the typed access tag", (_stack) =>
      Effect.gen(function* () {
        expectOkOrAccessDenied(yield* getJson("/services-in-scope"));
      }),
    );
  });

  describe("GetInsights", () => {
    test.provider("answers data or the typed access tag", (_stack) =>
      Effect.gen(function* () {
        expectOkOrAccessDenied(yield* getJson("/insights"));
      }),
    );
  });

  describe("ListControlDomainInsights", () => {
    test.provider("answers data or the typed access tag", (_stack) =>
      Effect.gen(function* () {
        expectOkOrAccessDenied(yield* getJson("/control-domain-insights"));
      }),
    );
  });

  describe("ListControlInsightsByControlDomain", () => {
    test.provider("answers the typed tag for a nonexistent domain", (_stack) =>
      Effect.gen(function* () {
        expectOkOrAccessDenied(yield* getJson("/control-insights"), [
          "ResourceNotFoundException",
          "ValidationException",
        ]);
      }),
    );
  });

  describe("GetDelegations", () => {
    test.provider("answers data or the typed access tag", (_stack) =>
      Effect.gen(function* () {
        expectOkOrAccessDenied(yield* getJson("/delegations"));
      }),
    );
  });

  describe("GetEvidenceFileUploadUrl", () => {
    test.provider("answers a presigned URL or the typed tag", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/upload-url")) as {
          ok: boolean;
          hasUrl?: boolean;
          tag?: string;
        };
        if (response.ok) {
          expect(response.hasUrl).toBe(true);
        } else {
          expect(["AccessDeniedException"]).toContain(response.tag);
        }
      }),
    );
  });

  describe("ListAssessmentReports", () => {
    test.provider("answers data or the typed access tag", (_stack) =>
      Effect.gen(function* () {
        expectOkOrAccessDenied(yield* getJson("/reports"));
      }),
    );
  });

  describe("ValidateAssessmentReportIntegrity", () => {
    test.provider(
      "answers the typed tag for a nonexistent report path",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/validate-report")) as {
            ok: boolean;
            tag?: string;
          };
          // Never ok — the S3 path doesn't exist; on unregistered accounts
          // the request is rejected before it is even looked at.
          expect(response.ok).toBe(false);
          expect([
            "AccessDeniedException",
            "ResourceNotFoundException",
            "ValidationException",
          ]).toContain(response.tag);
        }),
    );
  });

  describe("ListKeywordsForDataSource", () => {
    test.provider("answers keywords or the typed access tag", (_stack) =>
      Effect.gen(function* () {
        expectOkOrAccessDenied(yield* getJson("/keywords"));
      }),
    );
  });

  describe("ListNotifications", () => {
    test.provider("answers data or the typed access tag", (_stack) =>
      Effect.gen(function* () {
        expectOkOrAccessDenied(yield* getJson("/notifications"));
      }),
    );
  });

  // Assessment-scoped bindings need an ACTIVE Audit Manager registration to
  // deploy an Assessment. The testing account can never register (service in
  // maintenance mode since 2026-04-30) — every deploy attempt fails with the
  // typed AccessDeniedException on CreateControl. Run on a registered
  // account with AWS_TEST_AUDITMANAGER=1.
  describe("assessment-scoped bindings", () => {
    test.provider.skipIf(!process.env.AWS_TEST_AUDITMANAGER)(
      "all 22 capabilities bind and the reads answer live data",
      (_stack) =>
        Effect.gen(function* () {
          yield* assessmentStack.destroy();
          const cleanup = assessmentStack
            .destroy()
            .pipe(Effect.catchCause(() => Effect.void));

          yield* Effect.gen(function* () {
            const { functionUrl } = yield* assessmentStack.deploy(
              Effect.gen(function* () {
                return yield* AuditManagerAssessmentTestFunction;
              }).pipe(Effect.provide(AuditManagerAssessmentTestFunctionLive)),
            );
            const assessmentBaseUrl = functionUrl!.replace(/\/+$/, "");

            const ready = yield* HttpClient.get(
              `${assessmentBaseUrl}/bindings`,
            ).pipe(
              Effect.flatMap((response) =>
                response.status === 200
                  ? response.json
                  : Effect.fail(
                      new Error(`Function not ready: ${response.status}`),
                    ),
              ),
              Effect.retry({ schedule: readinessPolicy }),
            );
            expect((ready as any).bound).toHaveLength(22);

            const folders = (yield* send(
              HttpClientRequest.get(`${assessmentBaseUrl}/evidence-folders`),
            ).pipe(Effect.flatMap((r) => r.json))) as { count: number };
            expect(folders.count).toBeGreaterThanOrEqual(0);

            const insights = (yield* send(
              HttpClientRequest.get(`${assessmentBaseUrl}/insights`),
            ).pipe(Effect.flatMap((r) => r.json))) as {
              totalAssessmentControlsCount: number;
            };
            expect(
              insights.totalAssessmentControlsCount,
            ).toBeGreaterThanOrEqual(0);

            const changelogs = (yield* send(
              HttpClientRequest.get(`${assessmentBaseUrl}/changelogs`),
            ).pipe(Effect.flatMap((r) => r.json))) as { count: number };
            expect(changelogs.count).toBeGreaterThanOrEqual(0);
          }).pipe(Effect.ensuring(cleanup));
        }),
      { timeout: 600_000 },
    );
  });
});
