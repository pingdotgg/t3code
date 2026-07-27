import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import IoTBindingsFunctionLive, {
  IoTBindingsFunction,
  RETAINED_TOPIC,
} from "./iot-bindings-handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "IoTBindings");

// Bound environment propagation can lag the code update; keep the readiness
// wait bounded to about 50 seconds.
const readinessPolicy = Schedule.max([
  Schedule.fixed("5 seconds"),
  Schedule.recurs(10),
]);

let baseUrl: string;
let thingName: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

class NotYetConsistent extends Data.TaggedError("NotYetConsistent")<{
  readonly what: string;
}> {}

// Retry transient 5xx (cold re-init, IAM propagation surfaced by the
// handler's Effect.orDie as a 500). Genuine 4xx returns immediately.
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

const postJson = (path: string, body: unknown) =>
  send(
    HttpClientRequest.bodyJsonUnsafe(
      HttpClientRequest.post(`${baseUrl}${path}`),
      body,
    ),
  ).pipe(Effect.flatMap((r) => r.json));

const del = (path: string) =>
  send(HttpClientRequest.delete(`${baseUrl}${path}`)).pipe(
    Effect.flatMap((r) => r.json),
  );

describe("IoT Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();

      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* IoTBindingsFunction;
        }).pipe(Effect.provide(IoTBindingsFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      // Readiness requires `thingName` to be present, not just a 200: the
      // function is pre-created as a stub (no env) and the env-carrying
      // UpdateFunctionConfiguration is async, so the very first execution
      // environment can serve with stale env. Retry until a fresh
      // environment picks up the bound env.
      const ready = yield* HttpClient.get(`${baseUrl}/ready`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? (response.json as Effect.Effect<{ thingName?: string }>)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.flatMap((body) =>
          body.thingName
            ? Effect.succeed(body as { thingName: string })
            : Effect.fail(new Error("Function env not yet propagated")),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
      thingName = ready.thingName;
      expect(thingName).toBeTruthy();
    }),
    { timeout: 240_000 },
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
    timeout: 120_000,
  });

  describe("UpdateThingShadow / GetThingShadow", () => {
    test.provider(
      "writes and reads the classic shadow",
      (_stack) =>
        Effect.gen(function* () {
          const update = (yield* postJson("/shadow", {
            state: { desired: { led: "on" } },
          })) as { ok: boolean };
          expect(update.ok).toBe(true);

          const shadow = (yield* getJson("/shadow")) as {
            found: boolean;
            payload?: string;
          };
          expect(shadow.found).toBe(true);
          expect(JSON.parse(shadow.payload!).state.desired.led).toBe("on");
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "writes and reads a named shadow",
      (_stack) =>
        Effect.gen(function* () {
          yield* postJson("/shadow?shadowName=telemetry", {
            shadowName: "telemetry",
            state: { reported: { t: 22.5 } },
          });

          const shadow = (yield* getJson("/shadow?shadowName=telemetry")) as {
            found: boolean;
            payload?: string;
          };
          expect(shadow.found).toBe(true);
          expect(JSON.parse(shadow.payload!).state.reported.t).toBe(22.5);
        }),
      { timeout: 120_000 },
    );
  });

  describe("ListNamedShadowsForThing", () => {
    test.provider(
      "lists the named shadow",
      (_stack) =>
        Effect.gen(function* () {
          yield* postJson("/shadow", {
            shadowName: "inventory",
            state: { reported: { count: 1 } },
          });

          // Named-shadow listing is eventually consistent.
          const result = yield* getJson("/shadow/list").pipe(
            Effect.flatMap((r) => {
              const { results } = r as { results: string[] };
              return results.includes("inventory")
                ? Effect.succeed(results)
                : Effect.fail(new NotYetConsistent({ what: "shadow list" }));
            }),
            Effect.retry({
              while: (e): boolean => e._tag === "NotYetConsistent",
              schedule: Schedule.max([
                Schedule.fixed("2 seconds"),
                Schedule.recurs(10),
              ]),
            }),
          );
          expect(result).toContain("inventory");
        }),
      { timeout: 120_000 },
    );
  });

  describe("DeleteThingShadow", () => {
    test.provider(
      "deletes a named shadow",
      (_stack) =>
        Effect.gen(function* () {
          yield* postJson("/shadow", {
            shadowName: "doomed",
            state: { reported: { alive: true } },
          });

          const deleted = (yield* del("/shadow?shadowName=doomed")) as {
            ok: boolean;
          };
          expect(deleted.ok).toBe(true);

          const shadow = (yield* getJson("/shadow?shadowName=doomed")) as {
            found: boolean;
          };
          expect(shadow.found).toBe(false);
        }),
      { timeout: 120_000 },
    );
  });

  describe("DescribeThing", () => {
    test.provider(
      "reads the thing's registry entry",
      (_stack) =>
        Effect.gen(function* () {
          const result = (yield* getJson("/thing")) as {
            thingName: string;
            attributes: Record<string, string>;
          };
          expect(result.thingName).toBe(thingName);
          expect(result.attributes.purpose).toBe("bindings-test");
        }),
      { timeout: 120_000 },
    );
  });

  describe("ListThings", () => {
    test.provider(
      "lists the deployed thing",
      (_stack) =>
        Effect.gen(function* () {
          // Registry listing is eventually consistent.
          const names = yield* getJson("/things").pipe(
            Effect.flatMap((r) => {
              const { thingNames } = r as { thingNames: string[] };
              return thingNames.includes(thingName)
                ? Effect.succeed(thingNames)
                : Effect.fail(new NotYetConsistent({ what: "thing list" }));
            }),
            Effect.retry({
              while: (e): boolean => e._tag === "NotYetConsistent",
              schedule: Schedule.max([
                Schedule.fixed("2 seconds"),
                Schedule.recurs(10),
              ]),
            }),
          );
          expect(names).toContain(thingName);
        }),
      { timeout: 120_000 },
    );
  });

  describe("DescribeEndpoint", () => {
    test.provider(
      "returns the account's ATS data endpoint",
      (_stack) =>
        Effect.gen(function* () {
          const result = (yield* getJson("/endpoint")) as {
            endpointAddress?: string;
          };
          expect(result.endpointAddress).toBeTruthy();
          expect(result.endpointAddress).toContain("iot");
          expect(result.endpointAddress).toContain("amazonaws.com");
        }),
      { timeout: 120_000 },
    );
  });

  describe("Publish / GetRetainedMessage / ListRetainedMessages", () => {
    test.provider(
      "publishes a retained message, reads it back, lists it, and clears it",
      (_stack) =>
        Effect.gen(function* () {
          const marker = "retained-marker-1";
          yield* postJson("/retained", {
            topic: RETAINED_TOPIC,
            payload: JSON.stringify({ marker }),
          });

          // Retained-message read is eventually consistent after publish.
          const read = yield* getJson(
            `/retained?topic=${encodeURIComponent(RETAINED_TOPIC)}`,
          ).pipe(
            Effect.flatMap((r) => {
              const result = r as { found: boolean; payload?: string };
              return result.found
                ? Effect.succeed(result)
                : Effect.fail(
                    new NotYetConsistent({ what: "retained message" }),
                  );
            }),
            Effect.retry({
              while: (e): boolean => e._tag === "NotYetConsistent",
              schedule: Schedule.max([
                Schedule.fixed("2 seconds"),
                Schedule.recurs(10),
              ]),
            }),
          );
          expect(JSON.parse(read.payload!).marker).toBe(marker);

          const listed = (yield* getJson("/retained/list")) as {
            topics: string[];
          };
          expect(listed.topics).toContain(RETAINED_TOPIC);

          // Clear the retained message (empty retained payload) so the
          // account carries no leftovers after the test.
          yield* postJson("/retained", { topic: RETAINED_TOPIC });
          const cleared = yield* getJson(
            `/retained?topic=${encodeURIComponent(RETAINED_TOPIC)}`,
          ).pipe(
            Effect.flatMap((r) => {
              const result = r as { found: boolean };
              return result.found
                ? Effect.fail(new NotYetConsistent({ what: "retained clear" }))
                : Effect.succeed(result);
            }),
            Effect.retry({
              while: (e): boolean => e._tag === "NotYetConsistent",
              schedule: Schedule.max([
                Schedule.fixed("2 seconds"),
                Schedule.recurs(10),
              ]),
            }),
          );
          expect(cleared.found).toBe(false);
        }),
      { timeout: 120_000 },
    );
  });

  describe("GetConnection", () => {
    test.provider(
      "returns a typed ResourceNotFoundException for a never-connected client",
      (_stack) =>
        Effect.gen(function* () {
          const result = (yield* getJson(
            "/connection?clientId=alchemy-bindings-nonexistent",
          )) as { ok: boolean; tag?: string; connected?: boolean };
          if (result.ok) {
            // Some accounts report never-connected clients as disconnected
            // instead of missing.
            expect(result.connected).toBe(false);
          } else {
            expect(result.tag).toBe("ResourceNotFoundException");
          }
        }),
      { timeout: 120_000 },
    );
  });

  describe("ListSubscriptions", () => {
    test.provider(
      "returns a typed ResourceNotFoundException for a never-connected client",
      (_stack) =>
        Effect.gen(function* () {
          const result = (yield* getJson(
            "/subscriptions?clientId=alchemy-bindings-nonexistent",
          )) as { ok: boolean; tag?: string; subscriptions?: unknown[] };
          if (result.ok) {
            expect(result.subscriptions).toEqual([]);
          } else {
            expect(result.tag).toBe("ResourceNotFoundException");
          }
        }),
      { timeout: 120_000 },
    );
  });

  describe("DeleteConnection", () => {
    test.provider(
      "returns a typed ResourceNotFoundException for a never-connected client",
      (_stack) =>
        Effect.gen(function* () {
          const result = (yield* del(
            "/connection?clientId=alchemy-bindings-nonexistent",
          )) as { ok: boolean; tag?: string };
          expect(result.ok).toBe(false);
          expect(result.tag).toBe("ResourceNotFoundException");
        }),
      { timeout: 120_000 },
    );
  });

  describe("SendDirectMessage", () => {
    test.provider(
      "returns a typed ResourceNotFoundException for a never-connected client",
      (_stack) =>
        Effect.gen(function* () {
          const result = (yield* postJson("/direct", {
            clientId: "alchemy-bindings-nonexistent",
            topic: "commands/noop",
            payload: JSON.stringify({ noop: true }),
          })) as { ok: boolean; tag?: string };
          expect(result.ok).toBe(false);
          expect(result.tag).toBe("ResourceNotFoundException");
        }),
      { timeout: 120_000 },
    );
  });
});
