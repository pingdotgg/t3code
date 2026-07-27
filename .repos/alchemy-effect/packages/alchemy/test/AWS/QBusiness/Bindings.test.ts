import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import QBusinessTestFunctionLive, { QBusinessTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test } = Test.make(testOptions);

// A well-formed-but-nonexistent application/index/data-source id the ungated
// probes are driven against.
const NONEXISTENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// ---------------------------------------------------------------------------
// Ungated typed-error probes: every operation the thirty-six bindings wrap is
// exercised directly through distilled against a nonexistent application, and
// must answer with a typed tag. These prove the distilled error unions (and
// request serialization) at near-zero cost on every CI pass, while the full
// runtime fixture below is gated behind the minutes-long, hourly-billed
// application + index provisioning.
// ---------------------------------------------------------------------------

describe("QBusiness binding operations (typed-error probes)", () => {
  const expectTag = (error: { _tag: string }, tags: readonly string[]) =>
    expect(tags).toContain(error._tag);
  const NOT_FOUND = ["ResourceNotFoundException"] as const;
  // Operations whose body preconditions may be validated before the
  // application lookup surface either tag.
  const NOT_FOUND_OR_INVALID = [
    "ResourceNotFoundException",
    "ValidationException",
  ] as const;
  // Chat operations may reject on licensing/authorization before resolving
  // the application.
  const CHAT_TAGS = [
    "ResourceNotFoundException",
    "AccessDeniedException",
    "LicenseNotFoundException",
    "ValidationException",
  ] as const;

  test.provider("chatSync yields a typed error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        qbusiness.chatSync({
          applicationId: NONEXISTENT,
          userMessage: "probe",
        }),
      );
      expectTag(error, CHAT_TAGS);
    }),
  );

  test.provider("searchRelevantContent yields a typed error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        qbusiness.searchRelevantContent({
          applicationId: NONEXISTENT,
          queryText: "probe",
          contentSource: { retriever: { retrieverId: NONEXISTENT } },
        }),
      );
      expectTag(error, CHAT_TAGS);
    }),
  );

  test.provider("putFeedback yields a typed error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        qbusiness.putFeedback({
          applicationId: NONEXISTENT,
          conversationId: NONEXISTENT,
          messageId: NONEXISTENT,
          messageUsefulness: {
            usefulness: "USEFUL",
            submittedAt: new Date(),
          },
        }),
      );
      expectTag(error, NOT_FOUND_OR_INVALID);
    }),
  );

  test.provider(
    "getChatControlsConfiguration yields a typed not-found error",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          qbusiness.getChatControlsConfiguration({
            applicationId: NONEXISTENT,
          }),
        );
        expectTag(error, NOT_FOUND);
      }),
  );

  test.provider(
    "updateChatControlsConfiguration yields a typed not-found error",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          qbusiness.updateChatControlsConfiguration({
            applicationId: NONEXISTENT,
            responseScope: "ENTERPRISE_CONTENT_ONLY",
          }),
        );
        expectTag(error, NOT_FOUND);
      }),
  );

  test.provider(
    "deleteChatControlsConfiguration yields a typed not-found error",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          qbusiness.deleteChatControlsConfiguration({
            applicationId: NONEXISTENT,
          }),
        );
        expectTag(error, NOT_FOUND);
      }),
  );

  test.provider("listConversations yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        qbusiness.listConversations({ applicationId: NONEXISTENT }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );

  test.provider("deleteConversation yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        qbusiness.deleteConversation({
          applicationId: NONEXISTENT,
          conversationId: NONEXISTENT,
        }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );

  test.provider("listMessages yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        qbusiness.listMessages({
          applicationId: NONEXISTENT,
          conversationId: NONEXISTENT,
        }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );

  test.provider("listAttachments yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        qbusiness.listAttachments({ applicationId: NONEXISTENT }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );

  test.provider("deleteAttachment yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        qbusiness.deleteAttachment({
          applicationId: NONEXISTENT,
          conversationId: NONEXISTENT,
          attachmentId: NONEXISTENT,
        }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );

  test.provider("getMedia yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        qbusiness.getMedia({
          applicationId: NONEXISTENT,
          conversationId: NONEXISTENT,
          messageId: NONEXISTENT,
          mediaId: NONEXISTENT,
        }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );

  test.provider("createUser yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        qbusiness.createUser({
          applicationId: NONEXISTENT,
          userId: "probe@example.com",
        }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );

  test.provider("getUser yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        qbusiness.getUser({
          applicationId: NONEXISTENT,
          userId: "probe@example.com",
        }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );

  test.provider("updateUser yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        qbusiness.updateUser({
          applicationId: NONEXISTENT,
          userId: "probe@example.com",
        }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );

  test.provider("deleteUser yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        qbusiness.deleteUser({
          applicationId: NONEXISTENT,
          userId: "probe@example.com",
        }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );

  test.provider("getPolicy yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        qbusiness.getPolicy({ applicationId: NONEXISTENT }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );

  test.provider("associatePermission yields a typed error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        qbusiness.associatePermission({
          applicationId: NONEXISTENT,
          statementId: "probe",
          actions: ["qbusiness:SearchRelevantContent"],
          principal: "arn:aws:iam::123456789012:role/AlchemyProbeRole",
        }),
      );
      expectTag(error, NOT_FOUND_OR_INVALID);
    }),
  );

  test.provider("disassociatePermission yields a typed error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        qbusiness.disassociatePermission({
          applicationId: NONEXISTENT,
          statementId: "probe",
        }),
      );
      expectTag(error, NOT_FOUND_OR_INVALID);
    }),
  );

  test.provider("createSubscription yields a typed error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        qbusiness.createSubscription({
          applicationId: NONEXISTENT,
          principal: { user: NONEXISTENT },
          type: "Q_LITE",
        }),
      );
      expectTag(error, NOT_FOUND_OR_INVALID);
    }),
  );

  test.provider("updateSubscription yields a typed error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        qbusiness.updateSubscription({
          applicationId: NONEXISTENT,
          subscriptionId: NONEXISTENT,
          type: "Q_LITE",
        }),
      );
      expectTag(error, NOT_FOUND_OR_INVALID);
    }),
  );

  test.provider("cancelSubscription yields a typed error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        qbusiness.cancelSubscription({
          applicationId: NONEXISTENT,
          subscriptionId: NONEXISTENT,
        }),
      );
      expectTag(error, NOT_FOUND_OR_INVALID);
    }),
  );

  // listSubscriptions does NOT 404 a nonexistent application — the live API
  // answers with an empty page, which the probe pins down.
  test.provider("listSubscriptions answers an empty page", () =>
    Effect.gen(function* () {
      const response = yield* qbusiness.listSubscriptions({
        applicationId: NONEXISTENT,
      });
      expect(response.subscriptions ?? []).toHaveLength(0);
    }),
  );

  test.provider("batchPutDocument yields a typed error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        qbusiness.batchPutDocument({
          applicationId: NONEXISTENT,
          indexId: NONEXISTENT,
          documents: [
            {
              id: "probe",
              content: { blob: new TextEncoder().encode("probe") },
              contentType: "PLAIN_TEXT",
            },
          ],
        }),
      );
      expectTag(error, NOT_FOUND_OR_INVALID);
    }),
  );

  test.provider("batchDeleteDocument yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        qbusiness.batchDeleteDocument({
          applicationId: NONEXISTENT,
          indexId: NONEXISTENT,
          documents: [{ documentId: "probe" }],
        }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );

  test.provider("listDocuments yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        qbusiness.listDocuments({
          applicationId: NONEXISTENT,
          indexId: NONEXISTENT,
        }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );

  test.provider("getDocumentContent yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        qbusiness.getDocumentContent({
          applicationId: NONEXISTENT,
          indexId: NONEXISTENT,
          documentId: "probe",
        }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );

  test.provider("checkDocumentAccess yields a typed error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        qbusiness.checkDocumentAccess({
          applicationId: NONEXISTENT,
          indexId: NONEXISTENT,
          userId: "probe@example.com",
          documentId: "probe",
        }),
      );
      expectTag(error, NOT_FOUND_OR_INVALID);
    }),
  );

  test.provider("putGroup yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        qbusiness.putGroup({
          applicationId: NONEXISTENT,
          indexId: NONEXISTENT,
          groupName: "probe",
          type: "INDEX",
          groupMembers: {
            memberUsers: [{ userId: "probe@example.com", type: "INDEX" }],
          },
        }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );

  test.provider("getGroup yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        qbusiness.getGroup({
          applicationId: NONEXISTENT,
          indexId: NONEXISTENT,
          groupName: "probe",
        }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );

  test.provider("deleteGroup yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        qbusiness.deleteGroup({
          applicationId: NONEXISTENT,
          indexId: NONEXISTENT,
          groupName: "probe",
        }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );

  test.provider("listGroups yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        qbusiness.listGroups({
          applicationId: NONEXISTENT,
          indexId: NONEXISTENT,
          updatedEarlierThan: new Date(),
        }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );

  test.provider("startDataSourceSyncJob yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        qbusiness.startDataSourceSyncJob({
          applicationId: NONEXISTENT,
          indexId: NONEXISTENT,
          dataSourceId: NONEXISTENT,
        }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );

  test.provider("stopDataSourceSyncJob yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        qbusiness.stopDataSourceSyncJob({
          applicationId: NONEXISTENT,
          indexId: NONEXISTENT,
          dataSourceId: NONEXISTENT,
        }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );

  test.provider("listDataSourceSyncJobs yields a typed not-found error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        qbusiness.listDataSourceSyncJobs({
          applicationId: NONEXISTENT,
          indexId: NONEXISTENT,
          dataSourceId: NONEXISTENT,
        }),
      );
      expectTag(error, NOT_FOUND);
    }),
  );

  test.provider(
    "createAnonymousWebExperienceUrl yields a typed not-found error",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          qbusiness.createAnonymousWebExperienceUrl({
            applicationId: NONEXISTENT,
            webExperienceId: NONEXISTENT,
          }),
        );
        expectTag(error, NOT_FOUND);
      }),
  );
});

// ---------------------------------------------------------------------------
// Full runtime fixture: a Lambda bound to all thirty-six bindings against a
// live ANONYMOUS-identity application + STARTER index + CUSTOM data source +
// native retriever + web experience. The application/index take minutes to
// provision and the index bills hourly once ACTIVE, so this is gated behind
// AWS_TEST_QBUSINESS=1 and always destroys what it created.
// ---------------------------------------------------------------------------

const sharedStack = Core.scratchStack(testOptions, "QBusinessBindings");

test.provider.skipIf(!process.env.AWS_TEST_QBUSINESS)(
  "all bindings against a live anonymous application",
  () =>
    Effect.gen(function* () {
      yield* sharedStack.destroy();

      yield* Effect.gen(function* () {
        const { functionUrl } = yield* sharedStack.deploy(
          Effect.gen(function* () {
            return yield* QBusinessTestFunction;
          }).pipe(Effect.provide(QBusinessTestFunctionLive)),
        );
        expect(functionUrl).toBeTruthy();
        const baseUrl = functionUrl!.replace(/\/+$/, "");

        const getJson = (path: string) =>
          HttpClient.get(`${baseUrl}${path}`).pipe(
            Effect.flatMap((response) =>
              response.status >= 500
                ? Effect.fail(
                    new Error(`transient upstream ${response.status}`),
                  )
                : Effect.succeed(response),
            ),
            Effect.retry({
              schedule: Schedule.max([
                Schedule.exponential("500 millis"),
                Schedule.recurs(10),
              ]),
            }),
            Effect.flatMap((r) => r.json),
          );

        // All thirty-six capabilities initialized in the runtime.
        const bindings = (yield* getJson("/bindings")) as { bound: string[] };
        expect(bindings.bound).toHaveLength(36);

        // CUSTOM connector sync cycle — proves the three data-source
        // bindings and the id injection.
        const sync = (yield* getJson("/sync-cycle")) as {
          executionId?: string | null;
          jobs?: number | string;
          stopped?: boolean;
          errorTag?: string;
        };
        expect(sync.errorTag).toBeUndefined();
        expect(sync.executionId).toBeTruthy();

        // BatchPutDocument — proves applicationId/indexId injection + IAM.
        const put = (yield* getJson("/put-documents")) as {
          failed?: number;
          errorTag?: string;
        };
        expect(put.errorTag).toBeUndefined();
        expect(put.failed).toBe(0);

        // ListDocuments — poll (bounded) until the pushed document leaves
        // the processing states.
        const statuses = yield* getJson("/documents").pipe(
          Effect.map((r) => (r as { statuses?: string[] }).statuses ?? []),
          Effect.repeat({
            schedule: Schedule.spaced("10 seconds"),
            until: (s): boolean =>
              s.includes("INDEXED") || s.includes("FAILED"),
            times: 30,
          }),
        );
        expect(statuses).toContain("INDEXED");

        // GetDocumentContent + CheckDocumentAccess over the pushed document.
        const content = (yield* getJson("/document-content")) as {
          hasUrl?: boolean;
          errorTag?: string;
        };
        expect(content.errorTag).toBeUndefined();
        expect(content.hasUrl).toBe(true);

        // ChatSync — the flagship data-plane call answers over the indexed
        // document.
        const chat = (yield* getJson("/chat?q=What is the passphrase?")) as {
          conversationId?: string;
          messageId?: string;
          hasMessage?: boolean;
          errorTag?: string;
        };
        expect(chat.errorTag).toBeUndefined();
        expect(chat.hasMessage).toBe(true);

        // SearchRelevantContent through the native retriever.
        const search = (yield* getJson("/search?q=zanzibar passphrase")) as {
          count?: number;
          errorTag?: string;
        };
        expect(search.errorTag).toBeUndefined();

        // Chat controls read + update round trip.
        const controls = (yield* getJson("/controls")) as {
          responseScope?: string | null;
          errorTag?: string;
        };
        expect(controls.errorTag).toBeUndefined();
        const updateControls = (yield* getJson("/update-controls")) as {
          ok?: boolean;
          errorTag?: string;
        };
        expect(updateControls.errorTag).toBeUndefined();

        // Application policy read.
        const policy = (yield* getJson("/policy")) as {
          policy?: string | null;
          errorTag?: string;
        };
        expect(policy.errorTag).toBeUndefined();

        // Anonymous URL minting (ANONYMOUS identity type).
        const anonymousUrl = (yield* getJson("/anonymous-url")) as {
          hasUrl?: boolean;
          errorTag?: string;
        };
        expect(anonymousUrl.errorTag).toBeUndefined();
        expect(anonymousUrl.hasUrl).toBe(true);

        // The remaining routes must answer 200 with either concrete fields
        // or a TYPED error tag (an ANONYMOUS application rejects the user
        // store / subscription plane with typed errors) — an untyped error
        // would crash the route into a 500 and fail getJson.
        for (const path of [
          "/conversations",
          "/attachments",
          "/delete-attachment",
          "/media",
          "/users",
          "/groups",
          "/subscriptions",
          "/subscription-cycle",
          "/associate-permission",
          "/disassociate-permission",
          "/check-access",
        ]) {
          const result = (yield* getJson(path)) as Record<string, unknown>;
          expect(result).toBeTruthy();
        }

        // BatchDeleteDocument cleanup.
        const deleted = (yield* getJson("/delete-documents")) as {
          failed?: number;
          errorTag?: string;
        };
        expect(deleted.errorTag).toBeUndefined();
      }).pipe(Effect.ensuring(sharedStack.destroy().pipe(Effect.orDie)));
    }),
  { timeout: 3_600_000 },
);
