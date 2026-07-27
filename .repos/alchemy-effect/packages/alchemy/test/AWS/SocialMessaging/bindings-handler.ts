import * as Lambda from "@/AWS/Lambda";
import * as SocialMessaging from "@/AWS/SocialMessaging";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "bindings-handler.ts");

// Resolved at deploy time (the test process exports it before deploying).
// At Lambda runtime the module re-evaluates with the fallback, which is
// fine — the bound resource's attributes resolve from deployed state, not
// from these props.
const WABA_ID = process.env.AWS_TEST_SOCIALMESSAGING_WABA_ID ?? "waba-unset";

// Well-formed but nonexistent identifiers for typed-error probe routes.
const BOGUS_PHONE_ID = "phone-number-id-0123456789abcdef0123456789abcdef";
const BOGUS_MEDIA_ID = "alchemy-nonexistent-media-id";

export class SocialMessagingBindingsFunction extends Lambda.Function<Lambda.Function>()(
  "SocialMessagingBindingsFunction",
) {}

export default SocialMessagingBindingsFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    // Adopts the console-linked WABA (see LinkedWhatsAppBusinessAccount
    // docs) — stack.destroy() disassociates it, requiring console re-signup.
    const account = yield* SocialMessaging.LinkedWhatsAppBusinessAccount(
      "BindingsWaba",
      { accountId: WABA_ID },
    );

    const sendMessage = yield* SocialMessaging.SendWhatsAppMessage(account);
    const postMedia = yield* SocialMessaging.PostWhatsAppMessageMedia(account);
    const getMedia = yield* SocialMessaging.GetWhatsAppMessageMedia(account);
    const deleteMedia =
      yield* SocialMessaging.DeleteWhatsAppMessageMedia(account);
    const getPhoneNumber =
      yield* SocialMessaging.GetLinkedWhatsAppBusinessAccountPhoneNumber(
        account,
      );
    const createTemplate =
      yield* SocialMessaging.CreateWhatsAppMessageTemplate(account);
    const createFromLibrary =
      yield* SocialMessaging.CreateWhatsAppMessageTemplateFromLibrary(account);
    const uploadTemplateMedia =
      yield* SocialMessaging.CreateWhatsAppMessageTemplateMedia(account);
    const getTemplate =
      yield* SocialMessaging.GetWhatsAppMessageTemplate(account);
    const listTemplates =
      yield* SocialMessaging.ListWhatsAppMessageTemplates(account);
    const browseLibrary =
      yield* SocialMessaging.ListWhatsAppTemplateLibrary(account);
    const updateTemplate =
      yield* SocialMessaging.UpdateWhatsAppMessageTemplate(account);
    const deleteTemplate =
      yield* SocialMessaging.DeleteWhatsAppMessageTemplate(account);
    const createFlow = yield* SocialMessaging.CreateWhatsAppFlow(account);
    const getFlow = yield* SocialMessaging.GetWhatsAppFlow(account);
    const getFlowPreview =
      yield* SocialMessaging.GetWhatsAppFlowPreview(account);
    const listFlows = yield* SocialMessaging.ListWhatsAppFlows(account);
    const listFlowAssets =
      yield* SocialMessaging.ListWhatsAppFlowAssets(account);
    const updateFlow = yield* SocialMessaging.UpdateWhatsAppFlow(account);
    const updateFlowAssets =
      yield* SocialMessaging.UpdateWhatsAppFlowAssets(account);
    const publishFlow = yield* SocialMessaging.PublishWhatsAppFlow(account);
    const deprecateFlow = yield* SocialMessaging.DeprecateWhatsAppFlow(account);
    const deleteFlow = yield* SocialMessaging.DeleteWhatsAppFlow(account);

    const bound = {
      sendMessage,
      postMedia,
      getMedia,
      deleteMedia,
      getPhoneNumber,
      createTemplate,
      createFromLibrary,
      uploadTemplateMedia,
      getTemplate,
      listTemplates,
      browseLibrary,
      updateTemplate,
      deleteTemplate,
      createFlow,
      getFlow,
      getFlowPreview,
      listFlows,
      listFlowAssets,
      updateFlow,
      updateFlowAssets,
      publishFlow,
      deprecateFlow,
      deleteFlow,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        // Read-only round-trips against the linked account — prove the
        // WABA-scoped grant + id injection end-to-end.
        if (request.method === "GET" && pathname === "/templates") {
          const response = yield* listTemplates({ maxResults: 25 });
          return yield* HttpServerResponse.json({
            count: (response.templates ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/flows") {
          const response = yield* listFlows({ maxResults: 25 });
          return yield* HttpServerResponse.json({
            count: (response.flows ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/library") {
          const response = yield* browseLibrary({ maxResults: 5 });
          return yield* HttpServerResponse.json({
            count: (response.metaLibraryTemplates ?? []).length,
          });
        }

        // Typed-error probes: a bogus identifier round-trips the typed tag,
        // proving the grant reached the API (an IAM gap would surface
        // AccessDeniedException instead).
        if (request.method === "GET" && pathname === "/phone/typed-not-found") {
          const typed = yield* getPhoneNumber({ id: BOGUS_PHONE_ID }).pipe(
            Effect.map(() => false),
            Effect.catchTag(
              ["ResourceNotFoundException", "InvalidParametersException"],
              () => Effect.succeed(true),
            ),
          );
          return yield* HttpServerResponse.json({ typed });
        }

        if (
          request.method === "GET" &&
          pathname === "/template/typed-not-found"
        ) {
          const typed = yield* getTemplate({ metaTemplateId: "0" }).pipe(
            Effect.map(() => false),
            Effect.catchTag(
              [
                "ResourceNotFoundException",
                "InvalidParametersException",
                "AccessDeniedByMetaException",
                "DependencyException",
                "ValidationException",
              ],
              () => Effect.succeed(true),
            ),
          );
          return yield* HttpServerResponse.json({ typed });
        }

        if (request.method === "GET" && pathname === "/flow/typed-not-found") {
          const typed = yield* getFlow({ flowId: "0" }).pipe(
            Effect.map(() => false),
            Effect.catchTag(
              [
                "ResourceNotFoundException",
                "InvalidParametersException",
                "AccessDeniedByMetaException",
                "DependencyException",
                "ValidationException",
              ],
              () => Effect.succeed(true),
            ),
          );
          return yield* HttpServerResponse.json({ typed });
        }

        if (
          request.method === "POST" &&
          pathname === "/media/typed-not-found"
        ) {
          const get = yield* getMedia({
            mediaId: BOGUS_MEDIA_ID,
            originationPhoneNumberId: BOGUS_PHONE_ID,
            metadataOnly: true,
          }).pipe(
            Effect.map(() => false),
            Effect.catchTag(
              [
                "ResourceNotFoundException",
                "InvalidParametersException",
                "AccessDeniedByMetaException",
                "DependencyException",
                "ValidationException",
              ],
              () => Effect.succeed(true),
            ),
          );
          const del = yield* deleteMedia({
            mediaId: BOGUS_MEDIA_ID,
            originationPhoneNumberId: BOGUS_PHONE_ID,
          }).pipe(
            Effect.map(() => false),
            Effect.catchTag(
              [
                "ResourceNotFoundException",
                "InvalidParametersException",
                "AccessDeniedByMetaException",
                "DependencyException",
                "ValidationException",
              ],
              () => Effect.succeed(true),
            ),
          );
          return yield* HttpServerResponse.json({ get, del });
        }

        if (request.method === "POST" && pathname === "/send/typed-invalid") {
          // A bogus phone-number id is rejected with a typed error before
          // any message is sent — proves the SendWhatsAppMessage grant
          // without messaging a real user.
          const typed = yield* sendMessage({
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
          }).pipe(
            Effect.map(() => false),
            Effect.catchTag(
              [
                "ResourceNotFoundException",
                "InvalidParametersException",
                "AccessDeniedByMetaException",
                "DependencyException",
                "ValidationException",
              ],
              () => Effect.succeed(true),
            ),
          );
          return yield* HttpServerResponse.json({ typed });
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
        SocialMessaging.SendWhatsAppMessageHttp,
        SocialMessaging.PostWhatsAppMessageMediaHttp,
        SocialMessaging.GetWhatsAppMessageMediaHttp,
        SocialMessaging.DeleteWhatsAppMessageMediaHttp,
        SocialMessaging.GetLinkedWhatsAppBusinessAccountPhoneNumberHttp,
        SocialMessaging.CreateWhatsAppMessageTemplateHttp,
        SocialMessaging.CreateWhatsAppMessageTemplateFromLibraryHttp,
        SocialMessaging.CreateWhatsAppMessageTemplateMediaHttp,
        SocialMessaging.GetWhatsAppMessageTemplateHttp,
        SocialMessaging.ListWhatsAppMessageTemplatesHttp,
        SocialMessaging.ListWhatsAppTemplateLibraryHttp,
        SocialMessaging.UpdateWhatsAppMessageTemplateHttp,
        SocialMessaging.DeleteWhatsAppMessageTemplateHttp,
        SocialMessaging.CreateWhatsAppFlowHttp,
        SocialMessaging.GetWhatsAppFlowHttp,
        SocialMessaging.GetWhatsAppFlowPreviewHttp,
        SocialMessaging.ListWhatsAppFlowsHttp,
        SocialMessaging.ListWhatsAppFlowAssetsHttp,
        SocialMessaging.UpdateWhatsAppFlowHttp,
        SocialMessaging.UpdateWhatsAppFlowAssetsHttp,
        SocialMessaging.PublishWhatsAppFlowHttp,
        SocialMessaging.DeprecateWhatsAppFlowHttp,
        SocialMessaging.DeleteWhatsAppFlowHttp,
      ),
    ),
  ),
);
