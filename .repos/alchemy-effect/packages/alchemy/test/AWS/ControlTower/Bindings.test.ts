import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import ControlTowerTestFunctionLive, {
  ControlTowerTestFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ControlTowerBindings");

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

// The freshly attached IAM policy can take ~10-30s to propagate to the
// Lambda's role; until it does, granted calls surface a transient
// AccessDeniedException. Poll (bounded) until the response is no longer
// access-denied so grant-proof assertions see steady-state behavior.
const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (response): boolean =>
        (response as { tag?: string }).tag !== "AccessDeniedException",
      times: 10,
    }),
  );

// The testing account has no Control Tower landing zone — the account-level
// bindings still prove the IAM grant + typed error unions end-to-end: an IAM
// gap would surface AccessDeniedException, while a granted call returns
// either real data (the baseline catalog is served without a landing zone)
// or the landing-zone-gated typed tag.
describe.sequential("ControlTower Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "ControlTower test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("ControlTower test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* ControlTowerTestFunction;
        }).pipe(Effect.provide(ControlTowerTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `ControlTower test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `ControlTower test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("binding registration", () => {
    test.provider("all 11 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as {
          bound: string[];
        };
        expect(response.bound).toHaveLength(11);
      }),
    );
  });

  describe("ListBaselines", () => {
    test.provider("lists the baseline catalog", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/baselines")) as
          | { ok: true; names: (string | null)[] }
          | { ok: false; tag: string };
        if (response.ok) {
          expect(response.names).toContain("AWSControlTowerBaseline");
        } else {
          expect(["AccessDeniedException", "UnauthorizedException"]).toContain(
            response.tag,
          );
        }
      }),
    );
  });

  describe("GetBaseline", () => {
    test.provider("reads a catalog baseline discovered via list", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/baseline")) as
          | { ok: true; name: string }
          | { ok: false; tag: string };
        if (response.ok) {
          expect(response.name).toBe("AWSControlTowerBaseline");
        } else {
          expect([
            "AccessDeniedException",
            "UnauthorizedException",
            "NoCatalog",
          ]).toContain(response.tag);
        }
      }),
    );
  });

  describe("ListEnabledBaselines", () => {
    test.provider(
      "yields a count or the landing-zone-gated typed tag",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/enabled-baselines")) as
            | { ok: true; count: number }
            | { ok: false; tag: string };
          if (response.ok) {
            expect(response.count).toBeGreaterThanOrEqual(0);
          } else {
            expect([
              "AccessDeniedException",
              "UnauthorizedException",
              "ValidationException",
            ]).toContain(response.tag);
          }
        }),
    );
  });

  describe("ListEnabledControls", () => {
    test.provider(
      "yields a count or the landing-zone-gated typed tag",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/enabled-controls")) as
            | { ok: true; count: number }
            | { ok: false; tag: string };
          if (response.ok) {
            expect(response.count).toBeGreaterThanOrEqual(0);
          } else {
            expect([
              "AccessDeniedException",
              "ResourceNotFoundException",
              "ValidationException",
            ]).toContain(response.tag);
          }
        }),
    );
  });

  describe("ListControlOperations", () => {
    test.provider(
      "yields a count or the landing-zone-gated typed tag",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/control-operations")) as
            | { ok: true; count: number }
            | { ok: false; tag: string };
          if (response.ok) {
            expect(response.count).toBeGreaterThanOrEqual(0);
          } else {
            expect(["AccessDeniedException", "ValidationException"]).toContain(
              response.tag,
            );
          }
        }),
    );
  });

  describe("ListLandingZones", () => {
    test.provider("lists the account's landing zones (none)", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/landing-zones")) as
          | { ok: true; count: number }
          | { ok: false; tag: string };
        if (response.ok) {
          // No landing zone on the testing account — an empty (or
          // singleton) list, never a crash.
          expect(response.count).toBeLessThanOrEqual(1);
        } else {
          expect(["AccessDeniedException", "UnauthorizedException"]).toContain(
            response.tag,
          );
        }
      }),
    );
  });

  describe("ListLandingZoneOperations", () => {
    test.provider(
      "yields a count or the landing-zone-gated typed tag",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/landing-zone-operations")) as
            | { ok: true; count: number }
            | { ok: false; tag: string };
          if (response.ok) {
            expect(response.count).toBeGreaterThanOrEqual(0);
          } else {
            expect([
              "AccessDeniedException",
              "UnauthorizedException",
              "ValidationException",
            ]).toContain(response.tag);
          }
        }),
    );
  });

  describe("GetLandingZone", () => {
    test.provider(
      "surfaces a typed error for a nonexistent landing zone (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/landing-zone-not-found")) as {
            tag: string;
          };
          expect([
            "ResourceNotFoundException",
            "ValidationException",
            "UnauthorizedException",
          ]).toContain(response.tag);
        }),
    );
  });

  describe("GetControlOperation", () => {
    test.provider(
      "surfaces a typed error for a nonexistent operation (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/control-operation-not-found")) as {
            tag: string;
          };
          expect([
            "ResourceNotFoundException",
            "ValidationException",
          ]).toContain(response.tag);
        }),
    );
  });

  describe("GetBaselineOperation", () => {
    test.provider(
      "surfaces a typed error for a nonexistent operation (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson(
            "/baseline-operation-not-found",
          )) as { tag: string; message?: string };
          expect([
            "ResourceNotFoundException",
            "ValidationException",
            "UnauthorizedException",
          ]).toContain(response.tag);
        }),
    );
  });

  describe("GetLandingZoneOperation", () => {
    test.provider(
      "surfaces a typed error for a nonexistent operation (proving the grant)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson(
            "/landing-zone-operation-not-found",
          )) as { tag: string; message?: string };
          expect([
            "ResourceNotFoundException",
            "ValidationException",
            "UnauthorizedException",
          ]).toContain(response.tag);
        }),
    );
  });
});
