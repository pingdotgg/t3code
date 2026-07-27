import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import MailManagerTestFunctionLive, {
  MailManagerTestFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "MailManagerBindings");

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

const getJson = (path: string) =>
  send(HttpClientRequest.get(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

const postJson = (path: string) =>
  send(HttpClientRequest.post(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

describe.sequential("MailManager Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "MailManager test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("MailManager test setup: deploying fixture");
      const attrs = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* MailManagerTestFunction;
        }).pipe(Effect.provide(MailManagerTestFunctionLive)),
      );

      expect(attrs.functionUrl).toBeTruthy();
      baseUrl = attrs.functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `MailManager test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `MailManager test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("binding registration", () => {
    test.provider("all ten capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* getJson("/bindings")) as { bound: string[] };
        expect(response.bound).toHaveLength(10);
      }),
    );
  });

  describe("address list members", () => {
    test.provider(
      "register -> get -> list -> deregister roundtrip (injected list id)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* postJson("/members/roundtrip")) as {
            registered: boolean;
            memberCount: number;
            goneAfterDeregister: boolean;
          };
          expect(response.registered).toBe(true);
          expect(response.memberCount).toBeGreaterThanOrEqual(1);
          expect(response.goneAfterDeregister).toBe(true);
        }),
      { timeout: 60_000 },
    );
  });

  describe("archive search", () => {
    test.provider(
      "start -> poll to completion -> zero rows on an empty archive",
      (_stack) =>
        Effect.gen(function* () {
          const { searchId } = (yield* postJson("/search/start")) as {
            searchId: string;
          };
          expect(searchId).toBeTruthy();

          const status = yield* getJson(
            `/search/status?searchId=${encodeURIComponent(searchId)}`,
          ).pipe(
            Effect.map((s) => s as { state?: string; errorMessage?: string }),
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (s: { state?: string }): boolean =>
                s.state === "COMPLETED" ||
                s.state === "FAILED" ||
                s.state === "CANCELLED",
              times: 24,
            }),
          );
          expect(status.state).toBe("COMPLETED");

          const results = (yield* getJson(
            `/search/results?searchId=${encodeURIComponent(searchId)}`,
          )) as { rowCount: number };
          expect(results.rowCount).toBe(0);
        }),
      { timeout: 180_000 },
    );
  });

  describe("archive + import job enumeration", () => {
    test.provider(
      "lists searches, exports, and import jobs (archive-scoped grants)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* getJson("/tasks")) as {
            searchCount: number;
            exportCount: number;
            importJobCount: number;
          };
          // The search test above ran first (sequential) — at least one
          // search is visible; no exports or import jobs were created.
          expect(response.searchCount).toBeGreaterThanOrEqual(1);
          expect(response.exportCount).toBe(0);
          expect(response.importJobCount).toBe(0);
        }),
    );
  });
});
