import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as smsvoice from "@distilled.cloud/aws/pinpoint-sms-voice-v2";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import SmsVoiceOptOutTestFunctionLive, {
  SmsVoiceOptOutTestFunction,
  TEST_DESTINATION,
} from "./fixtures/optout-handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "SmsVoiceBindings");

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

// Ungated typed-error probes: prove the distilled error unions carry the
// tags the bindings and tests depend on.
test.provider(
  "describeKeywords on a nonexistent origination identity fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        smsvoice.describeKeywords({
          OriginationIdentity: "phone-ffffffffffffffffffffffffffffffff",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 60_000 },
);

test.provider(
  "putOptedOutNumber on a nonexistent opt-out list fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        smsvoice.putOptedOutNumber({
          OptOutListName: "alchemy-nonexistent-opt-out-list",
          OptedOutNumber: TEST_DESTINATION,
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 60_000 },
);

describe("PinpointSMSVoiceV2 Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "SmsVoice bindings setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("SmsVoice bindings setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* SmsVoiceOptOutTestFunction;
        }).pipe(Effect.provide(SmsVoiceOptOutTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/ping`;

      yield* Effect.logInfo(
        `SmsVoice bindings setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `SmsVoice bindings setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );

      // Freshly attached IAM role policies take a few seconds to
      // propagate — hold the tests until the account-level grant works
      // (the probe returns AccessDeniedException until then).
      yield* post("/feedback-probe").pipe(
        Effect.flatMap((r) => r.json),
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (body): boolean =>
            (body as { tag?: string }).tag !== "AccessDeniedException",
          times: 20,
        }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
    timeout: 120_000,
  });

  describe("PinpointSMSVoiceV2.PutOptedOutNumber", () => {
    test.provider(
      "opts a destination number out",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* post("/opt-out").pipe(
            Effect.flatMap((r) => r.json),
          )) as { optedOutNumber?: string; endUserOptedOut?: boolean };

          expect(response.optedOutNumber).toBe(TEST_DESTINATION);
          // Manually opted out (by the API), not by the end user.
          expect(response.endUserOptedOut).toBe(false);
        }),
      { timeout: 120_000 },
    );
  });

  describe("PinpointSMSVoiceV2.DescribeOptedOutNumbers", () => {
    test.provider(
      "finds the opted-out number",
      (_stack) =>
        Effect.gen(function* () {
          // /opt-out is idempotent for a manually-opted-out number's
          // presence — ensure it exists, then check.
          yield* post("/opt-out");
          const response = (yield* post("/opt-out-check").pipe(
            Effect.flatMap((r) => r.json),
          )) as { count: number; numbers: string[] };

          expect(response.count).toBe(1);
          expect(response.numbers).toContain(TEST_DESTINATION);
        }),
      { timeout: 120_000 },
    );
  });

  describe("PinpointSMSVoiceV2.DeleteOptedOutNumber", () => {
    test.provider(
      "opts the number back in",
      (_stack) =>
        Effect.gen(function* () {
          yield* post("/opt-out");
          const deleted = (yield* post("/opt-out-delete").pipe(
            Effect.flatMap((r) => r.json),
          )) as {
            ok: boolean;
            deleted?: string;
            tag?: string;
            message?: string;
          };
          expect(deleted.ok, JSON.stringify(deleted)).toBe(true);
          expect(deleted.deleted).toBe(TEST_DESTINATION);

          const after = (yield* post("/opt-out-check").pipe(
            Effect.flatMap((r) => r.json),
          )) as { count: number };
          expect(after.count).toBe(0);
        }),
      { timeout: 120_000 },
    );
  });

  describe("PinpointSMSVoiceV2.CarrierLookup", () => {
    test.provider(
      "the grant allows the lookup",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* post("/carrier-lookup").pipe(
            Effect.flatMap((r) => r.json),
          )) as {
            ok: boolean;
            e164PhoneNumber?: string;
            phoneNumberType?: string;
            tag?: string;
            message?: string;
          };

          // The simulator number may be rejected as unsupported by the
          // lookup provider — the binding is proven as long as IAM let
          // the call through.
          expect(response.tag, JSON.stringify(response)).not.toBe(
            "AccessDeniedException",
          );
          if (response.ok) {
            expect(response.e164PhoneNumber).toBe(TEST_DESTINATION);
            expect(response.phoneNumberType).toBeTruthy();
          }
        }),
      { timeout: 120_000 },
    );
  });

  describe("PinpointSMSVoiceV2.PutMessageFeedback", () => {
    test.provider(
      "surfaces the typed ResourceNotFoundException for an unknown message",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* post("/feedback-probe").pipe(
            Effect.flatMap((r) => r.json),
          )) as { ok: boolean; tag?: string; message?: string };

          // The grant is on `*`; an unknown MessageId must surface the
          // typed not-found tag (AccessDenied would mean a broken grant).
          expect(response.ok).toBe(false);
          expect(response.tag, JSON.stringify(response)).toBe(
            "ResourceNotFoundException",
          );
        }),
      { timeout: 120_000 },
    );
  });
});
