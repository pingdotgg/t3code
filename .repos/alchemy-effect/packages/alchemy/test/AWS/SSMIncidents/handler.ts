import * as Lambda from "@/AWS/Lambda";
import * as SSMIncidents from "@/AWS/SSMIncidents";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class IncidentsTestFunction extends Lambda.Function<Lambda.Function>()(
  "IncidentsTestFunction",
) {}

/**
 * Routes answer `{ …fields }` on success or `{ errorTag }` when the
 * operation fails with a TYPED error — the test asserts the tag is in a
 * route-specific allowlist, which proves both the binding wiring and the
 * IAM grant. An untyped error crashes into a 500 instead.
 */
const errorTagged = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | { errorTag: string; errorMessage?: string }, never, R> =>
  effect.pipe(
    Effect.map((a): A | { errorTag: string; errorMessage?: string } => a),
    Effect.catch((e) =>
      Effect.succeed({
        errorTag: e._tag,
        errorMessage: (e as { message?: string }).message,
      }),
    ),
  );

// One binding per Incident Manager data-plane capability. The fixture is
// only deployable on an account onboarded to Incident Manager (the
// replication set is the account singleton and CreateReplicationSet was
// deprecated Nov 7, 2025), so the whole suite that deploys this is gated
// behind AWS_TEST_INCIDENT_MANAGER=1.
export default IncidentsTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // The account must already be onboarded (ReplicationSet deployed by the
    // test's phase-1 deploy under the same logical id).
    const replicationSet = yield* SSMIncidents.ReplicationSet("Incidents", {});

    const plan = yield* SSMIncidents.ResponsePlan("BindingsPlan", {
      displayName: "alchemy bindings fixture",
      incidentTemplate: {
        title: "alchemy bindings fixture incident",
        impact: 5,
        summary: "Started by the SSMIncidents Bindings test fixture",
      },
      // Reference the replication set so the engine orders plan creation
      // after Incident Manager is onboarded.
      tags: { fixture: "ssm-incidents-bindings", set: replicationSet.arn },
    });

    // Response-plan-scoped
    const startIncident = yield* SSMIncidents.StartIncident(plan);

    // Incident records
    const listIncidentRecords = yield* SSMIncidents.ListIncidentRecords();
    const getIncidentRecord = yield* SSMIncidents.GetIncidentRecord();
    const updateIncidentRecord = yield* SSMIncidents.UpdateIncidentRecord();
    const deleteIncidentRecord = yield* SSMIncidents.DeleteIncidentRecord();

    // Timeline events
    const createTimelineEvent = yield* SSMIncidents.CreateTimelineEvent();
    const getTimelineEvent = yield* SSMIncidents.GetTimelineEvent();
    const updateTimelineEvent = yield* SSMIncidents.UpdateTimelineEvent();
    const deleteTimelineEvent = yield* SSMIncidents.DeleteTimelineEvent();
    const listTimelineEvents = yield* SSMIncidents.ListTimelineEvents();

    // Related items
    const listRelatedItems = yield* SSMIncidents.ListRelatedItems();
    const updateRelatedItems = yield* SSMIncidents.UpdateRelatedItems();

    // Findings
    const listIncidentFindings = yield* SSMIncidents.ListIncidentFindings();
    const batchGetIncidentFindings =
      yield* SSMIncidents.BatchGetIncidentFindings();

    const bound = {
      startIncident,
      listIncidentRecords,
      getIncidentRecord,
      updateIncidentRecord,
      deleteIncidentRecord,
      createTimelineEvent,
      getTimelineEvent,
      updateTimelineEvent,
      deleteTimelineEvent,
      listTimelineEvents,
      listRelatedItems,
      updateRelatedItems,
      listIncidentFindings,
      batchGetIncidentFindings,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const arn = url.searchParams.get("arn") ?? "";
        const eventId = url.searchParams.get("eventId") ?? "";

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "POST" && pathname === "/start") {
          const { incidentRecordArn } = yield* startIncident({
            title: "alchemy bindings test incident",
            impact: 5,
          });
          return yield* HttpServerResponse.json({ incidentRecordArn });
        }

        if (request.method === "GET" && pathname === "/records") {
          const { incidentRecordSummaries } = yield* listIncidentRecords({});
          return yield* HttpServerResponse.json({
            count: incidentRecordSummaries.length,
            arns: incidentRecordSummaries.map((r) => r.arn),
          });
        }

        if (request.method === "GET" && pathname === "/record") {
          const { incidentRecord } = yield* getIncidentRecord({ arn });
          return yield* HttpServerResponse.json({
            title: incidentRecord.title,
            status: incidentRecord.status,
            impact: incidentRecord.impact,
          });
        }

        if (request.method === "POST" && pathname === "/resolve") {
          yield* updateIncidentRecord({ arn, status: "RESOLVED" });
          return yield* HttpServerResponse.json({ resolved: true });
        }

        if (request.method === "DELETE" && pathname === "/record") {
          yield* deleteIncidentRecord({ arn });
          return yield* HttpServerResponse.json({ deleted: true });
        }

        if (request.method === "POST" && pathname === "/timeline") {
          const created = yield* createTimelineEvent({
            incidentRecordArn: arn,
            eventTime: new Date(),
            eventType: "Custom Event",
            eventData: JSON.stringify({ note: "created by bindings test" }),
          });
          return yield* HttpServerResponse.json({
            eventId: created.eventId,
          });
        }

        if (request.method === "GET" && pathname === "/timeline") {
          const { event } = yield* getTimelineEvent({
            incidentRecordArn: arn,
            eventId,
          });
          return yield* HttpServerResponse.json({
            eventType: event.eventType,
            eventData: event.eventData,
          });
        }

        if (request.method === "POST" && pathname === "/timeline-update") {
          yield* updateTimelineEvent({
            incidentRecordArn: arn,
            eventId,
            eventData: JSON.stringify({ note: "updated by bindings test" }),
          });
          return yield* HttpServerResponse.json({ updated: true });
        }

        if (request.method === "DELETE" && pathname === "/timeline") {
          yield* deleteTimelineEvent({
            incidentRecordArn: arn,
            eventId,
          });
          return yield* HttpServerResponse.json({ deleted: true });
        }

        if (request.method === "GET" && pathname === "/timeline-events") {
          const { eventSummaries } = yield* listTimelineEvents({
            incidentRecordArn: arn,
          });
          return yield* HttpServerResponse.json({
            count: eventSummaries.length,
          });
        }

        if (request.method === "GET" && pathname === "/related") {
          const { relatedItems } = yield* listRelatedItems({
            incidentRecordArn: arn,
          });
          return yield* HttpServerResponse.json({
            count: relatedItems.length,
          });
        }

        if (request.method === "POST" && pathname === "/related") {
          const result = yield* errorTagged(
            updateRelatedItems({
              incidentRecordArn: arn,
              relatedItemsUpdate: {
                itemToAdd: {
                  title: "alchemy bindings test link",
                  identifier: {
                    type: "OTHER",
                    value: { url: "https://alchemy.run" },
                  },
                },
              },
            }).pipe(Effect.map(() => ({ added: true }))),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/findings") {
          const { findings } = yield* listIncidentFindings({
            incidentRecordArn: arn,
          });
          return yield* HttpServerResponse.json({
            count: findings.length,
            ids: findings.map((f) => f.id),
          });
        }

        if (request.method === "POST" && pathname === "/findings") {
          const result = yield* errorTagged(
            batchGetIncidentFindings({
              incidentRecordArn: arn,
              findingIds: [],
            }).pipe(Effect.map((r) => ({ count: r.findings.length }))),
          );
          return yield* HttpServerResponse.json(result);
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
        SSMIncidents.StartIncidentHttp,
        SSMIncidents.ListIncidentRecordsHttp,
        SSMIncidents.GetIncidentRecordHttp,
        SSMIncidents.UpdateIncidentRecordHttp,
        SSMIncidents.DeleteIncidentRecordHttp,
        SSMIncidents.CreateTimelineEventHttp,
        SSMIncidents.GetTimelineEventHttp,
        SSMIncidents.UpdateTimelineEventHttp,
        SSMIncidents.DeleteTimelineEventHttp,
        SSMIncidents.ListTimelineEventsHttp,
        SSMIncidents.ListRelatedItemsHttp,
        SSMIncidents.UpdateRelatedItemsHttp,
        SSMIncidents.ListIncidentFindingsHttp,
        SSMIncidents.BatchGetIncidentFindingsHttp,
      ),
    ),
  ),
);
