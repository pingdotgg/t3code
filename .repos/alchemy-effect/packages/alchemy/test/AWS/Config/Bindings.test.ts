import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as config from "@distilled.cloud/aws/config-service";
import * as iam from "@distilled.cloud/aws/iam";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import ConfigTestFunctionLive, { ConfigTestFunction } from "./handler";
import { makeConfigTestLease } from "./TestLease.ts";

// Runtime binding coverage for every Config capability that can be
// exercised against fixture-deployable resources. One binding has no route
// here (documented, not silently dropped):
//
// - DeliverConfigSnapshot — binds to the account's singleton
//   DeliveryChannel, whose lifecycle is gated behind
//   AWS_TEST_CONFIG_RECORDER (see ConfigurationRecorder.test.ts); an
//   ungated fixture must not clobber the account's Config delivery setup.

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ConfigBindings");
const testLease = makeConfigTestLease();

// PutConfigRule (the fixture's rule) requires a configuration recorder in
// the account/region. Capture-and-restore: if the account has none, stand
// up a minimal recorder on the Config service-linked role for the duration
// of the suite and delete it afterwards; an existing foreign recorder is
// left untouched. The deterministic name means a leftover from a
// previously-killed run is RECLAIMED (and cleaned up at the end) instead of
// orphaning forever.
const TEST_RECORDER_NAME = "alchemy-test-config-bindings-recorder";

const ensureRecorder = Effect.gen(function* () {
  const existing = yield* config.describeConfigurationRecorders({});
  const recorders = existing.ConfigurationRecorders ?? [];
  if (recorders.some((r) => r.name === TEST_RECORDER_NAME)) {
    return true;
  }
  if (recorders.length > 0) {
    return false;
  }
  yield* iam
    .createServiceLinkedRole({ AWSServiceName: "config.amazonaws.com" })
    .pipe(
      Effect.catchTag("InvalidInputException", () => Effect.succeed(undefined)),
    );
  const role = yield* iam.getRole({ RoleName: "AWSServiceRoleForConfig" });
  yield* config
    .putConfigurationRecorder({
      ConfigurationRecorder: {
        name: TEST_RECORDER_NAME,
        roleARN: role.Role.Arn,
        recordingGroup: { resourceTypes: ["AWS::S3::Bucket"] },
      },
    })
    .pipe(
      Effect.retry({
        while: (e) => e._tag === "InvalidRoleException",
        schedule: Schedule.max([
          Schedule.fixed("2 seconds"),
          Schedule.recurs(15),
        ]),
      }),
    );
  return true;
});

const removeRecorderIfCreated = (created: boolean) =>
  created
    ? config
        .deleteConfigurationRecorder({
          ConfigurationRecorderName: TEST_RECORDER_NAME,
        })
        .pipe(
          Effect.catchTag(
            "NoSuchConfigurationRecorderException",
            () => Effect.void,
          ),
          Effect.orDie,
        )
    : Effect.void;

let recorderCreated = false;
let baseUrl: string;

const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under
// cold re-init or an IAM-propagation race. Only 5xx is retried; a genuine
// 4xx/assertion failure is returned immediately.
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

const postJson = (path: string) =>
  send(HttpClientRequest.post(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

describe("Config Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* testLease.acquire;
      yield* Effect.logInfo("Config test setup: ensuring recorder");
      // Direct distilled calls need the AWS provider context (credentials,
      // region) that `test.provider` bodies get implicitly.
      recorderCreated = yield* Core.withProviders(
        ensureRecorder,
        testOptions,
        "ConfigBindings",
      );

      yield* Effect.logInfo("Config test setup: destroying previous stack");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Config test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* ConfigTestFunction;
        }).pipe(Effect.provide(ConfigTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      yield* Effect.logInfo(
        `Config test setup: probing readiness at ${baseUrl}/health`,
      );
      yield* HttpClient.get(`${baseUrl}/health`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(
    sharedStack
      .destroy()
      .pipe(
        Effect.ensuring(
          Effect.suspend(() =>
            Core.withProviders(
              removeRecorderIfCreated(recorderCreated),
              testOptions,
              "ConfigBindings",
            ),
          ),
        ),
        Effect.ensuring(testLease.release),
      ),
    { timeout: 180_000 },
  );

  // ── Discovering resources / querying ────────────────────────────────────

  describe("SelectResourceConfig", () => {
    test.provider("runs a SQL query over recorded state", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/select-resource-config")) as {
          results: unknown[];
        };
        expect(Array.isArray(response.results)).toBe(true);
      }),
    );
  });

  describe("ListDiscoveredResources", () => {
    test.provider("lists discovered bucket identifiers", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/list-discovered-resources")) as {
          identifiers: unknown[];
        };
        expect(Array.isArray(response.identifiers)).toBe(true);
      }),
    );
  });

  describe("GetDiscoveredResourceCounts", () => {
    test.provider("counts discovered resources", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson(
          "/get-discovered-resource-counts",
        )) as { total: number; counts: unknown[] };
        expect(typeof response.total).toBe("number");
        expect(Array.isArray(response.counts)).toBe(true);
      }),
    );
  });

  describe("BatchGetResourceConfig", () => {
    test.provider(
      "returns the undiscovered probe key as unprocessed",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/batch-get-resource-config")) as {
            items: unknown[];
            unprocessed: { resourceId?: string }[];
          };
          expect(Array.isArray(response.items)).toBe(true);
          expect(Array.isArray(response.unprocessed)).toBe(true);
        }),
    );
  });

  describe("GetResourceConfigHistory", () => {
    test.provider(
      "answers ok or the typed ResourceNotDiscoveredException",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/get-resource-config-history")) as {
            items?: unknown[];
            errorTag?: string;
          };
          if (response.errorTag !== undefined) {
            expect(response.errorTag).toBe("ResourceNotDiscoveredException");
          } else {
            expect(Array.isArray(response.items)).toBe(true);
          }
        }),
    );
  });

  // ── Compliance reads ─────────────────────────────────────────────────────

  describe("DescribeComplianceByConfigRule", () => {
    test.provider("reads the fixture rule's compliance", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson(
          "/describe-compliance-by-config-rule",
        )) as { ruleName: string; compliances: unknown[] };
        expect(response.ruleName).toBeTruthy();
        expect(Array.isArray(response.compliances)).toBe(true);
      }),
    );
  });

  describe("DescribeComplianceByResource", () => {
    test.provider("reads compliance by resource type", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson(
          "/describe-compliance-by-resource",
        )) as { compliances: unknown[] };
        expect(Array.isArray(response.compliances)).toBe(true);
      }),
    );
  });

  describe("GetComplianceDetailsByResource", () => {
    test.provider("reads evaluation results for a resource", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson(
          "/get-compliance-details-by-resource",
        )) as { evaluations: unknown[] };
        expect(Array.isArray(response.evaluations)).toBe(true);
      }),
    );
  });

  describe("GetComplianceSummaryByConfigRule", () => {
    test.provider("reads the account rule-compliance summary", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson(
          "/get-compliance-summary-by-config-rule",
        )) as { summary: unknown };
        expect(response).toHaveProperty("summary");
      }),
    );
  });

  describe("GetComplianceSummaryByResourceType", () => {
    test.provider("reads per-type compliance summaries", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson(
          "/get-compliance-summary-by-resource-type",
        )) as { summaries: unknown[] };
        expect(Array.isArray(response.summaries)).toBe(true);
      }),
    );
  });

  describe("GetComplianceDetailsByConfigRule", () => {
    test.provider(
      "reads the bound rule's evaluation results (injected name)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson(
            "/get-compliance-details-by-config-rule",
          )) as { ruleName: string; evaluations: unknown[] };
          expect(response.ruleName).toBeTruthy();
          expect(Array.isArray(response.evaluations)).toBe(true);
        }),
    );
  });

  // ── Rule evaluation ──────────────────────────────────────────────────────

  describe("DescribeConfigRuleEvaluationStatus", () => {
    test.provider("reads the fixture rule's evaluation status", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson(
          "/describe-config-rule-evaluation-status",
        )) as { ruleName: string; statuses: string[] };
        expect(response.statuses).toContain(response.ruleName);
      }),
    );
  });

  describe("StartConfigRulesEvaluation", () => {
    test.provider(
      "starts an on-demand evaluation of the bound rule",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson(
            "/start-config-rules-evaluation",
          )) as { ok?: boolean; errorTag?: string };
          if (response.errorTag !== undefined) {
            expect([
              "ResourceInUseException",
              "LimitExceededException",
            ]).toContain(response.errorTag);
          } else {
            expect(response.ok).toBe(true);
          }
        }),
    );
  });

  describe("PutEvaluations", () => {
    test.provider("validates evaluations in test mode", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* postJson("/put-evaluations")) as {
          failed?: unknown[];
          errorTag?: string;
        };
        if (response.errorTag !== undefined) {
          expect(response.errorTag).toBe("InvalidResultTokenException");
        } else {
          expect(Array.isArray(response.failed)).toBe(true);
        }
      }),
    );
  });

  describe("PutExternalEvaluation", () => {
    test.provider(
      "rejects with the typed InvalidParameterValueException on a managed rule",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/put-external-evaluation")) as {
            ok?: boolean;
            errorTag?: string;
          };
          if (response.errorTag !== undefined) {
            expect(response.errorTag).toBe("InvalidParameterValueException");
          } else {
            expect(response.ok).toBe(true);
          }
        }),
    );
  });

  // ── Custom resource recording ────────────────────────────────────────────

  describe("PutResourceConfig", () => {
    test.provider(
      "records a custom resource (or the typed no-running-recorder error)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/put-resource-config")) as {
            ok?: boolean;
            errorTag?: string;
          };
          if (response.errorTag !== undefined) {
            expect([
              "NoRunningConfigurationRecorderException",
              "ValidationException",
              "MaxActiveResourcesExceededException",
            ]).toContain(response.errorTag);
          } else {
            expect(response.ok).toBe(true);
          }
        }),
    );
  });

  describe("DeleteResourceConfig", () => {
    test.provider(
      "deletes the custom resource (or the typed no-running-recorder error)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/delete-resource-config")) as {
            ok?: boolean;
            errorTag?: string;
          };
          if (response.errorTag !== undefined) {
            expect([
              "NoRunningConfigurationRecorderException",
              "ValidationException",
            ]).toContain(response.errorTag);
          } else {
            expect(response.ok).toBe(true);
          }
        }),
    );
  });

  // ── Proactive resource evaluation ────────────────────────────────────────

  describe("StartResourceEvaluation / GetResourceEvaluationSummary", () => {
    test.provider(
      "starts a proactive evaluation and reads its summary",
      (_stack) =>
        Effect.gen(function* () {
          const started = (yield* postJson("/start-resource-evaluation")) as {
            id?: string;
            errorTag?: string;
            errorMessage?: string;
          };
          if (started.errorTag !== undefined) {
            expect(started.errorTag, started.errorMessage).toBe(
              "InvalidParameterValueException",
            );
            return;
          }
          expect(started.id).toBeTruthy();

          const summary = (yield* getJson(
            `/get-resource-evaluation-summary?id=${started.id}`,
          )) as { id?: string; status?: string; errorTag?: string };
          if (summary.errorTag !== undefined) {
            expect(summary.errorTag).toBe("ResourceNotFoundException");
          } else {
            expect(summary.id).toBe(started.id);
            expect(summary.status).toBeTruthy();
          }
        }),
    );
  });

  describe("ListResourceEvaluations", () => {
    test.provider("lists proactive evaluations", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/list-resource-evaluations")) as {
          evaluations: unknown[];
        };
        expect(Array.isArray(response.evaluations)).toBe(true);
      }),
    );
  });
});
