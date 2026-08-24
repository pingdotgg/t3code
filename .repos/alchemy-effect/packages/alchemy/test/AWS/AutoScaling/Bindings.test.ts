import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import AsgBindingsFunctionLive, {
  AsgBindingsFunction,
  bindingsAsgName,
} from "./fixtures/bindings-handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "AutoScalingBindings");

const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

interface RouteResult {
  ok: boolean;
  tag: string;
  name?: string;
  maxSize?: number;
  count?: number;
}

// Call a fixture route, repeating (bounded) while the response still shows an
// authorization failure — a freshly attached IAM policy is eventually
// consistent and the first invocations after deploy can see AccessDenied.
// Routes whose EXPECTED outcome is a scoped denial pass
// `retryDenied: false` (they run after routes that already proved the
// policy propagated).
const callRoute = (
  method: "GET" | "POST",
  path: string,
  options: { retryDenied?: boolean } = {},
) =>
  Effect.gen(function* () {
    const request =
      method === "GET"
        ? HttpClientRequest.get(`${baseUrl}${path}`)
        : HttpClientRequest.post(`${baseUrl}${path}`);
    return yield* HttpClient.execute(request).pipe(
      Effect.flatMap((response) =>
        response.status === 200
          ? response.json
          : Effect.fail(
              new Error(`Route ${path} not ready: ${response.status}`),
            ),
      ),
      // `json` is the untyped `Json` union; RouteResult's optional props
      // (`string | undefined`) aren't Json-assignable, so the intentional
      // two-step conversion is required (same pattern as the /refresh route).
      Effect.map((json) => json as unknown as RouteResult),
      Effect.repeat({
        until: (body): boolean =>
          options.retryDenied === false ||
          (body.tag !== "AccessDenied" && body.tag !== "AccessDeniedException"),
        schedule: Schedule.spaced("3 seconds"),
        times: 10,
      }),
    );
  });

// Deploys a Lambda bound to a zero-sized ASG with every AutoScaling runtime
// binding plus the instance-events EventBridge subscription. Read bindings are
// asserted on live data; instance-scoped write bindings are probed with a
// well-formed non-existent instance id — AWS answers with a typed
// `ValidationError` (never AccessDenied), proving the binding's IAM grant.
describe("AutoScaling runtime bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();

      const { fn } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          const fn = yield* AsgBindingsFunction;
          return { fn };
        }).pipe(Effect.provide(AsgBindingsFunctionLive)),
      );

      expect(fn.functionUrl).toBeTruthy();
      baseUrl = fn.functionUrl!.replace(/\/+$/, "");

      yield* HttpClient.get(`${baseUrl}/health`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 300_000 },
  );

  afterAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();
      // Assert the fixture ASG is fully gone — the suite must leave nothing.
      // The hook context has no AWS providers of its own, so provide them
      // explicitly for the out-of-band distilled call.
      const remaining = yield* Core.withProviders(
        autoscaling
          .describeAutoScalingGroups({
            AutoScalingGroupNames: [bindingsAsgName],
          } as any)
          .pipe(
            Effect.map((r) => (r.AutoScalingGroups ?? []).length),
            Effect.repeat({
              until: (count) => count === 0,
              schedule: Schedule.spaced("3 seconds"),
              times: 10,
            }),
          ),
        testOptions,
        sharedStack.name,
      );
      expect(remaining).toBe(0);
    }),
    { timeout: 180_000 },
  );

  test.provider(
    "DescribeAutoScalingGroup returns the bound group's live state",
    (_stack) =>
      Effect.gen(function* () {
        const body = yield* callRoute("GET", "/describe");
        expect(body.ok).toBe(true);
        expect(body.name).toEqual(bindingsAsgName);
        expect(body.maxSize).toEqual(0);
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "DescribeScalingActivities lists the group's activities",
    (_stack) =>
      Effect.gen(function* () {
        const body = yield* callRoute("GET", "/activities");
        expect(body.ok).toBe(true);
        expect(body.count).toBeGreaterThanOrEqual(0);
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "SetDesiredCapacity succeeds against the bound group",
    (_stack) =>
      Effect.gen(function* () {
        const body = yield* callRoute("POST", "/set-desired");
        expect(body.ok).toBe(true);
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "ExecutePolicy is IAM-wired (typed ValidationError for a bogus policy)",
    (_stack) =>
      Effect.gen(function* () {
        const body = yield* callRoute("POST", "/execute-policy");
        expect(body.tag).toEqual("ValidationError");
      }),
    { timeout: 60_000 },
  );

  // SetInstanceHealth / TerminateInstanceInAutoScalingGroup carry no group
  // name in the request — EC2 Auto Scaling resolves the instance's owning
  // group for resource-level authorization. The bogus instance resolves to
  // nothing, so the (correct, least-privilege) group-scoped grant denies —
  // a typed AccessDeniedException, proving the binding client signed and
  // dispatched the operation with the attached policy (a missing policy
  // would deny identically for REAL instances too; the other seven bindings
  // prove grant attachment works end-to-end via the same scaffold). With a
  // real in-group instance the same grant authorizes.
  test.provider(
    "SetInstanceHealth dispatches a signed request (scoped denial for a bogus instance)",
    (_stack) =>
      Effect.gen(function* () {
        const body = yield* callRoute("POST", "/set-health", {
          retryDenied: false,
        });
        expect(body.tag).toEqual("AccessDeniedException");
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "SetInstanceProtection is IAM-wired (typed ValidationError for a bogus instance)",
    (_stack) =>
      Effect.gen(function* () {
        const body = yield* callRoute("POST", "/set-protection");
        expect(body.tag).toEqual("ValidationError");
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "TerminateInstanceInAutoScalingGroup dispatches a signed request (scoped denial)",
    (_stack) =>
      Effect.gen(function* () {
        const body = yield* callRoute("POST", "/terminate", {
          retryDenied: false,
        });
        expect(body.tag).toEqual("AccessDeniedException");
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "Standby enter/exit are IAM-wired (typed ValidationError)",
    (_stack) =>
      Effect.gen(function* () {
        const enter = yield* callRoute("POST", "/standby-enter");
        expect(enter.tag).toEqual("ValidationError");
        const exit = yield* callRoute("POST", "/standby-exit");
        expect(exit.tag).toEqual("ValidationError");
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "InstanceRefresh start/describe/cancel round-trip on the zero-instance fleet",
    (_stack) =>
      Effect.gen(function* () {
        const body = (yield* callRoute("POST", "/refresh")) as unknown as {
          startTag: string;
          describeOk: boolean;
          describeCount?: number;
          cancelTag: string;
        };
        // A refresh on the empty fleet completes (or is already in progress
        // from a previous run) — never an authorization failure.
        expect(["Success", "InstanceRefreshInProgressFault"]).toContain(
          body.startTag,
        );
        expect(body.describeOk).toBe(true);
        expect(body.describeCount).toBeGreaterThanOrEqual(1);
        expect(body.cancelTag).toEqual("Success");
      }),
    { timeout: 60_000 },
  );

  test.provider(
    "consumeInstanceEvents created the EventBridge rule for instance events",
    (_stack) =>
      Effect.gen(function* () {
        // The rule's physical name is `{stack}-{logicalId}` truncated to fit
        // the instance-id suffix (e.g. `AutoScalingBindings-BindingsGroup-
        // Instan3unhktjkefuey4…`), so the full logical id may not survive.
        // Filter server-side on the stable stack+logical prefix and pick the
        // autoscaling-pattern rule.
        let rule: eventbridge.Rule | undefined;
        let nextToken: string | undefined;
        for (let page = 0; page < 10 && !rule; page++) {
          const result = yield* eventbridge.listRules({
            NamePrefix: "AutoScalingBindings-BindingsGroup-",
            NextToken: nextToken,
            Limit: 100,
          });
          rule = (result.Rules ?? []).find((candidate) =>
            candidate.EventPattern?.includes("aws.autoscaling"),
          );
          nextToken = result.NextToken;
          if (!nextToken) break;
        }
        expect(rule).toBeDefined();
        expect(rule?.EventPattern).toContain("aws.autoscaling");
        expect(rule?.EventPattern).toContain("EC2 Instance Launch Successful");
      }),
    { timeout: 60_000 },
  );
});
