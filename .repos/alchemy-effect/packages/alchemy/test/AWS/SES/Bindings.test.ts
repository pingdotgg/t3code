import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import SESTestFunctionLive, { SESTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "SESBindings");

// The account is in the SES sandbox with no verified identities: sends from
// the fixture's (unverified) domain identity fail with the typed
// MessageRejected tag — that IS the ungated assertion. Set AWS_TEST_SES_FROM
// to a verified from-address to exercise the success path.
const VERIFIED_FROM = process.env.AWS_TEST_SES_FROM;

// A syntactically valid address at the fixture's (unverified) domain
// identity — SES rejects it with the typed MessageRejected tag in sandbox.
const UNVERIFIED_FROM = "noreply@ses-bindings.alchemy-test.example.com";

// Deterministic address the suppression-list tests add and remove. The test
// ends by deleting it, so repeated runs leave no residue.
const SUPPRESSED_ADDRESS = "suppressed@ses-bindings.alchemy-test.example.com";

const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Retry transient 5xx only; a genuine 4xx/assertion failure surfaces
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
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
  );

describe("SES Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("SES test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("SES test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* SESTestFunction;
        }).pipe(Effect.provide(SESTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/health`;

      yield* Effect.logInfo(
        `SES test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `SES test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );

      // The freshly attached role policy takes a while to propagate through
      // IAM — poll the send route until SES stops answering AccessDenied so
      // the tests below observe the real (sandbox) behavior.
      yield* HttpClient.execute(
        HttpClientRequest.post(
          `${baseUrl}/send-simple?from=${encodeURIComponent(UNVERIFIED_FROM)}`,
        ),
      ).pipe(
        Effect.flatMap((r) => r.json),
        Effect.flatMap((body) =>
          (body as { error?: string }).error === "AccessDeniedException"
            ? Effect.fail(new Error("IAM policy not propagated yet"))
            : Effect.succeed(body),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `SES test setup: send not authorized yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("SendEmail", () => {
    test.provider(
      "sandbox: unverified sender surfaces the typed MessageRejected tag through the binding",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.post(
              `${baseUrl}/send-simple?from=${encodeURIComponent(UNVERIFIED_FROM)}`,
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            messageId?: string;
            error?: string;
            message?: string;
          };

          // Sandbox + unverified FROM identity: SES rejects the message with
          // the typed MessageRejected error ("Email address is not
          // verified"). This proves the binding wires IAM + request
          // marshalling correctly all the way into the deployed Lambda.
          expect(response.error).toBe("MessageRejected");
          expect(response.message).toContain("not verified");
        }),
    );

    test.provider(
      "sandbox: templated send is rejected with the same typed tag",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.post(
              `${baseUrl}/send-template?from=${encodeURIComponent(UNVERIFIED_FROM)}`,
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            messageId?: string;
            error?: string;
          };
          expect(response.error).toBe("MessageRejected");
        }),
    );

    test.provider.skipIf(!VERIFIED_FROM)(
      "sends to the mailbox simulator from a verified identity (AWS_TEST_SES_FROM)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.post(
              `${baseUrl}/send-simple?from=${encodeURIComponent(VERIFIED_FROM!)}`,
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            messageId?: string;
            error?: string;
            message?: string;
          };

          expect(response.error).toBeUndefined();
          expect(response.messageId).toBeTruthy();
        }),
    );

    test.provider.skipIf(!VERIFIED_FROM)(
      "sends without a configuration set (AWS_TEST_SES_FROM)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.post(
              `${baseUrl}/send-plain?from=${encodeURIComponent(VERIFIED_FROM!)}`,
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            messageId?: string;
            error?: string;
          };
          expect(response.error).toBeUndefined();
          expect(response.messageId).toBeTruthy();
        }),
    );
  });

  describe("SendBulkEmail", () => {
    test.provider(
      "sandbox: bulk templated send from an unverified sender is rejected with the typed tag",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.post(
              `${baseUrl}/send-bulk?from=${encodeURIComponent(UNVERIFIED_FROM)}`,
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            error?: string;
            results?: { status?: string; messageId?: string }[];
          };

          // Sandbox + unverified FROM: SES rejects either the whole request
          // (typed MessageRejected) or the individual entry
          // (Status MESSAGE_REJECTED) — both prove the binding wires IAM and
          // request marshalling into the deployed Lambda.
          if (response.error !== undefined) {
            expect(response.error).toBe("MessageRejected");
          } else {
            expect(response.results?.[0]?.status).toBe("MESSAGE_REJECTED");
          }
        }),
    );
  });

  describe("RenderEmailTemplate", () => {
    test.provider(
      "renders the bound template server-side with personalization data",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.post(`${baseUrl}/render-template`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            rendered?: string;
            error?: string;
          };
          expect(response.error).toBeUndefined();
          expect(response.rendered).toContain("Hello, Ada!");
        }),
    );
  });

  describe("GetAccount", () => {
    test.provider("reads the account's sending status and quota", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.get(`${baseUrl}/account`),
        ).pipe(Effect.flatMap((r) => r.json))) as {
          sendingEnabled?: boolean;
          productionAccess?: boolean;
          max24HourSend?: number;
          error?: string;
        };
        expect(response.error).toBeUndefined();
        expect(typeof response.sendingEnabled).toBe("boolean");
        expect(typeof response.productionAccess).toBe("boolean");
      }),
    );
  });

  describe("Suppression List", () => {
    test.provider(
      "sandbox: reads work and the write surfaces the typed BadRequestException",
      (_stack) =>
        Effect.gen(function* () {
          const email = encodeURIComponent(SUPPRESSED_ADDRESS);

          // put — sandbox accounts cannot write to the suppression list;
          // SES rejects with the typed BadRequestException ("Your account
          // is still in the sandbox."). That proves the binding wires IAM
          // and marshalling into the deployed Lambda.
          const put = (yield* send(
            HttpClientRequest.post(`${baseUrl}/suppress?email=${email}`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            error?: string;
            message?: string;
          };
          if (put.error === undefined) {
            // Production account: the write succeeded — clean up and let
            // the gated lifecycle test below cover the full flow.
            yield* send(
              HttpClientRequest.post(`${baseUrl}/unsuppress?email=${email}`),
            );
          } else {
            expect(put.error).toBe("BadRequestException");
            expect(put.message).toContain("sandbox");

            // get of a never-suppressed address — typed NotFoundException.
            const missing = (yield* send(
              HttpClientRequest.get(`${baseUrl}/suppressed?email=${email}`),
            ).pipe(Effect.flatMap((r) => r.json))) as { error?: string };
            expect(missing.error).toBe("NotFoundException");
          }

          // list — the read plane works even in the sandbox.
          const list = (yield* send(
            HttpClientRequest.get(`${baseUrl}/suppressed-list`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            emails?: string[];
            error?: string;
          };
          expect(list.error).toBeUndefined();
          expect(Array.isArray(list.emails)).toBe(true);
        }),
    );

    // Full write lifecycle needs production access (the sandbox blocks
    // PutSuppressedDestination with BadRequestException: "Your account is
    // still in the sandbox.") — gated with the same env var as real sends.
    test.provider.skipIf(!VERIFIED_FROM)(
      "put, get, list, and delete a suppressed destination (AWS_TEST_SES_FROM)",
      (_stack) =>
        Effect.gen(function* () {
          const email = encodeURIComponent(SUPPRESSED_ADDRESS);

          // put
          const put = (yield* send(
            HttpClientRequest.post(`${baseUrl}/suppress?email=${email}`),
          ).pipe(Effect.flatMap((r) => r.json))) as { error?: string };
          expect(put.error).toBeUndefined();

          // get — the suppression list is eventually consistent; poll until
          // the entry materializes.
          const got = yield* send(
            HttpClientRequest.get(`${baseUrl}/suppressed?email=${email}`),
          ).pipe(
            Effect.flatMap((r) => r.json),
            Effect.map(
              (body) =>
                body as { email?: string; reason?: string; error?: string },
            ),
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (body): boolean => body.reason === "BOUNCE",
              times: 10,
            }),
          );
          expect(got.email).toBe(SUPPRESSED_ADDRESS);
          expect(got.reason).toBe("BOUNCE");

          // list — filtered by reason, contains the address.
          const list = yield* send(
            HttpClientRequest.get(`${baseUrl}/suppressed-list`),
          ).pipe(
            Effect.flatMap((r) => r.json),
            Effect.map((body) => body as { emails?: string[]; error?: string }),
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (body): boolean =>
                (body.emails ?? []).includes(SUPPRESSED_ADDRESS),
              times: 10,
            }),
          );
          expect(list.emails).toContain(SUPPRESSED_ADDRESS);

          // delete — then the get surfaces the typed NotFoundException.
          const del = (yield* send(
            HttpClientRequest.post(`${baseUrl}/unsuppress?email=${email}`),
          ).pipe(Effect.flatMap((r) => r.json))) as { error?: string };
          expect(del.error).toBeUndefined();

          const gone = yield* send(
            HttpClientRequest.get(`${baseUrl}/suppressed?email=${email}`),
          ).pipe(
            Effect.flatMap((r) => r.json),
            Effect.map((body) => body as { error?: string }),
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (body): boolean => body.error === "NotFoundException",
              times: 10,
            }),
          );
          expect(gone.error).toBe("NotFoundException");
        }),
      { timeout: 120_000 },
    );
  });
});
