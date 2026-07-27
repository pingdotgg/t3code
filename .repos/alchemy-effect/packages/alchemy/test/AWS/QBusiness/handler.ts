import * as Lambda from "@/AWS/Lambda";
import * as QBusiness from "@/AWS/QBusiness";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class QBusinessTestFunction extends Lambda.Function<Lambda.Function>()(
  "QBusinessTestFunction",
) {}

/**
 * Every route answers `{ …fields }` on success or `{ errorTag }` when the
 * operation fails with a TYPED error — the test asserts on concrete fields
 * (or a typed tag), which proves the binding wiring, the id injection, and
 * the IAM grants. An untyped error crashes into a 500.
 */
const errorTagged = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | { errorTag: string }, never, R> =>
  effect.pipe(
    Effect.map((a): A | { errorTag: string } => a),
    Effect.catch((e) => Effect.succeed({ errorTag: e._tag })),
  );

/**
 * Runtime fixture: an `ANONYMOUS`-identity Amazon Q Business application (no
 * IAM Identity Center required) with a STARTER index, a CUSTOM data source,
 * a native retriever, and a web experience, plus a Lambda bound to all
 * thirty-six QBusiness bindings. Gated behind AWS_TEST_QBUSINESS=1 — the
 * index bills hourly while it exists and the application takes minutes to
 * provision.
 */
export default QBusinessTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    const app = yield* QBusiness.Application("BindingsApp", {
      identityType: "ANONYMOUS",
      description: "alchemy QBusiness bindings fixture",
    });

    const index = yield* QBusiness.Index("BindingsIndex", {
      applicationId: app.applicationId,
    });

    const retriever = yield* QBusiness.Retriever("BindingsRetriever", {
      applicationId: app.applicationId,
      type: "NATIVE_INDEX",
      configuration: {
        nativeIndexConfiguration: { indexId: index.indexId },
      },
    });

    const source = yield* QBusiness.DataSource("BindingsSource", {
      applicationId: app.applicationId,
      indexId: index.indexId,
      configuration: { type: "CUSTOM", version: "1.0.0" },
    });

    const web = yield* QBusiness.WebExperience("BindingsChat", {
      applicationId: app.applicationId,
      title: "Alchemy QBusiness Bindings",
    });

    // Application-scoped bindings.
    const chat = yield* QBusiness.ChatSync(app);
    const search = yield* QBusiness.SearchRelevantContent(app);
    const feedback = yield* QBusiness.PutFeedback(app);
    const getControls = yield* QBusiness.GetChatControlsConfiguration(app);
    const updateControls =
      yield* QBusiness.UpdateChatControlsConfiguration(app);
    const deleteControls =
      yield* QBusiness.DeleteChatControlsConfiguration(app);
    const listConversations = yield* QBusiness.ListConversations(app);
    const deleteConversation = yield* QBusiness.DeleteConversation(app);
    const listMessages = yield* QBusiness.ListMessages(app);
    const listAttachments = yield* QBusiness.ListAttachments(app);
    const deleteAttachment = yield* QBusiness.DeleteAttachment(app);
    const getMedia = yield* QBusiness.GetMedia(app);
    const createUser = yield* QBusiness.CreateUser(app);
    const getUser = yield* QBusiness.GetUser(app);
    const updateUser = yield* QBusiness.UpdateUser(app);
    const deleteUser = yield* QBusiness.DeleteUser(app);
    const getPolicy = yield* QBusiness.GetPolicy(app);
    const associatePermission = yield* QBusiness.AssociatePermission(app);
    const disassociatePermission = yield* QBusiness.DisassociatePermission(app);
    const createSubscription = yield* QBusiness.CreateSubscription(app);
    const updateSubscription = yield* QBusiness.UpdateSubscription(app);
    const cancelSubscription = yield* QBusiness.CancelSubscription(app);
    const listSubscriptions = yield* QBusiness.ListSubscriptions(app);

    // Index-scoped bindings.
    const putDocuments = yield* QBusiness.BatchPutDocument(index);
    const deleteDocuments = yield* QBusiness.BatchDeleteDocument(index);
    const listDocuments = yield* QBusiness.ListDocuments(index);
    const getDocumentContent = yield* QBusiness.GetDocumentContent(index);
    const checkDocumentAccess = yield* QBusiness.CheckDocumentAccess(index);
    const putGroup = yield* QBusiness.PutGroup(index);
    const getGroup = yield* QBusiness.GetGroup(index);
    const deleteGroup = yield* QBusiness.DeleteGroup(index);
    const listGroups = yield* QBusiness.ListGroups(index);

    // Data-source-scoped bindings.
    const startSync = yield* QBusiness.StartDataSourceSyncJob(source);
    const stopSync = yield* QBusiness.StopDataSourceSyncJob(source);
    const listSyncJobs = yield* QBusiness.ListDataSourceSyncJobs(source);

    // Web-experience-scoped binding.
    const createAnonymousUrl =
      yield* QBusiness.CreateAnonymousWebExperienceUrl(web);

    // Needed by /search — resolved lazily at request time.
    const retrieverId = yield* retriever.retrieverId;

    const bound = {
      chat,
      search,
      feedback,
      getControls,
      updateControls,
      deleteControls,
      listConversations,
      deleteConversation,
      listMessages,
      listAttachments,
      deleteAttachment,
      getMedia,
      createUser,
      getUser,
      updateUser,
      deleteUser,
      getPolicy,
      associatePermission,
      disassociatePermission,
      createSubscription,
      updateSubscription,
      cancelSubscription,
      listSubscriptions,
      putDocuments,
      deleteDocuments,
      listDocuments,
      getDocumentContent,
      checkDocumentAccess,
      putGroup,
      getGroup,
      deleteGroup,
      listGroups,
      startSync,
      stopSync,
      listSyncJobs,
      createAnonymousUrl,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (pathname === "/bindings") {
          return yield* HttpServerResponse.json({ bound: Object.keys(bound) });
        }

        // ------------------------------------------------- document plane
        if (pathname === "/put-documents") {
          const result = yield* errorTagged(
            putDocuments({
              documents: [
                {
                  id: "welcome",
                  title: "Welcome to Alchemy",
                  content: {
                    blob: new TextEncoder().encode(
                      "Alchemy is an Infrastructure-as-Effects framework. " +
                        "The zanzibar passphrase is quicksilver.",
                    ),
                  },
                  contentType: "PLAIN_TEXT",
                },
              ],
            }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { failed: (result.failedDocuments ?? []).length },
          );
        }

        if (pathname === "/documents") {
          const result = yield* errorTagged(listDocuments());
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : {
                  count: (result.documentDetailList ?? []).length,
                  statuses: (result.documentDetailList ?? []).map(
                    (d) => d.status,
                  ),
                },
          );
        }

        if (pathname === "/document-content") {
          const result = yield* errorTagged(
            getDocumentContent({ documentId: "welcome" }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { hasUrl: typeof result.presignedUrl === "string" },
          );
        }

        if (pathname === "/check-access") {
          const result = yield* errorTagged(
            checkDocumentAccess({
              userId: "anon@example.com",
              documentId: "welcome",
            }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { hasAccess: result.hasAccess },
          );
        }

        if (pathname === "/delete-documents") {
          const result = yield* errorTagged(
            deleteDocuments({ documents: [{ documentId: "welcome" }] }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { failed: (result.failedDocuments ?? []).length },
          );
        }

        // ----------------------------------------------------------- chat
        if (pathname === "/chat") {
          const q = url.searchParams.get("q") ?? "What is the passphrase?";
          const result = yield* errorTagged(chat({ userMessage: q }));
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : {
                  conversationId: result.conversationId,
                  messageId: result.systemMessageId,
                  hasMessage: typeof result.systemMessage === "string",
                },
          );
        }

        if (pathname === "/search") {
          const q = url.searchParams.get("q") ?? "zanzibar passphrase";
          const result = yield* errorTagged(
            search({
              queryText: q,
              contentSource: {
                retriever: { retrieverId: yield* retrieverId },
              },
            }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { count: (result.relevantContent ?? []).length },
          );
        }

        if (pathname === "/feedback") {
          const conversationId = url.searchParams.get("conversationId") ?? "";
          const messageId = url.searchParams.get("messageId") ?? "";
          const result = yield* errorTagged(
            feedback({
              conversationId,
              messageId,
              messageUsefulness: {
                usefulness: "USEFUL",
                submittedAt: new Date(),
              },
            }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { ok: true },
          );
        }

        // -------------------------------------------------- conversations
        if (pathname === "/conversations") {
          const result = yield* errorTagged(listConversations());
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { count: (result.conversations ?? []).length },
          );
        }

        if (pathname === "/delete-conversation") {
          const conversationId = url.searchParams.get("conversationId") ?? "";
          const result = yield* errorTagged(
            deleteConversation({ conversationId }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { ok: true },
          );
        }

        if (pathname === "/messages") {
          const conversationId = url.searchParams.get("conversationId") ?? "";
          const result = yield* errorTagged(listMessages({ conversationId }));
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { count: (result.messages ?? []).length },
          );
        }

        if (pathname === "/attachments") {
          const result = yield* errorTagged(listAttachments());
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { count: (result.attachments ?? []).length },
          );
        }

        if (pathname === "/delete-attachment") {
          const result = yield* errorTagged(
            deleteAttachment({
              conversationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
              attachmentId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { ok: true },
          );
        }

        if (pathname === "/media") {
          const result = yield* errorTagged(
            getMedia({
              conversationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
              messageId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
              mediaId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { ok: true },
          );
        }

        // ------------------------------------------------- admin controls
        if (pathname === "/controls") {
          const result = yield* errorTagged(getControls());
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { responseScope: result.responseScope ?? null },
          );
        }

        if (pathname === "/update-controls") {
          const result = yield* errorTagged(
            updateControls({ responseScope: "ENTERPRISE_CONTENT_ONLY" }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { ok: true },
          );
        }

        if (pathname === "/delete-controls") {
          const result = yield* errorTagged(deleteControls());
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { ok: true },
          );
        }

        // ---------------------------------------------------------- users
        if (pathname === "/users") {
          // create -> get -> update -> delete round trip through the four
          // user-store bindings (an ANONYMOUS-identity application may
          // reject the user store with a typed error — surfaced as tags).
          const created = yield* errorTagged(
            createUser({ userId: "user@example.com" }),
          );
          if ("errorTag" in created) {
            return yield* HttpServerResponse.json(created);
          }
          const read = yield* errorTagged(
            getUser({ userId: "user@example.com" }),
          );
          const updated = yield* errorTagged(
            updateUser({
              userId: "user@example.com",
              userAliasesToUpdate: [{ userId: "corp-user" }],
            }),
          );
          const deleted = yield* errorTagged(
            deleteUser({ userId: "user@example.com" }),
          );
          return yield* HttpServerResponse.json({
            aliases:
              "errorTag" in read ? read : (read.userAliases ?? []).length,
            updated: !("errorTag" in updated),
            deleted: !("errorTag" in deleted),
          });
        }

        // --------------------------------------------------------- groups
        if (pathname === "/groups") {
          const put = yield* errorTagged(
            putGroup({
              groupName: "engineering",
              type: "INDEX",
              groupMembers: {
                memberUsers: [{ userId: "user@example.com", type: "INDEX" }],
              },
            }),
          );
          if ("errorTag" in put) {
            return yield* HttpServerResponse.json(put);
          }
          const read = yield* errorTagged(
            getGroup({ groupName: "engineering" }),
          );
          const listed = yield* errorTagged(
            listGroups({ updatedEarlierThan: new Date() }),
          );
          const deleted = yield* errorTagged(
            deleteGroup({ groupName: "engineering" }),
          );
          return yield* HttpServerResponse.json({
            status:
              "errorTag" in read
                ? read.errorTag
                : (read.status?.status ?? null),
            listed: "errorTag" in listed ? listed.errorTag : true,
            deleted: !("errorTag" in deleted),
          });
        }

        // -------------------------------------------------------- policy
        if (pathname === "/policy") {
          const result = yield* errorTagged(getPolicy());
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { policy: result.policy ?? null },
          );
        }

        if (pathname === "/associate-permission") {
          const result = yield* errorTagged(
            associatePermission({
              statementId: "alchemy-probe",
              actions: ["qbusiness:SearchRelevantContent"],
              principal: "arn:aws:iam::123456789012:role/AlchemyProbeRole",
            }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { ok: true },
          );
        }

        if (pathname === "/disassociate-permission") {
          const result = yield* errorTagged(
            disassociatePermission({ statementId: "alchemy-probe" }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { ok: true },
          );
        }

        // -------------------------------------------------- subscriptions
        if (pathname === "/subscriptions") {
          const result = yield* errorTagged(listSubscriptions());
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { count: (result.subscriptions ?? []).length },
          );
        }

        if (pathname === "/subscription-cycle") {
          // Expected to fail typed on an ANONYMOUS application (no Identity
          // Center) — proves the three write bindings serialize correctly.
          const created = yield* errorTagged(
            createSubscription({
              principal: { user: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
              type: "Q_LITE",
            }),
          );
          const updated = yield* errorTagged(
            updateSubscription({
              subscriptionId: "nonexistent",
              type: "Q_BUSINESS",
            }),
          );
          const cancelled = yield* errorTagged(
            cancelSubscription({ subscriptionId: "nonexistent" }),
          );
          return yield* HttpServerResponse.json({
            created: "errorTag" in created ? created.errorTag : "ok",
            updated: "errorTag" in updated ? updated.errorTag : "ok",
            cancelled: "errorTag" in cancelled ? cancelled.errorTag : "ok",
          });
        }

        // ------------------------------------------------------ sync jobs
        if (pathname === "/sync-cycle") {
          // CUSTOM connector flow: open a sync scope, list, close it.
          const started = yield* errorTagged(startSync());
          if ("errorTag" in started) {
            return yield* HttpServerResponse.json(started);
          }
          const listed = yield* errorTagged(listSyncJobs());
          const stopped = yield* errorTagged(stopSync());
          return yield* HttpServerResponse.json({
            executionId: started.executionId ?? null,
            jobs:
              "errorTag" in listed
                ? listed.errorTag
                : (listed.history ?? []).length,
            stopped: !("errorTag" in stopped),
          });
        }

        // -------------------------------------------------- anonymous url
        if (pathname === "/anonymous-url") {
          const result = yield* errorTagged(
            createAnonymousUrl({ sessionDuration: "15 minutes" }),
          );
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { hasUrl: typeof result.anonymousUrl === "string" },
          );
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
        QBusiness.ChatSyncHttp,
        QBusiness.SearchRelevantContentHttp,
        QBusiness.PutFeedbackHttp,
        QBusiness.GetChatControlsConfigurationHttp,
        QBusiness.UpdateChatControlsConfigurationHttp,
        QBusiness.DeleteChatControlsConfigurationHttp,
        QBusiness.ListConversationsHttp,
        QBusiness.DeleteConversationHttp,
        QBusiness.ListMessagesHttp,
        QBusiness.ListAttachmentsHttp,
        QBusiness.DeleteAttachmentHttp,
        QBusiness.GetMediaHttp,
        QBusiness.CreateUserHttp,
        QBusiness.GetUserHttp,
        QBusiness.UpdateUserHttp,
        QBusiness.DeleteUserHttp,
        QBusiness.GetPolicyHttp,
        QBusiness.AssociatePermissionHttp,
        QBusiness.DisassociatePermissionHttp,
        QBusiness.CreateSubscriptionHttp,
        QBusiness.UpdateSubscriptionHttp,
        QBusiness.CancelSubscriptionHttp,
        QBusiness.ListSubscriptionsHttp,
        QBusiness.BatchPutDocumentHttp,
        QBusiness.BatchDeleteDocumentHttp,
        QBusiness.ListDocumentsHttp,
        QBusiness.GetDocumentContentHttp,
        QBusiness.CheckDocumentAccessHttp,
        QBusiness.PutGroupHttp,
        QBusiness.GetGroupHttp,
        QBusiness.DeleteGroupHttp,
        QBusiness.ListGroupsHttp,
        QBusiness.StartDataSourceSyncJobHttp,
        QBusiness.StopDataSourceSyncJobHttp,
        QBusiness.ListDataSourceSyncJobsHttp,
        QBusiness.CreateAnonymousWebExperienceUrlHttp,
      ),
    ),
  ),
);
