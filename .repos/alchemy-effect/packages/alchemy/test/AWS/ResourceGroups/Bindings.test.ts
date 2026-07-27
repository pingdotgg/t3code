import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import * as resourcegroups from "@distilled.cloud/aws/resource-groups";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import RGTestFunctionLive, { RGTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ResourceGroupsBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let functionArn: string;

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

const postJson = (path: string, body: object) =>
  send(
    HttpClientRequest.post(`${baseUrl}${path}`).pipe(
      HttpClientRequest.bodyJsonUnsafe(body),
    ),
  ).pipe(Effect.flatMap((r) => r.json));

describe.sequential("ResourceGroups Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("RG test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("RG test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* RGTestFunction;
        }).pipe(Effect.provide(RGTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      functionArn = attrs.functionArn;

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `RG test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `RG test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
    timeout: 120_000,
  });

  describe("binding registration", () => {
    test.provider("all ten capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(10);
      }),
    );
  });

  describe("ListGroupResources", () => {
    test.provider(
      "enumerates the bound group's members (injected group name)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/members")) as { arns: string[] };
          // The pool group starts (and stays) empty; the call succeeding
          // proves the injected group + the tagging read-through grants.
          expect(response.arns).toEqual([]);
        }),
    );
  });

  describe("GroupResources / UngroupResources", () => {
    test.provider(
      "accepts a grouping request and reports the per-resource outcome",
      (_stack) =>
        Effect.gen(function* () {
          // A Lambda ARN is not a capacity reservation, so the service
          // accepts the request and reports the ARN as Failed with a typed
          // error code — proving the full wire loop without cost.
          const grouped = (yield* postJson("/group", {
            arn: functionArn,
          })) as { succeeded: string[]; failedCodes: string[] };
          expect(grouped.succeeded).toEqual([]);
          expect(grouped.failedCodes).toEqual([
            "ResourceArnValidationException",
          ]);

          const ungrouped = (yield* postJson("/ungroup", {
            arn: functionArn,
          })) as { failedCodes: string[] };
          expect(ungrouped.failedCodes).toEqual([
            "ResourceArnValidationException",
          ]);
        }),
    );
  });

  describe("ListGroupingStatuses", () => {
    test.provider(
      "rejects non-application groups with the typed BadRequestException",
      (_stack) =>
        Effect.gen(function* () {
          // Grouping statuses only exist for application groups, which
          // CreateGroup cannot make — the typed rejection proves the wire.
          const response = (yield* getJson("/grouping-statuses")) as {
            errorTag?: string;
            message?: string;
          };
          expect(response.errorTag).toBe("BadRequestException");
          expect(response.message).toContain("application group");
        }),
    );
  });

  describe("SearchResources", () => {
    test.provider("runs an ad-hoc tag query", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/search")) as { arns: string[] };
        // Tag indexing is eventually consistent, so assert only that the
        // query executed (grants held) and returned an array.
        expect(Array.isArray(response.arns)).toBe(true);
      }),
    );
  });

  describe("GetAccountSettings", () => {
    test.provider("reads the group lifecycle events status", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/account-settings")) as {
          status: string;
        };
        expect(["ACTIVE", "INACTIVE", "IN_PROGRESS", "ERROR"]).toContain(
          response.status,
        );
      }),
    );
  });

  describe("ListTagSyncTasks", () => {
    test.provider("enumerates the account's tag-sync tasks", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/tag-sync-tasks")) as {
          count: number;
        };
        expect(response.count).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  describe("StartTagSyncTask / GetTagSyncTask / CancelTagSyncTask", () => {
    test.provider(
      "tag-sync operations reach the service and fail with typed tags",
      (_stack) =>
        Effect.gen(function* () {
          // Tag-sync requires an application group (myApplications-only, not
          // creatable via CreateGroup) — the typed rejection proves IAM +
          // wiring, including the iam:PassRole grant path. Retry while the
          // freshly attached role policy is still propagating (AccessDenied
          // instead of the service-side validation error).
          const started = (yield* postJson("/start-tag-sync", {}).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (r: unknown) =>
                (r as { errorTag?: string }).errorTag !==
                "AccessDeniedException",
              times: 8,
            }),
          )) as { errorTag?: string; message?: string };
          expect(started.errorTag, started.message).toBe("BadRequestException");

          const got = (yield* getJson(
            "/tag-sync-task?arn=arn:aws:resource-groups:us-west-2:000000000000:group/none/00000000-0000-0000-0000-000000000000",
          )) as { errorTag?: string };
          expect(got.errorTag).toBeTruthy();
          expect(got.errorTag).not.toBe("UnknownAwsError");

          const cancelled = (yield* postJson("/cancel-tag-sync", {
            arn: "arn:aws:resource-groups:us-west-2:000000000000:group/none/00000000-0000-0000-0000-000000000000",
          })) as { errorTag?: string };
          expect(cancelled.errorTag).toBeTruthy();
          expect(cancelled.errorTag).not.toBe("UnknownAwsError");
        }),
    );
  });

  describe("consumeGroupEvents", () => {
    test.provider(
      "the deploy created an EventBridge rule targeting the function",
      (_stack) =>
        Effect.gen(function* () {
          // Out-of-band via distilled: the fixture's consumeGroupEvents must
          // have materialized as a rule on the default bus with the Lambda
          // as target.
          const { RuleNames } = yield* eventbridge.listRuleNamesByTarget({
            TargetArn: functionArn,
          });
          expect((RuleNames ?? []).length).toBeGreaterThanOrEqual(1);
        }),
    );
  });

  describe("typed error probes (distilled patch)", () => {
    test.provider(
      "listGroupingStatuses on a missing group is the typed NotFoundException",
      (_stack) =>
        Effect.gen(function* () {
          // Proves the distilled patch adding NotFoundException to
          // ListGroupingStatuses' error union (previously UnknownAwsError).
          const error = yield* resourcegroups
            .listGroupingStatuses({ Group: "alchemy-rg-does-not-exist" })
            .pipe(Effect.flip);
          expect(error._tag).toBe("NotFoundException");
        }),
    );
  });
});
