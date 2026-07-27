import * as AWS from "@/AWS";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// Bindings fixture: a personal contact with a deferred-activation email
// channel and a daily rotation, plus a Lambda that exercises the SSM
// Contacts runtime bindings against them. Requires the account's Incident
// Manager replication set (gated behind AWS_TEST_INCIDENT_MANAGER).
export class ContactsBindingsFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "ContactsBindingsFunction",
) {}

export class BoundContacts extends Context.Service<
  BoundContacts,
  {
    oncall: AWS.SSMContacts.Contact;
    email: AWS.SSMContacts.ContactChannel;
    rotation: AWS.SSMContacts.Rotation;
  }
>()("BoundContacts") {}

export const BoundContactsLive = Layer.effect(
  BoundContacts,
  Effect.gen(function* () {
    const oncall = yield* AWS.SSMContacts.Contact("BindingsOncall", {
      type: "PERSONAL",
      displayName: "Bindings Fixture On-Call",
    });
    const email = yield* AWS.SSMContacts.ContactChannel("BindingsEmail", {
      contactId: oncall.contactArn,
      type: "EMAIL",
      deliveryAddress: { SimpleAddress: "oncall@example.com" },
      deferActivation: true,
    });
    const rotation = yield* AWS.SSMContacts.Rotation("BindingsRotation", {
      contactIds: [oncall.contactArn],
      timeZoneId: "America/Los_Angeles",
      startTime: "2030-01-01T00:00:00Z",
      recurrence: {
        NumberOfOnCalls: 1,
        RecurrenceMultiplier: 1,
        DailySettings: [{ HourOfDay: 9, MinuteOfHour: 0 }],
      },
    });
    return { oncall, email, rotation };
  }),
);

export default ContactsBindingsFunction.make(
  {
    main: import.meta.url,
    url: true,
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    const { oncall, email, rotation } = yield* BoundContacts;

    const startEngagement = yield* AWS.SSMContacts.StartEngagement(oncall);
    const listPagesByContact =
      yield* AWS.SSMContacts.ListPagesByContact(oncall);
    const stopEngagement = yield* AWS.SSMContacts.StopEngagement();
    const describeEngagement = yield* AWS.SSMContacts.DescribeEngagement();
    const listEngagements = yield* AWS.SSMContacts.ListEngagements();
    const acceptPage = yield* AWS.SSMContacts.AcceptPage();
    const describePage = yield* AWS.SSMContacts.DescribePage();
    const listPageReceipts = yield* AWS.SSMContacts.ListPageReceipts();
    const listPageResolutions = yield* AWS.SSMContacts.ListPageResolutions();
    const listPagesByEngagement =
      yield* AWS.SSMContacts.ListPagesByEngagement();
    const sendActivationCode = yield* AWS.SSMContacts.SendActivationCode(email);
    const activateContactChannel =
      yield* AWS.SSMContacts.ActivateContactChannel(email);
    const deactivateContactChannel =
      yield* AWS.SSMContacts.DeactivateContactChannel(email);
    const listRotationShifts =
      yield* AWS.SSMContacts.ListRotationShifts(rotation);
    const listPreviewRotationShifts =
      yield* AWS.SSMContacts.ListPreviewRotationShifts();
    const createRotationOverride =
      yield* AWS.SSMContacts.CreateRotationOverride(rotation);
    const getRotationOverride =
      yield* AWS.SSMContacts.GetRotationOverride(rotation);
    const deleteRotationOverride =
      yield* AWS.SSMContacts.DeleteRotationOverride(rotation);
    const listRotationOverrides =
      yield* AWS.SSMContacts.ListRotationOverrides(rotation);

    const bound = {
      startEngagement,
      listPagesByContact,
      stopEngagement,
      describeEngagement,
      listEngagements,
      acceptPage,
      describePage,
      listPageReceipts,
      listPageResolutions,
      listPagesByEngagement,
      sendActivationCode,
      activateContactChannel,
      deactivateContactChannel,
      listRotationShifts,
      listPreviewRotationShifts,
      createRotationOverride,
      getRotationOverride,
      deleteRotationOverride,
      listRotationOverrides,
    };

    // Accessor for the contact's ARN — an Accessor<string> at init scope,
    // resolved with a second yield inside the runtime fetch handler.
    const oncallArn = yield* oncall.contactArn;

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

        if (request.method === "GET" && pathname === "/shifts") {
          const week = 7 * 24 * 60 * 60 * 1000;
          const { RotationShifts } = yield* listRotationShifts({
            EndTime: new Date(Date.now() + week),
          });
          const preview = yield* listPreviewRotationShifts({
            EndTime: new Date(Date.now() + week),
            Members: [yield* oncallArn],
            TimeZoneId: "America/Los_Angeles",
            Recurrence: {
              NumberOfOnCalls: 1,
              RecurrenceMultiplier: 1,
              DailySettings: [{ HourOfDay: 9, MinuteOfHour: 0 }],
            },
          });
          return yield* HttpServerResponse.json({
            shifts: (RotationShifts ?? []).length,
            previewShifts: (preview.RotationShifts ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/override") {
          const hour = 60 * 60 * 1000;
          const { RotationOverrideId } = yield* createRotationOverride({
            NewContactIds: [yield* oncallArn],
            StartTime: new Date(Date.now() + hour),
            EndTime: new Date(Date.now() + 2 * hour),
          });
          const override = yield* getRotationOverride({ RotationOverrideId });
          const { RotationOverrides } = yield* listRotationOverrides({
            StartTime: new Date(),
            EndTime: new Date(Date.now() + 3 * hour),
          });
          yield* deleteRotationOverride({ RotationOverrideId });
          return yield* HttpServerResponse.json({
            overrideId: RotationOverrideId,
            newContactIds: override.NewContactIds,
            listed: (RotationOverrides ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/engage") {
          const { EngagementArn } = yield* startEngagement({
            Sender: "alchemy-bindings-fixture",
            Subject: "alchemy bindings fixture engagement",
            Content: "Exercising the SSM Contacts runtime bindings.",
          });
          const engagement = yield* describeEngagement({
            EngagementId: EngagementArn,
          });
          // Pages materialize asynchronously — poll briefly (bounded).
          const pages = yield* listPagesByEngagement({
            EngagementId: EngagementArn,
          }).pipe(
            Effect.map((r) => r.Pages ?? []),
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (pages): boolean => pages.length > 0,
              times: 10,
            }),
          );
          let receipts = 0;
          let resolutions = 0;
          const pageArn = pages[0]?.PageArn;
          if (pageArn !== undefined) {
            yield* describePage({ PageId: pageArn });
            receipts = yield* listPageReceipts({ PageId: pageArn }).pipe(
              Effect.map((r) => (r.Receipts ?? []).length),
            );
            resolutions = yield* listPageResolutions({ PageId: pageArn }).pipe(
              Effect.map((r) => (r.PageResolutions ?? []).length),
            );
          }
          yield* stopEngagement({
            EngagementId: EngagementArn,
            Reason: "fixture done",
          });
          return yield* HttpServerResponse.json({
            engagementArn: EngagementArn,
            subject: engagement.Subject,
            pages: pages.length,
            receipts,
            resolutions,
          });
        }

        if (request.method === "GET" && pathname === "/pages") {
          const { Engagements } = yield* listEngagements();
          const { Pages } = yield* listPagesByContact();
          return yield* HttpServerResponse.json({
            engagements: (Engagements ?? []).length,
            pages: (Pages ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/channel") {
          yield* sendActivationCode();
          yield* deactivateContactChannel();
          return yield* HttpServerResponse.json({ ok: true });
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
        AWS.SSMContacts.StartEngagementHttp,
        AWS.SSMContacts.ListPagesByContactHttp,
        AWS.SSMContacts.StopEngagementHttp,
        AWS.SSMContacts.DescribeEngagementHttp,
        AWS.SSMContacts.ListEngagementsHttp,
        AWS.SSMContacts.AcceptPageHttp,
        AWS.SSMContacts.DescribePageHttp,
        AWS.SSMContacts.ListPageReceiptsHttp,
        AWS.SSMContacts.ListPageResolutionsHttp,
        AWS.SSMContacts.ListPagesByEngagementHttp,
        AWS.SSMContacts.SendActivationCodeHttp,
        AWS.SSMContacts.ActivateContactChannelHttp,
        AWS.SSMContacts.DeactivateContactChannelHttp,
        AWS.SSMContacts.ListRotationShiftsHttp,
        AWS.SSMContacts.ListPreviewRotationShiftsHttp,
        AWS.SSMContacts.CreateRotationOverrideHttp,
        AWS.SSMContacts.GetRotationOverrideHttp,
        AWS.SSMContacts.DeleteRotationOverrideHttp,
        AWS.SSMContacts.ListRotationOverridesHttp,
        BoundContactsLive,
      ),
    ),
  ),
);
