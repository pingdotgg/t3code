import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import AIOpsTestFunctionLive, { AIOpsTestFunction } from "./fixtures/handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "AIOpsBindings");

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

// AWS enforces ONE AIOps investigation group per account per Region, so this
// file must never overlap with InvestigationGroup.test.ts (whose live
// lifecycle is gated behind AWS_TEST_AIOPS and destroys its group on the way
// in and out). The single-fork suite run executes files sequentially and this
// file destroys its group on the way in and out.
describe.sequential("AIOps Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("AIOps test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("AIOps test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* AIOpsTestFunction;
        }).pipe(Effect.provide(AIOpsTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `AIOps test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `AIOps test setup: fixture not ready yet (${String(error)})`,
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
          "getInvestigationGroup",
          "getInvestigationGroupPolicy",
          "listTagsForResource",
          "listInvestigationGroups",
        ]);
      }),
    );
  });

  describe("GetInvestigationGroup", () => {
    test.provider(
      "reads the bound group's configuration (injected group ARN)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/group")) as {
            name: string;
            arn: string;
            retentionInDays: number;
          };
          expect(response.arn).toContain(":investigation-group/");
          expect(response.name).toBeTruthy();
          expect(response.retentionInDays).toBe(7);
        }),
    );
  });

  describe("GetInvestigationGroupPolicy", () => {
    test.provider(
      "reads the group's resource policy (typed not-found when unattached)",
      (_stack) =>
        Effect.gen(function* () {
          // The fixture attaches no resource policy, so the runtime observes
          // the typed ResourceNotFoundException — proving both the IAM grant
          // and the injected group ARN end-to-end.
          const response = (yield* getJson("/policy")) as {
            hasPolicy: boolean;
          };
          expect(response.hasPolicy).toBe(false);
        }),
    );
  });

  describe("ListTagsForResource", () => {
    test.provider("reads the bound group's tags", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/tags")) as {
          tags: Record<string, string>;
        };
        expect(response.tags.Purpose).toBe("bindings-test");
        expect(response.tags["alchemy::id"]).toBe("BindingGroup");
      }),
    );
  });

  describe("ListInvestigationGroups", () => {
    test.provider(
      "enumerates the Region's investigation groups (account-level)",
      (_stack) =>
        Effect.gen(function* () {
          const group = (yield* getJson("/group")) as { arn: string };
          const response = (yield* getJson("/groups")) as {
            groupArns: string[];
          };
          expect(response.groupArns).toContain(group.arn);
        }),
    );
  });
});
