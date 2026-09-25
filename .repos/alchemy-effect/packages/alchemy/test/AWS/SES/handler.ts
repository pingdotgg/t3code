import * as Lambda from "@/AWS/Lambda";
import * as SES from "@/AWS/SES";
import * as Output from "@/Output";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// The SES mailbox simulator accepts mail even in the sandbox.
const SIMULATOR = "success@simulator.amazonses.com";

// The address the gated test starts verification FOR. SES authorizes
// ses:SendCustomVerificationEmail against the identity of the address in the
// request — the recipient — so the gated real-send test needs a binding scoped
// to that address, not to the template's sender.
//
// Referenced, never managed: no EmailIdentity resource is declared for it, so
// nothing adopts or destroys account state. Read at module load, which happens
// both locally at deploy and inside the Lambda, so it is forwarded as env.
const CVE_RECIPIENT = process.env.AWS_TEST_SES_CVE_RECIPIENT;

export class SESTestFunction extends Lambda.Function<Lambda.Function>()(
  "SESTestFunction",
) {}

export default SESTestFunction.make(
  {
    main,
    functionUrl: true,
    timeout: Duration.seconds(30),
    // The gate is read at module load, which happens BOTH locally at deploy
    // (where the binding is declared) and inside the Lambda (where the client
    // is constructed). Forward it so the deployed function sees the same
    // value the deploy did.
    ...(CVE_RECIPIENT
      ? { env: { AWS_TEST_SES_CVE_RECIPIENT: CVE_RECIPIENT } }
      : {}),
  },
  Effect.gen(function* () {
    // Domain identity — deterministic, never verified. In the SES sandbox a
    // send from it fails with a typed MessageRejected; the ungated test
    // asserts exactly that tag. A verified from-address can be supplied per
    // request (?from=...) to exercise the success path.
    const identity = yield* SES.EmailIdentity("SendIdentity", {
      emailIdentity: "ses-bindings.alchemy-test.example.com",
    });
    const configSet = yield* SES.ConfigurationSet("SendConfigSet", {});
    const template = yield* SES.EmailTemplate("SendTemplate", {
      subject: "Hello, {{name}}!",
      text: "Hi {{name}}.",
    });

    // Publish send/bounce/complaint events for this configuration set to the
    // default EventBridge bus so `consumeEmailEvents` below has a producer.
    yield* SES.ConfigurationSetEventDestination("ToEventBridge", {
      configurationSetName: configSet.configurationSetName,
      matchingEventTypes: ["SEND", "DELIVERY", "BOUNCE", "COMPLAINT"],
      eventBridgeDestination: {
        eventBusArn: Output.all(configSet.configurationSetArn).pipe(
          Output.map(([arn]) =>
            arn
              .replace(":ses:", ":events:")
              .replace(/:configuration-set\/.*$/, ":event-bus/default"),
          ),
        ),
      },
    });

    // Event source: subscribe the host to SES email events. The deploy
    // proves the EventBridge rule + invoke permission wiring; events only
    // flow for real sends (gated behind AWS_TEST_SES_FROM in the tests).
    yield* SES.consumeEmailEvents(
      { kinds: ["send", "delivery", "bounce", "complaint"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `ses email event: ${event["detail-type"]} (${event.detail.mail?.messageId})`,
          ),
        ),
    );

    // No custom verification email template is declared here: SES rejects
    // CreateCustomVerificationEmailTemplate unless its FromEmailAddress is
    // already a verified identity, which a bare account has none of, and a
    // failed create here would take down every binding test in the file. The
    // template name is a request parameter instead — see /send-custom-verification.

    const sendEmail = yield* SES.SendEmail(identity, configSet);
    const sendWithoutConfigSet = yield* SES.SendEmail(identity);
    const sendBulkEmail = yield* SES.SendBulkEmail(identity, configSet);
    const renderTemplate = yield* SES.RenderEmailTemplate(template);
    const getAccount = yield* SES.GetAccount();
    const suppress = yield* SES.PutSuppressedDestination();
    const getSuppressed = yield* SES.GetSuppressedDestination();
    const listSuppressed = yield* SES.ListSuppressedDestinations();
    const unsuppress = yield* SES.DeleteSuppressedDestination();
    const sendBounce = yield* SES.SendBounce();
    const sendCustomVerification = yield* SES.SendCustomVerificationEmail(
      identity,
      configSet,
    );
    // Scoped by REFERENCE to the address the gated test verifies. The binding
    // above is scoped to the fixture's own (unverifiable) domain, so it can
    // only ever authorize verification of addresses AT that domain — which is
    // why the ungated test gets a request-level rejection there and this
    // separate binding is needed for a real send. No ownership: the recipient
    // is never declared as a resource.
    const sendCustomVerificationVerified = CVE_RECIPIENT
      ? yield* SES.SendCustomVerificationEmail({
          emailIdentity: CVE_RECIPIENT,
        })
      : undefined;
    const getMessageInsights = yield* SES.GetMessageInsights();
    const batchGetMetricData = yield* SES.BatchGetMetricData();
    const getDomainStatisticsReport = yield* SES.GetDomainStatisticsReport();
    const getBlacklistReports = yield* SES.GetBlacklistReports();
    const TemplateName = yield* template.templateName;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const from = url.searchParams.get("from") ?? undefined;
        const to = url.searchParams.get("to") ?? SIMULATOR;
        const email = url.searchParams.get("email") ?? undefined;

        const respond = <A extends object, E extends { _tag: string }>(
          effect: Effect.Effect<A, E>,
          pick: (result: A) => object,
        ) =>
          effect.pipe(
            Effect.flatMap((result) => HttpServerResponse.json(pick(result))),
            Effect.catch((e) =>
              HttpServerResponse.json({
                error: e._tag,
                message:
                  "message" in e
                    ? (e as { message?: string }).message
                    : undefined,
              }),
            ),
          );

        if (request.method === "POST" && pathname === "/send-simple") {
          return yield* respond(
            sendEmail({
              FromEmailAddress: from,
              Destination: { ToAddresses: [to] },
              Content: {
                Simple: {
                  Subject: { Data: "alchemy SES binding test" },
                  Body: { Text: { Data: "Hello from the SendEmail binding." } },
                },
              },
            }),
            (result) => ({ messageId: result.MessageId }),
          );
        }

        if (request.method === "POST" && pathname === "/send-template") {
          const templateName = yield* TemplateName;
          return yield* respond(
            sendEmail({
              FromEmailAddress: from,
              Destination: { ToAddresses: [to] },
              Content: {
                Template: {
                  TemplateName: templateName,
                  TemplateData: JSON.stringify({ name: "Ada" }),
                },
              },
            }),
            (result) => ({ messageId: result.MessageId }),
          );
        }

        if (request.method === "POST" && pathname === "/send-plain") {
          return yield* respond(
            sendWithoutConfigSet({
              FromEmailAddress: from,
              Destination: { ToAddresses: [to] },
              Content: {
                Simple: {
                  Subject: { Data: "alchemy SES binding test (no config set)" },
                  Body: { Text: { Data: "Hello without a config set." } },
                },
              },
            }),
            (result) => ({ messageId: result.MessageId }),
          );
        }

        if (request.method === "POST" && pathname === "/send-bulk") {
          const templateName = yield* TemplateName;
          return yield* respond(
            sendBulkEmail({
              FromEmailAddress: from,
              DefaultContent: {
                Template: {
                  TemplateName: templateName,
                  TemplateData: JSON.stringify({ name: "friend" }),
                },
              },
              BulkEmailEntries: [
                {
                  Destination: { ToAddresses: [to] },
                  ReplacementEmailContent: {
                    ReplacementTemplate: {
                      ReplacementTemplateData: JSON.stringify({ name: "Ada" }),
                    },
                  },
                },
              ],
            }),
            (result) => ({
              results: (result.BulkEmailEntryResults ?? []).map((entry) => ({
                status: entry.Status,
                messageId: entry.MessageId,
                error: entry.Error,
              })),
            }),
          );
        }

        if (request.method === "POST" && pathname === "/render-template") {
          return yield* respond(
            renderTemplate({
              TemplateData: JSON.stringify({ name: "Ada" }),
            }),
            (result) => ({ rendered: result.RenderedTemplate }),
          );
        }

        if (request.method === "GET" && pathname === "/account") {
          return yield* respond(getAccount(), (account) => ({
            sendingEnabled: account.SendingEnabled,
            productionAccess: account.ProductionAccessEnabled,
            max24HourSend: account.SendQuota?.Max24HourSend,
          }));
        }

        if (request.method === "POST" && pathname === "/suppress") {
          return yield* respond(
            suppress({ EmailAddress: email!, Reason: "BOUNCE" }),
            () => ({ suppressed: email }),
          );
        }

        if (request.method === "GET" && pathname === "/suppressed") {
          return yield* respond(
            getSuppressed({ EmailAddress: email! }),
            (result) => ({
              email: result.SuppressedDestination.EmailAddress,
              reason: result.SuppressedDestination.Reason,
            }),
          );
        }

        if (request.method === "GET" && pathname === "/suppressed-list") {
          return yield* respond(
            listSuppressed({ Reasons: ["BOUNCE"], PageSize: 100 }),
            (result) => ({
              emails: (result.SuppressedDestinationSummaries ?? []).map(
                (summary) => summary.EmailAddress,
              ),
            }),
          );
        }

        if (request.method === "POST" && pathname === "/unsuppress") {
          return yield* respond(unsuppress({ EmailAddress: email! }), () => ({
            unsuppressed: email,
          }));
        }

        if (request.method === "POST" && pathname === "/send-bounce") {
          // A fabricated message id when none is supplied — SES only accepts a
          // bounce for a message it actually received within 24h, so the
          // ungated test drives this path and asserts a typed rejection. Set
          // ?messageId= to a real received message id to exercise the success
          // path (gated behind AWS_TEST_SES_BOUNCE_MESSAGE_ID in the test).
          const messageId =
            url.searchParams.get("messageId") ??
            "00000000000000000000000000000000000000000000000000-0000";
          return yield* respond(
            sendBounce({
              OriginalMessageId: messageId,
              BounceSender:
                from ?? "mailer-daemon@ses-bindings.alchemy-test.example.com",
              BouncedRecipientInfoList: [
                { Recipient: to, BounceType: "DoesNotExist" },
              ],
            }),
            (result) => ({ messageId: result.MessageId }),
          );
        }

        if (
          request.method === "POST" &&
          pathname === "/send-custom-verification"
        ) {
          // The template name comes from the request: on a bare account no
          // verified sender exists to create one with, so the ungated test
          // passes a name that does not resolve and asserts the typed
          // rejection. AWS_TEST_SES_CVE_TEMPLATE names a real one.
          const templateName =
            url.searchParams.get("template") ?? "alchemy-test-missing-template";
          return yield* respond(
            sendCustomVerification({
              EmailAddress: email ?? "verify-target@simulator.amazonses.com",
              TemplateName: templateName,
            }),
            (result) => ({ messageId: result.MessageId }),
          );
        }

        if (
          request.method === "POST" &&
          pathname === "/send-custom-verification-verified"
        ) {
          if (sendCustomVerificationVerified === undefined) {
            return yield* HttpServerResponse.json(
              { error: "AWS_TEST_SES_CVE_RECIPIENT not set at deploy time" },
              { status: 412 },
            );
          }
          const templateName =
            url.searchParams.get("template") ?? "alchemy-test-missing-template";
          return yield* respond(
            sendCustomVerificationVerified({
              EmailAddress: email ?? SIMULATOR,
              TemplateName: templateName,
            }),
            (result) => ({ messageId: result.MessageId }),
          );
        }

        if (request.method === "GET" && pathname === "/message-insights") {
          // No real send backs a fabricated message id, so SES rejects it
          // with a typed error (NotFoundException, or BadRequestException when
          // VDM is disabled). Set ?messageId= to a real send's id to exercise
          // the success path.
          const messageId =
            url.searchParams.get("messageId") ??
            "0000000000000000-00000000-0000-0000-0000-000000000000-000000";
          return yield* respond(
            getMessageInsights({ MessageId: messageId }),
            (result) => ({
              messageId: result.MessageId,
              insights: result.Insights?.length ?? 0,
            }),
          );
        }

        if (request.method === "POST" && pathname === "/metric-data") {
          // SES rejects partial-day windows: "To get daily aggregated data
          // you must not specify partial-day timestamps. Please make your
          // interval go from midnight to midnight UTC."
          //
          // ?partialDay=1 deliberately sends such a window so a test can pin
          // the typed rejection independently of whether VDM is enabled.
          const partialDay = url.searchParams.get("partialDay") !== null;
          const end = new Date();
          if (!partialDay) end.setUTCHours(0, 0, 0, 0);
          const start = new Date(end.getTime() - 7 * 24 * 3600 * 1000);
          return yield* respond(
            batchGetMetricData({
              Queries: [
                {
                  Id: "sends",
                  Namespace: "VDM",
                  Metric: "SEND",
                  StartDate: start,
                  EndDate: end,
                },
              ],
            }),
            (result) => ({ results: (result.Results ?? []).length }),
          );
        }

        if (request.method === "GET" && pathname === "/domain-statistics") {
          const domain =
            url.searchParams.get("domain") ??
            "ses-bindings.alchemy-test.example.com";
          const end = new Date();
          const start = new Date(end.getTime() - 7 * 24 * 3600 * 1000);
          return yield* respond(
            getDomainStatisticsReport({
              Domain: domain,
              StartDate: start,
              EndDate: end,
            }),
            (result) => ({ days: result.DailyVolumes.length }),
          );
        }

        if (request.method === "GET" && pathname === "/blacklist-reports") {
          const ip = url.searchParams.get("ip") ?? "192.0.2.1";
          return yield* respond(
            getBlacklistReports({ BlacklistItemNames: [ip] }),
            (result) => ({ ips: Object.keys(result.BlacklistReport) }),
          );
        }

        if (request.method === "GET" && pathname === "/health") {
          return HttpServerResponse.text("ok");
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.EventSource,
        SES.SendEmailHttp,
        SES.SendBulkEmailHttp,
        SES.RenderEmailTemplateHttp,
        SES.GetAccountHttp,
        SES.PutSuppressedDestinationHttp,
        SES.GetSuppressedDestinationHttp,
        SES.ListSuppressedDestinationsHttp,
        SES.DeleteSuppressedDestinationHttp,
        SES.SendBounceHttp,
        SES.SendCustomVerificationEmailHttp,
        SES.GetMessageInsightsHttp,
        SES.BatchGetMetricDataHttp,
        SES.GetDomainStatisticsReportHttp,
        SES.GetBlacklistReportsHttp,
      ),
    ),
  ),
);
