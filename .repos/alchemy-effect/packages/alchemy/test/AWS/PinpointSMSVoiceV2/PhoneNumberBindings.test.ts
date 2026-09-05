import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import SmsVoicePhoneTestFunctionLive, {
  SmsVoicePhoneTestFunction,
} from "./fixtures/phone-handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "SmsVoicePhoneBindings");

const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(60),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

const post = (path: string) =>
  HttpClient.execute(HttpClientRequest.post(`${baseUrl}${path}`)).pipe(
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
        Schedule.exponential("1 second"),
        Schedule.recurs(5),
      ]),
    }),
  );

// Leasing even a SIMULATOR number incurs a (small) monthly fee and
// consumes account quota, so this fixture is gated behind
// AWS_TEST_PINPOINT_SMS=1 like the PhoneNumber lifecycle test. The suite
// skips clean without the flag.
describe.skipIf(!process.env.AWS_TEST_PINPOINT_SMS)(
  "PinpointSMSVoiceV2 PhoneNumber Bindings",
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* Effect.logInfo(
          "SmsVoice phone bindings setup: destroying previous resources",
        );
        yield* sharedStack.destroy();

        yield* Effect.logInfo(
          "SmsVoice phone bindings setup: deploying fixture",
        );
        const { functionUrl } = yield* sharedStack.deploy(
          Effect.gen(function* () {
            return yield* SmsVoicePhoneTestFunction;
          }).pipe(Effect.provide(SmsVoicePhoneTestFunctionLive)),
        );

        expect(functionUrl).toBeTruthy();
        baseUrl = functionUrl!.replace(/\/+$/, "");
        const readinessUrl = `${baseUrl}/ping`;

        yield* Effect.logInfo(
          `SmsVoice phone bindings setup: probing readiness at ${readinessUrl}`,
        );
        yield* HttpClient.get(readinessUrl).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? Effect.succeed(response)
              : Effect.fail(
                  new Error(`Function not ready: ${response.status}`),
                ),
          ),
          Effect.tapError((error) =>
            Effect.logWarning(
              `SmsVoice phone bindings setup: fixture not ready yet (${String(error)})`,
            ),
          ),
          Effect.retry({ schedule: readinessPolicy }),
        );
      }),
      { timeout: 240_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 240_000 });

    describe("PinpointSMSVoiceV2.SendTextMessage", () => {
      test.provider(
        "sends an SMS to the simulator destination",
        (_stack) =>
          Effect.gen(function* () {
            const response = (yield* post("/send-text").pipe(
              Effect.flatMap((r) => r.json),
            )) as { messageId?: string };

            expect(typeof response.messageId).toBe("string");
            expect(response.messageId!.length).toBeGreaterThan(0);
          }),
        { timeout: 120_000 },
      );
    });

    describe("PinpointSMSVoiceV2.SendVoiceMessage", () => {
      test.provider(
        "the grant allows the send (typed capability verdict otherwise)",
        (_stack) =>
          Effect.gen(function* () {
            const response = (yield* post("/send-voice").pipe(
              Effect.flatMap((r) => r.json),
            )) as {
              ok: boolean;
              messageId?: string;
              tag?: string;
              message?: string;
            };

            // The SIMULATOR number is SMS-only; a typed capability
            // rejection still proves the binding + IAM grant.
            expect(response.tag, JSON.stringify(response)).not.toBe(
              "AccessDeniedException",
            );
            if (response.ok) {
              expect(response.messageId).toBeTruthy();
            }
          }),
        { timeout: 120_000 },
      );
    });

    describe("PinpointSMSVoiceV2.SendMediaMessage", () => {
      test.provider(
        "the grant allows the send (typed capability verdict otherwise)",
        (_stack) =>
          Effect.gen(function* () {
            const response = (yield* post("/send-media").pipe(
              Effect.flatMap((r) => r.json),
            )) as {
              ok: boolean;
              messageId?: string;
              tag?: string;
              message?: string;
            };

            expect(response.tag, JSON.stringify(response)).not.toBe(
              "AccessDeniedException",
            );
            if (response.ok) {
              expect(response.messageId).toBeTruthy();
            }
          }),
        { timeout: 120_000 },
      );
    });

    describe("PinpointSMSVoiceV2 Keywords", () => {
      test.provider(
        "put, list, and delete a keyword on the number",
        (_stack) =>
          Effect.gen(function* () {
            const put = (yield* post("/keyword-put").pipe(
              Effect.flatMap((r) => r.json),
            )) as { keyword?: string; message?: string };
            expect(put.keyword).toBe("INFO");
            expect(put.message).toContain("alchemy.run");

            const list = (yield* post("/keyword-list").pipe(
              Effect.flatMap((r) => r.json),
            )) as { keywords: string[] };
            expect(list.keywords).toContain("INFO");

            const deleted = (yield* post("/keyword-delete").pipe(
              Effect.flatMap((r) => r.json),
            )) as { deleted?: string };
            expect(deleted.deleted).toBe("INFO");

            const after = (yield* post("/keyword-list").pipe(
              Effect.flatMap((r) => r.json),
            )) as { keywords: string[] };
            expect(after.keywords).not.toContain("INFO");
          }),
        { timeout: 120_000 },
      );
    });
  },
);
