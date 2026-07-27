import * as Lambda from "@/AWS/Lambda";
import * as Notifications from "@/AWS/Notifications";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

/** A Date `days` days in the past (UTC). */
const daysAgo = (days: number) =>
  Effect.sync(() => new Date(Date.now() - days * 24 * 3600 * 1000));

/**
 * Fabricate a well-formed same-account notification-event ARN that cannot
 * exist — drives the typed not-found path for GetNotificationEvent /
 * GetManagedNotificationChildEvent, proving the grant reaches the API (an
 * IAM gap would surface AccessDeniedException instead).
 */
const fakeEventArn = (accountId: string) =>
  `arn:aws:notifications::${accountId}:configuration/a01000000000000000000000000/event/a01000000000000000000000000`;

export class NotificationsTestFunction extends Lambda.Function<Lambda.Function>()(
  "NotificationsTestFunction",
) {}

export default NotificationsTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // A configuration owned by the fixture — the ListChannels binding is
    // scoped to it (proving ARN injection + the configuration-scoped grant).
    const config = yield* Notifications.NotificationConfiguration(
      "BindingsConfig",
      { description: "notifications bindings fixture" },
    );

    // --- account-level bindings ---
    const getNotificationEvent = yield* Notifications.GetNotificationEvent();
    const listNotificationEvents =
      yield* Notifications.ListNotificationEvents();
    const getManagedNotificationEvent =
      yield* Notifications.GetManagedNotificationEvent();
    const listManagedNotificationEvents =
      yield* Notifications.ListManagedNotificationEvents();
    const getManagedNotificationChildEvent =
      yield* Notifications.GetManagedNotificationChildEvent();
    const listManagedNotificationChildEvents =
      yield* Notifications.ListManagedNotificationChildEvents();
    const getManagedNotificationConfiguration =
      yield* Notifications.GetManagedNotificationConfiguration();
    const listManagedNotificationConfigurations =
      yield* Notifications.ListManagedNotificationConfigurations();
    const listManagedNotificationChannelAssociations =
      yield* Notifications.ListManagedNotificationChannelAssociations();

    // --- configuration-scoped bindings ---
    const listChannels = yield* Notifications.ListChannels(config);

    const bound = {
      getNotificationEvent,
      listNotificationEvents,
      getManagedNotificationEvent,
      listManagedNotificationEvents,
      getManagedNotificationChildEvent,
      listManagedNotificationChildEvents,
      getManagedNotificationConfiguration,
      listManagedNotificationConfigurations,
      listManagedNotificationChannelAssociations,
      listChannels,
    };

    // The first managed configuration ARN doubles as the account-id source
    // for fabricated ARNs (every account has the AWS Health categories).
    const firstManagedConfigArn = listManagedNotificationConfigurations().pipe(
      Effect.map((r) => r.managedNotificationConfigurations[0]?.arn),
    );

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

        if (request.method === "GET" && pathname === "/events") {
          const result = yield* listNotificationEvents({
            startTime: yield* daysAgo(7),
          });
          return yield* HttpServerResponse.json({
            count: result.notificationEvents.length,
          });
        }

        if (request.method === "GET" && pathname === "/event-nonexistent") {
          // Typed not-found path — proves the GetNotificationEvent grant.
          const managedArn = yield* firstManagedConfigArn;
          const accountId = managedArn?.split(":")[4] ?? "000000000000";
          const result = yield* getNotificationEvent({
            arn: fakeEventArn(accountId),
          }).pipe(
            Effect.map(() => "Ok"),
            Effect.catchTag(
              ["ResourceNotFoundException", "ValidationException"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag: result });
        }

        if (request.method === "GET" && pathname === "/managed-configs") {
          const result = yield* listManagedNotificationConfigurations();
          return yield* HttpServerResponse.json({
            count: result.managedNotificationConfigurations.length,
            names: result.managedNotificationConfigurations.map((c) => c.name),
          });
        }

        if (request.method === "GET" && pathname === "/managed-config") {
          const arn = yield* firstManagedConfigArn;
          if (arn === undefined) {
            return yield* HttpServerResponse.json({ tag: "NoConfigs" });
          }
          const result = yield* getManagedNotificationConfiguration({ arn });
          return yield* HttpServerResponse.json({
            tag: "Ok",
            name: result.name,
          });
        }

        if (request.method === "GET" && pathname === "/managed-events") {
          const result = yield* listManagedNotificationEvents({
            startTime: yield* daysAgo(7),
          });
          return yield* HttpServerResponse.json({
            count: result.managedNotificationEvents.length,
          });
        }

        if (request.method === "GET" && pathname === "/managed-event") {
          const listed = yield* listManagedNotificationEvents({
            startTime: yield* daysAgo(7),
            maxResults: 5,
          });
          const first = listed.managedNotificationEvents[0];
          if (first === undefined) {
            return yield* HttpServerResponse.json({ tag: "NoEvents" });
          }
          const result = yield* getManagedNotificationEvent({
            arn: first.arn,
          });
          return yield* HttpServerResponse.json({
            tag: "Ok",
            configurationArn: result.managedNotificationConfigurationArn,
          });
        }

        if (request.method === "GET" && pathname === "/managed-child-events") {
          const listed = yield* listManagedNotificationEvents({
            startTime: yield* daysAgo(7),
            maxResults: 5,
          });
          const first = listed.managedNotificationEvents[0];
          if (first === undefined) {
            return yield* HttpServerResponse.json({ tag: "NoEvents" });
          }
          // Most managed events are not aggregates — a ValidationException
          // for a non-aggregate parent still proves the grant + typed union.
          const result = yield* listManagedNotificationChildEvents({
            aggregateManagedNotificationEventArn: first.arn,
          }).pipe(
            Effect.map((r) => ({
              tag: "Ok",
              count: r.managedNotificationChildEvents.length,
            })),
            Effect.catchTag(
              ["ValidationException", "ResourceNotFoundException"],
              (e) => Effect.succeed({ tag: e._tag, count: 0 }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (
          request.method === "GET" &&
          pathname === "/managed-child-event-nonexistent"
        ) {
          // Typed not-found path — proves the grant reaches the API.
          const managedArn = yield* firstManagedConfigArn;
          const accountId = managedArn?.split(":")[4] ?? "000000000000";
          const result = yield* getManagedNotificationChildEvent({
            arn: fakeEventArn(accountId),
          }).pipe(
            Effect.map(() => "Ok"),
            Effect.catchTag(
              ["ResourceNotFoundException", "ValidationException"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag: result });
        }

        if (
          request.method === "GET" &&
          pathname === "/managed-channel-associations"
        ) {
          const arn = yield* firstManagedConfigArn;
          if (arn === undefined) {
            return yield* HttpServerResponse.json({ tag: "NoConfigs" });
          }
          const result = yield* listManagedNotificationChannelAssociations({
            managedNotificationConfigurationArn: arn,
          });
          return yield* HttpServerResponse.json({
            tag: "Ok",
            count: result.channelAssociations.length,
          });
        }

        if (request.method === "GET" && pathname === "/channels") {
          const result = yield* listChannels();
          return yield* HttpServerResponse.json({
            count: result.channels.length,
          });
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
        Notifications.GetNotificationEventHttp,
        Notifications.ListNotificationEventsHttp,
        Notifications.GetManagedNotificationEventHttp,
        Notifications.ListManagedNotificationEventsHttp,
        Notifications.GetManagedNotificationChildEventHttp,
        Notifications.ListManagedNotificationChildEventsHttp,
        Notifications.GetManagedNotificationConfigurationHttp,
        Notifications.ListManagedNotificationConfigurationsHttp,
        Notifications.ListManagedNotificationChannelAssociationsHttp,
        Notifications.ListChannelsHttp,
      ),
    ),
  ),
);
