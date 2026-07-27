import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import FisTestFunctionLive, { FisTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "FISBindings");

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

const postJson = (path: string) =>
  send(HttpClientRequest.post(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

describe.sequential("FIS Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("FIS test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("FIS test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* FisTestFunction;
        }).pipe(Effect.provide(FisTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      functionArn = attrs.functionArn;

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `FIS test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `FIS test setup: fixture not ready yet (${String(error)})`,
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
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(15);
      }),
    );
  });

  describe("GetExperimentTemplate + ListExperimentTemplates", () => {
    test.provider(
      "reads the bound template (injected id) and finds it in the listing",
      (_stack) =>
        Effect.gen(function* () {
          const template = (yield* getJson("/template")) as {
            id: string;
            actions: string[];
          };
          expect(template.id).toMatch(/^EXT/);
          expect(template.actions).toContain("Wait");

          const listing = (yield* getJson("/templates")) as { ids: string[] };
          expect(listing.ids).toContain(template.id);
        }),
      { timeout: 60_000 },
    );
  });

  describe("StartExperiment + GetExperiment + ListExperiments + StopExperiment", () => {
    test.provider(
      "runs the harmless wait experiment end to end and stops it",
      (_stack) =>
        Effect.gen(function* () {
          const template = (yield* getJson("/template")) as { id: string };

          // start — the bound template's id is injected by the binding.
          const started = (yield* postJson("/experiments")) as {
            id: string;
            status: string;
          };
          expect(started.id).toMatch(/^EXP/);
          expect(["pending", "initiating", "running"]).toContain(
            started.status,
          );

          // read it back and see it in the template-scoped listing.
          const read = (yield* getJson(`/experiment?id=${started.id}`)) as {
            id: string;
            templateId: string;
            status: string;
          };
          expect(read.id).toBe(started.id);
          expect(read.templateId).toBe(template.id);

          const listing = (yield* getJson(
            `/experiments?templateId=${template.id}`,
          )) as { ids: string[] };
          expect(listing.ids).toContain(started.id);

          // the wait-only experiment has no targets to resolve.
          const resolved = (yield* getJson(
            `/resolved-targets?id=${started.id}`,
          )) as { count: number };
          expect(resolved.count).toBe(0);

          // stop it so nothing lingers past the test.
          const stopped = (yield* postJson(`/stop?id=${started.id}`)) as {
            status: string;
          };
          expect(["stopping", "stopped"]).toContain(stopped.status);
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetAction + ListActions", () => {
    test.provider("reads the aws:fis:wait action catalog entry", (_stack) =>
      Effect.gen(function* () {
        const action = (yield* getJson("/action?id=aws:fis:wait")) as {
          id: string;
        };
        expect(action.id).toBe("aws:fis:wait");

        const listing = (yield* getJson("/actions")) as { ids: string[] };
        expect(listing.ids).toContain("aws:fis:wait");
      }),
    );
  });

  describe("GetTargetResourceType + ListTargetResourceTypes", () => {
    test.provider("reads the aws:ec2:instance target resource type", (_stack) =>
      Effect.gen(function* () {
        const type = (yield* getJson(
          "/target-resource-type?type=aws:ec2:instance",
        )) as { resourceType: string };
        expect(type.resourceType).toBe("aws:ec2:instance");

        const listing = (yield* getJson("/target-resource-types")) as {
          resourceTypes: string[];
        };
        expect(listing.resourceTypes).toContain("aws:ec2:instance");
      }),
    );
  });

  describe("GetSafetyLever", () => {
    test.provider("reads the account's default safety lever", (_stack) =>
      Effect.gen(function* () {
        const lever = (yield* getJson("/safety-lever")) as {
          id: string;
          status: string;
        };
        expect(lever.id).toBe("default");
        // Anything but disengaged would halt every experiment in the
        // account, so the suite asserts the steady state.
        expect(lever.status).toBe("disengaged");
      }),
    );
  });

  describe("consumeExperimentEvents", () => {
    test.provider(
      "the deploy created an EventBridge rule targeting the function",
      (_stack) =>
        Effect.gen(function* () {
          // Out-of-band via distilled: the fixture's consumeExperimentEvents
          // must have materialized as a rule on the default bus with the
          // Lambda as target.
          const { RuleNames } = yield* eventbridge.listRuleNamesByTarget({
            TargetArn: functionArn,
          });
          expect((RuleNames ?? []).length).toBeGreaterThanOrEqual(1);
        }),
    );
  });
});
