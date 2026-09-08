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

// A verified from-address on the account. It does NOT unlock a successful
// `SendEmail` — that binding is scoped to the identity the fixture binds — but
// the suppression-list write plane needs production access, and an account
// that has a verified sender is invariably out of the sandbox.
const VERIFIED_FROM = process.env.AWS_TEST_SES_FROM;

// Names an existing custom verification email template. Creating one requires
// a verified sender, so the fixture cannot declare it — pass a template you
// created out of band to exercise the real send.
const CVE_TEMPLATE = process.env.AWS_TEST_SES_CVE_TEMPLATE;

// Recipient for the real custom-verification send. Defaults to the mailbox
// simulator; override only with an address you own.
const CVE_RECIPIENT = process.env.AWS_TEST_SES_CVE_RECIPIENT;

// Never skips a test — tightens it. With Virtual Deliverability Manager
// enabled the insight bindings must return real data rather than the typed
// rejection a VDM-less account gives.
const VDM_ENABLED = !!process.env.AWS_TEST_SES_VDM;

// The SES mailbox simulator accepts mail without affecting reputation.
const SIMULATOR = "success@simulator.amazonses.com";

// A syntactically valid address at the fixture's (unverified) domain
// identity — SES rejects it with the typed MessageRejected tag in sandbox.
const UNVERIFIED_FROM = "noreply@ses-bindings.alchemy-test.example.com";

// Deterministic address the suppression-list tests add and remove. The test
// ends by deleting it, so repeated runs leave no residue.
const SUPPRESSED_ADDRESS = "suppressed@ses-bindings.alchemy-test.example.com";

// The tags SES raises about a REQUEST — a bad argument, a missing object, or
// an unentitled account. A binding that failed to attach its IAM action would
// answer AccessDeniedException instead, so asserting membership here (rather
// than `typeof error === "string"`) is what makes these tests able to fail.
const REQUEST_TAGS = ["BadRequestException", "NotFoundException"];

// SendCustomVerificationEmail additionally rejects an unverified sender and a
// sandboxed account through its own tags.
const CVE_REQUEST_TAGS = [
  ...REQUEST_TAGS,
  "MessageRejected",
  "MailFromDomainNotVerifiedException",
  "SendingPausedException",
  "LimitExceededException",
];

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
          // SendingPausedException: the testing account's SES sending is
          // paused. Still a typed SES error through the binding (not IAM
          // AccessDenied / an unknown tag) — the binding is wired. The
          // sandbox MessageRejected path is what we get when sending is on.
          expect(["MessageRejected", "SendingPausedException"]).toContain(
            response.error,
          );
          if (response.error === "MessageRejected") {
            expect(response.message).toContain("not verified");
          }
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
          expect(["MessageRejected", "SendingPausedException"]).toContain(
            response.error,
          );
        }),
    );

    test.provider(
      "a binding declared without a configuration set is granted the same send",
      (_stack) =>
        Effect.gen(function* () {
          // The fixture binds SendEmail twice: once with a configuration set
          // and once without (`SES.SendEmail(identity)`). The no-config-set
          // grant is a separate IAM policy, so it needs its own proof that it
          // reaches SES — otherwise a regression in the one-argument overload
          // would go unnoticed.
          const response = (yield* send(
            HttpClientRequest.post(
              `${baseUrl}/send-plain?from=${encodeURIComponent(UNVERIFIED_FROM)}`,
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            messageId?: string;
            error?: string;
            message?: string;
          };

          // Same sandbox rejection as the config-set path — crucially NOT
          // AccessDenied, which is what a missing/misscoped policy looks like.
          expect(response.error).not.toBe("AccessDeniedException");
          expect(["MessageRejected", "SendingPausedException"]).toContain(
            response.error,
          );
          if (response.error === "MessageRejected") {
            expect(response.message).toContain("not verified");
          }
        }),
    );

    // `SendEmail` is identity-scoped: the binding grants ses:SendEmail only on
    // the ARN of the identity it was bound to (plus that domain's addresses,
    // its templates, and the configuration set). A sender outside that
    // identity is refused by IAM before SES ever evaluates the message —
    // including one that is verified on the account. Verified in a live
    // production account with a verified sender, where the send returns
    // AccessDeniedException rather than a MessageId.
    //
    // Exercising a genuine successful send therefore needs an identity the
    // FIXTURE binds and that is really verified, i.e. a domain under our
    // control with DKIM published — the setup Receiving.smoke.test.ts builds
    // on the standing Cloudflare test zone. AWS_TEST_SES_FROM alone cannot
    // grant it.
    test.provider(
      "a sender outside the bound identity is denied by the scoped IAM policy",
      (_stack) =>
        Effect.gen(function* () {
          const outsider = encodeURIComponent(
            "sender@not-the-bound-domain.test",
          );
          const response = (yield* send(
            HttpClientRequest.post(`${baseUrl}/send-simple?from=${outsider}`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            messageId?: string;
            error?: string;
          };

          // SendingPaused is evaluated before IAM on a paused account —
          // still typed, still not a successful send.
          expect(["AccessDeniedException", "SendingPausedException"]).toContain(
            response.error,
          );
          expect(response.messageId).toBeUndefined();
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
            // Production account: the write succeeded — assert that rather
            // than letting an empty branch pass, then clean up and let the
            // gated lifecycle test below cover the full flow.
            expect(put.error).toBeUndefined();
            const cleanup = (yield* send(
              HttpClientRequest.post(`${baseUrl}/unsuppress?email=${email}`),
            ).pipe(Effect.flatMap((r) => r.json))) as { error?: string };
            expect(cleanup.error).toBeUndefined();
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

  describe("SendBounce", () => {
    // A real bounce requires a message SES actually received within the last
    // 24h; set this to that message id to exercise the success path.
    const BOUNCE_MESSAGE_ID = process.env.AWS_TEST_SES_BOUNCE_MESSAGE_ID;

    test.provider(
      "bouncing a non-existent message surfaces a typed SES error through the binding",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.post(`${baseUrl}/send-bounce`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            messageId?: string;
            error?: string;
          };

          // No real received message backs the fabricated OriginalMessageId
          // (and the bounce sender is unverified in the sandbox), so SES
          // rejects the bounce with the typed MessageRejected tag — verified
          // live: "Failed to generate a bounce for <id>. The following
          // identities are not verified: ...". That proves the binding wires
          // ses:SendBounce IAM + request marshalling into the deployed Lambda.
          expect(response.error).toBe("MessageRejected");
          expect(response.messageId).toBeUndefined();
        }),
    );

    test.provider.skipIf(!BOUNCE_MESSAGE_ID)(
      "bounces a real received message (AWS_TEST_SES_BOUNCE_MESSAGE_ID)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.post(
              `${baseUrl}/send-bounce?messageId=${encodeURIComponent(BOUNCE_MESSAGE_ID!)}`,
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

  describe("SendCustomVerificationEmail", () => {
    // The unknown-template case never leaves SES, so its recipient is
    // irrelevant. The gated case sends for real, so it goes to the mailbox
    // simulator, which accepts mail without touching reputation — an address
    // at the fixture's example.com domain would hard-bounce.
    const sendCustomVerification = (template?: string) => {
      const email = encodeURIComponent(
        template
          ? (CVE_RECIPIENT ?? SIMULATOR)
          : "verify-target@ses-bindings.alchemy-test.example.com",
      );
      const query = template
        ? `?email=${email}&template=${encodeURIComponent(template)}`
        : `?email=${email}`;
      return send(
        HttpClientRequest.post(`${baseUrl}/send-custom-verification${query}`),
      ).pipe(Effect.flatMap((r) => r.json)) as Effect.Effect<
        { messageId?: string; error?: string; message?: string },
        any,
        any
      >;
    };

    test.provider(
      "an unknown template surfaces a typed SES error through the binding",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* sendCustomVerification();

          // The fixture declares no template — SES rejects
          // CreateCustomVerificationEmailTemplate unless its sender is already
          // verified, which a bare account has none of. So the request names a
          // template that does not resolve and SES answers with a typed error.
          //
          // The tag must be one SES raises about the REQUEST. AccessDenied
          // would mean the binding failed to attach
          // ses:SendCustomVerificationEmail — the regression this test exists
          // to catch — so it is asserted against explicitly.
          expect(response.error).not.toBe("AccessDeniedException");
          expect(CVE_REQUEST_TAGS).toContain(response.error);
          expect(response.messageId).toBeUndefined();
        }),
    );

    // The real send goes through a SECOND binding, scoped by reference to the
    // address being verified. It cannot reuse the binding above: SES
    // authorizes this action against the identity of the RECIPIENT, and that
    // binding only covers addresses at the fixture's own domain.
    //
    // The reference form takes no ownership, so nothing here adopts or
    // destroys the account's real identities.
    test.provider.skipIf(!CVE_TEMPLATE || !CVE_RECIPIENT)(
      "sends through a real template (AWS_TEST_SES_CVE_TEMPLATE + _RECIPIENT)",
      (_stack) =>
        Effect.gen(function* () {
          const email = encodeURIComponent(CVE_RECIPIENT!);
          const response = (yield* send(
            HttpClientRequest.post(
              `${baseUrl}/send-custom-verification-verified?email=${email}&template=${encodeURIComponent(CVE_TEMPLATE!)}`,
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
  });

  describe("GetMessageInsights", () => {
    const insights = (messageId?: string) =>
      send(
        HttpClientRequest.get(
          `${baseUrl}/message-insights${
            messageId ? `?messageId=${encodeURIComponent(messageId)}` : ""
          }`,
        ),
      ).pipe(Effect.flatMap((r) => r.json)) as Effect.Effect<
        { messageId?: string; error?: string },
        any,
        any
      >;

    test.provider(
      "a well-formed but unknown message id is rejected with a typed tag",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* insights();

          // No real send backs the fabricated MessageId, so SES rejects it —
          // NotFoundException, or BadRequestException when VDM is disabled on
          // the account. AccessDenied would mean ses:GetMessageInsights never
          // reached the role.
          expect(response.error).not.toBe("AccessDeniedException");
          expect(REQUEST_TAGS).toContain(response.error);
          expect(response.messageId).toBeUndefined();
          if (VDM_ENABLED) expect(response.error).toBe("NotFoundException");
        }),
    );

    test.provider.skipIf(!VDM_ENABLED)(
      "a malformed message id is rejected with BadRequestException (AWS_TEST_SES_VDM)",
      (_stack) =>
        Effect.gen(function* () {
          // Only reachable with VDM enabled. Without it SES short-circuits
          // every GetMessageInsights call with NotFoundException ("To use this
          // feature you must enable Virtual Deliverability Manager") before it
          // ever looks at the id, so malformed and well-formed ids are
          // indistinguishable on a VDM-less account.
          const response = yield* insights("not-a-message-id");

          expect(response.error).not.toBe("AccessDeniedException");
          expect(response.error).toBe("BadRequestException");
          expect(response.messageId).toBeUndefined();
        }),
    );
  });

  describe("BatchGetMetricData", () => {
    const metricData = (partialDay = false) =>
      send(
        HttpClientRequest.post(
          `${baseUrl}/metric-data${partialDay ? "?partialDay=1" : ""}`,
        ),
      ).pipe(Effect.flatMap((r) => r.json)) as Effect.Effect<
        { results?: number; error?: string },
        any,
        any
      >;

    test.provider(
      "a midnight-aligned window reaches SES through the binding",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* metricData();

          // With VDM enabled SES returns a (possibly empty) Results array;
          // without it the account is rejected with BadRequestException. Both
          // prove the IAM action and payload marshalling are wired — but
          // neither may be an authorization failure.
          expect(response.error).not.toBe("AccessDeniedException");
          if (response.error === undefined) {
            expect(typeof response.results).toBe("number");
          } else {
            expect(REQUEST_TAGS).toContain(response.error);
          }
        }),
    );

    test.provider.skipIf(!VDM_ENABLED)(
      "returns a metric series on a VDM-enabled account (AWS_TEST_SES_VDM)",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* metricData();
          expect(response.error).toBeUndefined();
          expect(typeof response.results).toBe("number");
        }),
    );

    test.provider.skipIf(!VDM_ENABLED)(
      "a partial-day window is rejected with BadRequestException (AWS_TEST_SES_VDM)",
      (_stack) =>
        Effect.gen(function* () {
          // SES requires daily-aggregated queries to run midnight-to-midnight
          // UTC, which pins that the binding forwards the timestamps it is
          // given. Only reachable with VDM enabled: without it SES rejects
          // every BatchGetMetricData call with NotFoundException before
          // validating the window.
          const response = yield* metricData(true);

          expect(response.error).not.toBe("AccessDeniedException");
          expect(response.error).toBe("BadRequestException");
        }),
    );
  });

  describe("GetDomainStatisticsReport", () => {
    const domainStatistics = (domain?: string) =>
      send(
        HttpClientRequest.get(
          `${baseUrl}/domain-statistics${
            domain ? `?domain=${encodeURIComponent(domain)}` : ""
          }`,
        ),
      ).pipe(Effect.flatMap((r) => r.json)) as Effect.Effect<
        { days?: number; error?: string },
        any,
        any
      >;

    test.provider(
      "requesting a domain deliverability report reaches SES through the binding",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* domainStatistics();

          // The deliverability dashboard is a paid subscription; without it
          // SES rejects the request with a typed tag. Either way the call must
          // have been authorized.
          expect(response.error).not.toBe("AccessDeniedException");
          if (response.error === undefined) {
            expect(typeof response.days).toBe("number");
          } else {
            expect(REQUEST_TAGS).toContain(response.error);
          }
        }),
    );

    test.provider(
      "a domain the account does not own is rejected with a typed tag",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* domainStatistics(
            "not-our-domain.alchemy-test.example.com",
          );

          expect(response.error).not.toBe("AccessDeniedException");
          expect(REQUEST_TAGS).toContain(response.error);
          expect(response.days).toBeUndefined();
        }),
    );
  });

  describe("GetBlacklistReports", () => {
    const blacklistReports = (ip?: string) =>
      send(
        HttpClientRequest.get(
          `${baseUrl}/blacklist-reports${
            ip ? `?ip=${encodeURIComponent(ip)}` : ""
          }`,
        ),
      ).pipe(Effect.flatMap((r) => r.json)) as Effect.Effect<
        { ips?: string[]; error?: string },
        any,
        any
      >;

    // This binding has no request-rejection path to pin: SES needs no
    // subscription for it and validates nothing about the items it is given.
    // A garbage item (`not-an-ip-address`) returns 200 with an empty
    // BlacklistReport exactly like a well-formed IP the account does not own,
    // so a "malformed input" test here would assert the same thing as the
    // success test. One unconditional test is the honest coverage.
    test.provider(
      "returns a blacklist report for the requested IPs",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* blacklistReports();

          expect(response.error).toBeUndefined();
          expect(Array.isArray(response.ips)).toBe(true);
        }),
    );
  });
});
