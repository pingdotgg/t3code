import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as lambda from "@distilled.cloud/aws/lambda";
import * as socialmessaging from "@distilled.cloud/aws/socialmessaging";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import SocialMessagingBindingsFunctionLive, {
  SocialMessagingBindingsFunction,
} from "./bindings-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);

// Every SocialMessaging binding operates on a WhatsApp Business Account
// that can only be linked through the Meta embedded-signup flow in the AWS
// console, so the live Lambda E2E is gated behind AWS_TEST_SOCIALMESSAGING=1
// + AWS_TEST_SOCIALMESSAGING_WABA_ID. The ungated probes below prove the
// distilled error unions the bindings surface are typed on every account.
const RUN_LIVE =
  !!process.env.AWS_TEST_SOCIALMESSAGING &&
  !!process.env.AWS_TEST_SOCIALMESSAGING_WABA_ID;

// Well-formed but nonexistent identifiers.
const BOGUS_WABA_ID = "waba-0123456789abcdef0123456789abcdef";
const BOGUS_PHONE_ID = "phone-number-id-0123456789abcdef0123456789abcdef";

test.provider(
  "listWhatsAppMessageTemplates on a nonexistent WABA fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        socialmessaging.listWhatsAppMessageTemplates({ id: BOGUS_WABA_ID }),
      );
      expect([
        "ResourceNotFoundException",
        "InvalidParametersException",
        "AccessDeniedByMetaException",
        "DependencyException",
      ]).toContain(error._tag);
    }),
);

test.provider(
  "listWhatsAppFlows on a nonexistent WABA fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        socialmessaging.listWhatsAppFlows({ id: BOGUS_WABA_ID }),
      );
      expect([
        "ResourceNotFoundException",
        "InvalidParametersException",
        "AccessDeniedByMetaException",
        "DependencyException",
      ]).toContain(error._tag);
    }),
);

test.provider(
  "getLinkedWhatsAppBusinessAccountPhoneNumber on a nonexistent phone number fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        socialmessaging.getLinkedWhatsAppBusinessAccountPhoneNumber({
          id: BOGUS_PHONE_ID,
        }),
      );
      expect([
        "ResourceNotFoundException",
        "InvalidParametersException",
      ]).toContain(error._tag);
    }),
);

test.provider(
  "sendWhatsAppMessage from a nonexistent phone number fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        socialmessaging.sendWhatsAppMessage({
          originationPhoneNumberId: BOGUS_PHONE_ID,
          metaApiVersion: "v20.0",
          message: new TextEncoder().encode(
            JSON.stringify({
              messaging_product: "whatsapp",
              to: "+10000000000",
              type: "text",
              text: { body: "alchemy-socialmessaging-probe" },
            }),
          ),
        }),
      );
      expect([
        "ResourceNotFoundException",
        "InvalidParametersException",
        "AccessDeniedByMetaException",
        "DependencyException",
      ]).toContain(error._tag);
    }),
);

test.provider(
  "getWhatsAppMessageMedia on a nonexistent phone number fails with a typed tag",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        socialmessaging.getWhatsAppMessageMedia({
          mediaId: "alchemy-nonexistent-media-id",
          originationPhoneNumberId: BOGUS_PHONE_ID,
          metadataOnly: true,
        }),
      );
      expect([
        "ResourceNotFoundException",
        "InvalidParametersException",
        "AccessDeniedByMetaException",
        "DependencyException",
        // media ids are validated before the phone-number lookup
        "ValidationException",
      ]).toContain(error._tag);
    }),
);

const sharedStack = Core.scratchStack(testOptions, "SocialMessagingBindings");

let baseUrl: string;
let functionArn: string | undefined;

class FunctionStillExists extends Data.TaggedError("FunctionStillExists") {}

const get = (path: string) =>
  HttpClient.get(`${baseUrl}${path}`).pipe(Effect.flatMap((r) => r.json));
const post = (path: string) =>
  HttpClient.post(`${baseUrl}${path}`).pipe(Effect.flatMap((r) => r.json));

// Live Lambda E2E — requires a WhatsApp Business Account already linked via
// the AWS End User Messaging Social console (Meta embedded signup). NOTE:
// the final stack.destroy() disassociates the WABA from the AWS account;
// re-running afterwards requires redoing the console signup.
describe("SocialMessaging Bindings (E2E)", () => {
  beforeAll(
    Effect.gen(function* () {
      if (!RUN_LIVE) return;
      yield* Effect.logInfo("SocialMessaging E2E setup: destroying previous");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("SocialMessaging E2E setup: deploying Lambda");
      const deployed = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* SocialMessagingBindingsFunction;
        }).pipe(Effect.provide(SocialMessagingBindingsFunctionLive)),
      );
      functionArn = deployed.functionArn;

      expect(deployed.functionUrl).toBeTruthy();
      baseUrl = deployed.functionUrl!.replace(/\/+$/, "");

      // Readiness probe — fresh function URLs take seconds to serve 200s.
      yield* HttpClient.get(`${baseUrl}/bindings`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.fixed("2 seconds"),
            Schedule.recurs(60),
          ]),
        }),
      );
    }),
    { timeout: 300_000 },
  );
  afterAll(
    Effect.gen(function* () {
      if (!RUN_LIVE) return;
      yield* sharedStack.destroy();
      // Assert gone (skipped when beforeAll never got far enough to deploy):
      // the fixture Lambda answers with the typed not-found tag out-of-band.
      // afterAll runs outside `test.provider`'s layer, so raw distilled calls
      // need the provider layer (credentials, region) supplied explicitly.
      if (functionArn) {
        yield* Core.withProviders(
          lambda.getFunction({ FunctionName: functionArn }).pipe(
            Effect.flatMap(() => Effect.fail(new FunctionStillExists())),
            Effect.retry({
              while: (error) => error._tag === "FunctionStillExists",
              schedule: Schedule.exponential("500 millis"),
              times: 8,
            }),
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          ),
          testOptions,
          sharedStack.name,
        );
      }
    }),
    { timeout: 300_000 },
  );

  test.provider.skipIf(!RUN_LIVE)(
    "all 23 capabilities initialize in the runtime",
    () =>
      Effect.gen(function* () {
        const response = (yield* get("/bindings")) as any;
        expect(response.bound).toHaveLength(23);
      }),
  );

  test.provider.skipIf(!RUN_LIVE)(
    "template + flow list bindings round-trip against the linked WABA",
    () =>
      Effect.gen(function* () {
        const templates = (yield* get("/templates")) as any;
        expect(typeof templates.count).toBe("number");
        const flows = (yield* get("/flows")) as any;
        expect(typeof flows.count).toBe("number");
        const library = (yield* get("/library")) as any;
        expect(typeof library.count).toBe("number");
      }),
  );

  test.provider.skipIf(!RUN_LIVE)(
    "read bindings surface typed errors on bogus identifiers",
    () =>
      Effect.gen(function* () {
        const phone = (yield* get("/phone/typed-not-found")) as any;
        expect(phone.typed).toBe(true);
        const template = (yield* get("/template/typed-not-found")) as any;
        expect(template.typed).toBe(true);
        const flow = (yield* get("/flow/typed-not-found")) as any;
        expect(flow.typed).toBe(true);
      }),
  );

  test.provider.skipIf(!RUN_LIVE)(
    "message + media mutation bindings surface typed errors without side effects",
    () =>
      Effect.gen(function* () {
        const media = (yield* post("/media/typed-not-found")) as any;
        expect(media.get).toBe(true);
        expect(media.del).toBe(true);
        const send = (yield* post("/send/typed-invalid")) as any;
        expect(send.typed).toBe(true);
      }),
  );
});
