import * as AWS from "@/AWS";
import * as Lambda from "@/AWS/Lambda";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import LatticeTestFunctionLive, { LatticeTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "VpcLatticeBindings");

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

// Retry only 5xx (cold re-init, IAM propagation surfaced by the handler's
// `Effect.orDie` as a 500); a genuine 4xx/assertion failure surfaces
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
      while: (e): boolean => e._tag === "TransientUpstream",
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

describe.sequential("VpcLattice Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "VpcLattice bindings setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("VpcLattice bindings setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          const fn = yield* LatticeTestFunction;
          // Registering a Lambda target requires the function to allow
          // vpc-lattice.amazonaws.com to invoke it — RegisterTargets rejects
          // the target as `InvalidTarget` otherwise.
          yield* Lambda.Permission("LatticeInvokePermission", {
            action: "lambda:InvokeFunction",
            functionName: fn.functionName,
            principal: "vpc-lattice.amazonaws.com",
          });
          return fn;
        }).pipe(Effect.provide(LatticeTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");
      functionArn = attrs.functionArn;

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `VpcLattice bindings setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `VpcLattice bindings setup: fixture not ready yet (${String(error)})`,
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
          "deregisterTargets",
          "listTargets",
          "registerTargets",
        ]);
      }),
    );
  });

  describe("ListTargets", () => {
    test.provider(
      "lists an empty target group (injected target group id)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/targets")) as {
            targets: { id: string }[];
          };
          expect(response.targets).toEqual([]);
        }),
    );
  });

  describe("RegisterTargets / DeregisterTargets", () => {
    test.provider(
      "the function registers and deregisters itself as a Lambda target",
      (_stack) =>
        Effect.gen(function* () {
          // Register the fixture's own function ARN into the LAMBDA group.
          const registered = (yield* postJson("/register", {
            id: functionArn,
          })) as { successful: string[]; unsuccessful: unknown[] };
          expect(registered.unsuccessful).toEqual([]);
          expect(registered.successful).toEqual([functionArn]);

          // The registration is observable through the list binding.
          const listed = (yield* getJson("/targets")) as {
            targets: { id: string }[];
          };
          expect(listed.targets.map((t) => t.id)).toEqual([functionArn]);

          // Deregister so the shared stack destroy is drain-free.
          const deregistered = (yield* postJson("/deregister", {
            id: functionArn,
          })) as { successful: string[]; unsuccessful: unknown[] };
          expect(deregistered.unsuccessful).toEqual([]);
          expect(deregistered.successful).toEqual([functionArn]);
        }),
      { timeout: 120_000 },
    );
  });
});
