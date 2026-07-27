import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import GaTestFunctionLive, { GaTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "GABindings");

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

// Retry only 5xx (cold re-init, IAM propagation, and Global Accelerator's
// per-accelerator transaction serialization surfacing as
// TransactionInProgressException through the handler's `Effect.orDie`); a
// genuine 4xx/assertion failure surfaces immediately.
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
    Effect.tapError((e) =>
      e._tag === "TransientUpstream"
        ? Effect.logWarning(
            `transient upstream ${e.status}: ${e.body.slice(0, 500)}`,
          )
        : Effect.void,
    ),
    Effect.retry({
      while: (e): boolean => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(8),
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

describe.sequential("GlobalAccelerator Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("GA test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("GA test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* GaTestFunction;
        }).pipe(Effect.provide(GaTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `GA test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `GA test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 300_000 });

  describe("binding registration", () => {
    test.provider("all four capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(4);
      }),
    );
  });

  describe("DescribeAccelerator", () => {
    test.provider(
      "reads the bound accelerator's state (injected ARN)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/accelerator")) as {
            name: string;
            status: string;
            dnsName: string;
            enabled: boolean;
          };
          expect(response.dnsName).toContain(".awsglobalaccelerator.com");
          expect(response.enabled).toBe(true);
          expect(["DEPLOYED", "IN_PROGRESS"]).toContain(response.status);
        }),
    );
  });

  describe("DescribeEndpointGroup", () => {
    test.provider(
      "reads the bound endpoint group's state (injected ARN)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/group")) as {
            region: string;
            endpoints: { endpointId: string; healthState: string }[];
          };
          expect(response.region).toEqual("us-west-2");
        }),
    );
  });

  describe("AddEndpoints / RemoveEndpoints", () => {
    test.provider(
      "registers and deregisters an Elastic IP endpoint at runtime",
      (_stack) =>
        Effect.gen(function* () {
          // Global Accelerator serializes changes per accelerator: mutating
          // while the create/update transaction from the deploy is still
          // IN_PROGRESS fails with TransactionInProgressException. Wait for
          // DEPLOYED (bounded) before driving Add/RemoveEndpoints.
          const accelerator = yield* getJson("/accelerator").pipe(
            Effect.map((a) => a as { status: string }),
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (a): boolean => a.status === "DEPLOYED",
              times: 36,
            }),
          );
          expect(accelerator.status).toEqual("DEPLOYED");

          const { allocationId } = (yield* getJson("/context")) as {
            allocationId: string;
          };
          expect(allocationId).toMatch(/^eipalloc-/);

          // Register — the response echoes the endpoint back.
          const added = (yield* postJson("/endpoints/add")) as {
            added: string[];
          };
          expect(added.added, JSON.stringify(added)).toContain(allocationId);

          // The group's observed state now includes the Elastic IP.
          const group = yield* getJson("/group").pipe(
            Effect.map((g) => g as { endpoints: { endpointId: string }[] }),
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (g): boolean =>
                g.endpoints.some(
                  (endpoint) => endpoint.endpointId === allocationId,
                ),
              times: 10,
            }),
          );
          expect(
            group.endpoints.map((endpoint) => endpoint.endpointId),
          ).toContain(allocationId);

          // Deregister and observe it gone.
          const removed = (yield* postJson("/endpoints/remove")) as {
            removed: string;
          };
          expect(removed.removed, JSON.stringify(removed)).toEqual(
            allocationId,
          );

          const drained = yield* getJson("/group").pipe(
            Effect.map((g) => g as { endpoints: { endpointId: string }[] }),
            Effect.repeat({
              schedule: Schedule.spaced("3 seconds"),
              until: (g): boolean =>
                g.endpoints.every(
                  (endpoint) => endpoint.endpointId !== allocationId,
                ),
              times: 10,
            }),
          );
          expect(
            drained.endpoints.map((endpoint) => endpoint.endpointId),
          ).not.toContain(allocationId);
        }),
      // Covers the (bounded) wait for the accelerator's deploy transaction
      // to reach DEPLOYED plus the add/observe/remove/observe cycle.
      { timeout: 300_000 },
    );
  });
});
