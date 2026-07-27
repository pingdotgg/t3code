import * as AppIntegrations from "@/AWS/AppIntegrations";
import { Key } from "@/AWS/KMS";
import * as Lambda from "@/AWS/Lambda";
import { Bucket } from "@/AWS/S3";
import * as Output from "@/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class AppIntegrationsTestFunction extends Lambda.Function<Lambda.Function>()(
  "AppIntegrationsTestFunction",
) {}

export default AppIntegrationsTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const application = yield* AppIntegrations.Application("BindingsApp", {
      namespace: "com.alchemy.bindingstest",
      accessUrl: "https://example.com",
    });

    const bucket = yield* Bucket("BindingsContent", { forceDestroy: true });
    const key = yield* Key("BindingsKey", {
      description: "alchemy appintegrations bindings test key",
      deletionWindow: "7 days",
    });
    const dataIntegration = yield* AppIntegrations.DataIntegration(
      "BindingsData",
      {
        kmsKey: key.keyArn,
        sourceURI: Output.interpolate`s3://${bucket.bucketName}`,
      },
    );

    // Event source: creates the EventIntegration + the EventBridge rule on
    // the default bus, and registers the runtime handler. Partner events
    // never fire in tests (there is no real partner source); the deploy-time
    // wiring is what is under test.
    const eventIntegration = yield* AppIntegrations.consumeIntegrationEvents(
      "BindingsPartnerEvents",
      { source: "aws.partner/examplepartner.com/alchemy-bindings" },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(`integration event: ${event["detail-type"]}`),
        ),
    );

    const createDataIntegrationAssociation =
      yield* AppIntegrations.CreateDataIntegrationAssociation(dataIntegration);
    const updateDataIntegrationAssociation =
      yield* AppIntegrations.UpdateDataIntegrationAssociation(dataIntegration);

    const listApplications = yield* AppIntegrations.ListApplications();
    const listApplicationAssociations =
      yield* AppIntegrations.ListApplicationAssociations(application);
    const listDataIntegrations = yield* AppIntegrations.ListDataIntegrations();
    const listDataIntegrationAssociations =
      yield* AppIntegrations.ListDataIntegrationAssociations(dataIntegration);
    const listEventIntegrations =
      yield* AppIntegrations.ListEventIntegrations();
    const listEventIntegrationAssociations =
      yield* AppIntegrations.ListEventIntegrationAssociations(eventIntegration);

    const ApplicationId = yield* application.applicationId;
    const DataIntegrationId = yield* dataIntegration.dataIntegrationId;
    const EventIntegrationName = yield* eventIntegration.eventIntegrationName;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/applications") {
          const result = yield* listApplications();
          return yield* HttpServerResponse.json({
            self: yield* ApplicationId,
            applications: result.Applications ?? [],
          });
        }

        if (
          request.method === "GET" &&
          pathname === "/application-associations"
        ) {
          const result = yield* listApplicationAssociations();
          return yield* HttpServerResponse.json({
            associations: result.ApplicationAssociations ?? [],
          });
        }

        if (request.method === "GET" && pathname === "/data-integrations") {
          const result = yield* listDataIntegrations();
          return yield* HttpServerResponse.json({
            self: yield* DataIntegrationId,
            dataIntegrations: result.DataIntegrations ?? [],
          });
        }

        if (
          request.method === "POST" &&
          pathname === "/data-integration-associations"
        ) {
          // Create an association (idempotently — a retried request reuses
          // the one already created for our ClientId), then rerun its
          // on-demand job via update. Errors are surfaced as typed tags so
          // the test can retry through IAM propagation and report the exact
          // failure on a terminal error.
          const clientId = "alchemy-bindings-test-client";
          const existing = yield* listDataIntegrationAssociations();
          const found = (existing.DataIntegrationAssociations ?? []).find(
            (association) => association.ClientId === clientId,
          );
          const created = found?.DataIntegrationAssociationArn
            ? {
                created: "ok" as string,
                associationId:
                  found.DataIntegrationAssociationArn.split("/").at(-1),
              }
            : yield* createDataIntegrationAssociation({
                ClientId: clientId,
                ClientAssociationMetadata: {
                  purpose: "alchemy-bindings-test",
                },
              }).pipe(
                Effect.map((result) => ({
                  created: "ok" as string,
                  associationId: result.DataIntegrationAssociationId,
                })),
                Effect.catch((error) =>
                  Effect.succeed({
                    created: error._tag as string,
                    message: error.message,
                    associationId: undefined as string | undefined,
                  }),
                ),
              );
          const startTime = yield* Effect.sync(() => Date.now().toString());
          const updated = created.associationId
            ? yield* updateDataIntegrationAssociation({
                DataIntegrationAssociationIdentifier: created.associationId,
                ExecutionConfiguration: {
                  ExecutionMode: "ON_DEMAND",
                  OnDemandConfiguration: { StartTime: startTime },
                },
              }).pipe(
                Effect.as("ok" as string),
                Effect.catch((error) => Effect.succeed(error._tag as string)),
              )
            : "skipped";
          return yield* HttpServerResponse.json({ ...created, updated });
        }

        if (
          request.method === "GET" &&
          pathname === "/data-integration-associations"
        ) {
          const result = yield* listDataIntegrationAssociations();
          return yield* HttpServerResponse.json({
            associations: result.DataIntegrationAssociations ?? [],
          });
        }

        if (request.method === "GET" && pathname === "/event-integrations") {
          const result = yield* listEventIntegrations();
          return yield* HttpServerResponse.json({
            self: yield* EventIntegrationName,
            eventIntegrations: result.EventIntegrations ?? [],
          });
        }

        if (
          request.method === "GET" &&
          pathname === "/event-integration-associations"
        ) {
          const result = yield* listEventIntegrationAssociations();
          return yield* HttpServerResponse.json({
            associations: result.EventIntegrationAssociations ?? [],
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
        AppIntegrations.CreateDataIntegrationAssociationHttp,
        AppIntegrations.UpdateDataIntegrationAssociationHttp,
        AppIntegrations.ListApplicationsHttp,
        AppIntegrations.ListApplicationAssociationsHttp,
        AppIntegrations.ListDataIntegrationsHttp,
        AppIntegrations.ListDataIntegrationAssociationsHttp,
        AppIntegrations.ListEventIntegrationsHttp,
        AppIntegrations.ListEventIntegrationAssociationsHttp,
      ),
    ),
  ),
);
