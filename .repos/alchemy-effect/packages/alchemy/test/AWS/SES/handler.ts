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

export class SESTestFunction extends Lambda.Function<Lambda.Function>()(
  "SESTestFunction",
) {}

export default SESTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
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

    const sendEmail = yield* SES.SendEmail(identity, configSet);
    const sendWithoutConfigSet = yield* SES.SendEmail(identity);
    const sendBulkEmail = yield* SES.SendBulkEmail(identity, configSet);
    const renderTemplate = yield* SES.RenderEmailTemplate(template);
    const getAccount = yield* SES.GetAccount();
    const suppress = yield* SES.PutSuppressedDestination();
    const getSuppressed = yield* SES.GetSuppressedDestination();
    const listSuppressed = yield* SES.ListSuppressedDestinations();
    const unsuppress = yield* SES.DeleteSuppressedDestination();
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
      ),
    ),
  ),
);
