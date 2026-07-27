import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import * as Test from "@/Test/Alchemy";
import * as incidents from "@distilled.cloud/aws/ssm-incidents";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import IncidentsTestFunctionLive, { IncidentsTestFunction } from "./handler";

const { test } = Test.make({ providers: AWS.providers() });

// Incident records are runtime entities: their ARNs embed the response-plan
// name plus a UUID minted by StartIncident. These well-formed-but-nonexistent
// ARNs exercise every binding operation's TYPED error union (or its
// empty-list/idempotent success) without needing Incident Manager onboarding
// — which CreateReplicationSet's deprecation (Nov 7, 2025) makes impossible
// for accounts that were not already onboarded.
const fakeArns = Effect.gen(function* () {
  const { accountId } = yield* AWSEnvironment.current;
  return {
    planArn: `arn:aws:ssm-incidents::${accountId}:response-plan/alchemy-nonexistent-probe`,
    recordArn: `arn:aws:ssm-incidents::${accountId}:incident-record/alchemy-nonexistent-probe/11111111-1111-1111-1111-111111111111`,
  };
});

// -- Ungated typed-error probes -----------------------------------------------
// Prove that every operation the new bindings wrap either succeeds with an
// empty result or fails with the typed tag alchemy code relies on. These run
// in every CI pass at near-zero cost, unlike the gated lifecycle below.

test.provider(
  "startIncident on a nonexistent response plan fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const { planArn } = yield* fakeArns;
      const error = yield* Effect.flip(
        incidents.startIncident({ responsePlanArn: planArn }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider("listIncidentRecords answers with a summary list", () =>
  Effect.gen(function* () {
    const listed = yield* incidents.listIncidentRecords({});
    expect(Array.isArray(listed.incidentRecordSummaries)).toBe(true);
  }),
);

test.provider(
  "getIncidentRecord on a nonexistent record fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const { recordArn } = yield* fakeArns;
      const error = yield* Effect.flip(
        incidents.getIncidentRecord({ arn: recordArn }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "updateIncidentRecord on a nonexistent record fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const { recordArn } = yield* fakeArns;
      const error = yield* Effect.flip(
        incidents.updateIncidentRecord({ arn: recordArn, title: "probe" }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "deleteIncidentRecord on a nonexistent record is idempotent",
  () =>
    Effect.gen(function* () {
      const { recordArn } = yield* fakeArns;
      const result = yield* Effect.result(
        incidents.deleteIncidentRecord({ arn: recordArn }),
      );
      expect(Result.isSuccess(result)).toBe(true);
    }),
);

test.provider(
  "createTimelineEvent on a nonexistent record fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const { recordArn } = yield* fakeArns;
      const error = yield* Effect.flip(
        incidents.createTimelineEvent({
          incidentRecordArn: recordArn,
          eventTime: new Date(),
          eventType: "Custom Event",
          eventData: JSON.stringify({ note: "probe" }),
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "getTimelineEvent on a nonexistent record fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const { recordArn } = yield* fakeArns;
      const error = yield* Effect.flip(
        incidents.getTimelineEvent({
          incidentRecordArn: recordArn,
          eventId: "11111111-1111-1111-1111-111111111111",
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "updateTimelineEvent on a nonexistent record fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const { recordArn } = yield* fakeArns;
      const error = yield* Effect.flip(
        incidents.updateTimelineEvent({
          incidentRecordArn: recordArn,
          eventId: "11111111-1111-1111-1111-111111111111",
          eventData: JSON.stringify({ note: "probe" }),
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider("deleteTimelineEvent on a nonexistent record is idempotent", () =>
  Effect.gen(function* () {
    const { recordArn } = yield* fakeArns;
    const result = yield* Effect.result(
      incidents.deleteTimelineEvent({
        incidentRecordArn: recordArn,
        eventId: "11111111-1111-1111-1111-111111111111",
      }),
    );
    expect(Result.isSuccess(result)).toBe(true);
  }),
);

test.provider(
  "listTimelineEvents on a nonexistent record returns an empty list",
  () =>
    Effect.gen(function* () {
      const { recordArn } = yield* fakeArns;
      const listed = yield* incidents.listTimelineEvents({
        incidentRecordArn: recordArn,
      });
      expect(listed.eventSummaries).toHaveLength(0);
    }),
);

test.provider(
  "listRelatedItems on a nonexistent record returns an empty list",
  () =>
    Effect.gen(function* () {
      const { recordArn } = yield* fakeArns;
      const listed = yield* incidents.listRelatedItems({
        incidentRecordArn: recordArn,
      });
      expect(listed.relatedItems).toHaveLength(0);
    }),
);

test.provider(
  "updateRelatedItems on a nonexistent record fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const { recordArn } = yield* fakeArns;
      const error = yield* Effect.flip(
        incidents.updateRelatedItems({
          incidentRecordArn: recordArn,
          relatedItemsUpdate: {
            itemToAdd: {
              title: "probe",
              identifier: {
                type: "OTHER",
                value: { url: "https://alchemy.run" },
              },
            },
          },
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "listIncidentFindings on a nonexistent record fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const { recordArn } = yield* fakeArns;
      const error = yield* Effect.flip(
        incidents.listIncidentFindings({ incidentRecordArn: recordArn }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

test.provider(
  "batchGetIncidentFindings on a nonexistent record fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const { recordArn } = yield* fakeArns;
      const error = yield* Effect.flip(
        incidents.batchGetIncidentFindings({
          incidentRecordArn: recordArn,
          findingIds: ["11111111-1111-1111-1111-111111111111"],
        }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

// -- Gated end-to-end lifecycle -----------------------------------------------
// Deploys the Lambda fixture (replication set + response plan + all 14
// bindings) and drives the incident data plane over HTTP. Gated behind
// AWS_TEST_INCIDENT_MANAGER=1 AND a grandfathered account: AWS deprecated
// CreateReplicationSet on Nov 7, 2025, so accounts not already onboarded to
// Incident Manager can no longer onboard (this test then degrades to the
// typed deprecation probe). It also never touches a replication set it did
// not create (capture-and-restore safety).

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The Lambda fixture occasionally answers a transient 5xx (cold re-init, IAM
// propagation on the freshly attached policy). Retry only 5xx; a genuine 4xx
// or assertion failure surfaces immediately.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e): boolean => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
  );

const json = (request: HttpClientRequest.HttpClientRequest) =>
  send(request).pipe(Effect.flatMap((r) => r.json));

test.provider.skipIf(!process.env.AWS_TEST_INCIDENT_MANAGER)(
  "lifecycle: deployed Lambda drives the incident data plane end-to-end",
  (stack) =>
    Effect.gen(function* () {
      // Never take over a replication set this test did not create.
      const preexisting = yield* incidents.listReplicationSets({});
      if (preexisting.replicationSetArns.length > 0) {
        yield* Effect.logInfo(
          `Incident Manager already onboarded (${preexisting.replicationSetArns[0]}) — skipping destructive bindings lifecycle`,
        );
        return;
      }

      // Probe the deprecated onboarding path; only a grandfathered account
      // can run the lifecycle below.
      const { region } = yield* AWSEnvironment.current;
      const onboarded = yield* Effect.result(
        incidents.createReplicationSet({ regions: { [region]: {} } }),
      );
      if (Result.isFailure(onboarded)) {
        expect(onboarded.failure._tag).toBe("UnsupportedOperationException");
        yield* Effect.logInfo(
          "CreateReplicationSet is deprecated and this account is not onboarded — skipping bindings lifecycle",
        );
        return;
      }
      // The probe onboarded the account (untagged set) — remove it so the
      // alchemy-managed deploy below starts from a clean slate.
      const probeArn = onboarded.success.arn;
      yield* incidents.getReplicationSet({ arn: probeArn }).pipe(
        Effect.map((r) => r.replicationSet.status),
        Effect.repeat({
          schedule: Schedule.max([
            Schedule.fixed("5 seconds"),
            Schedule.recurs(60),
          ]),
          until: (status): boolean =>
            status !== "CREATING" && status !== "UPDATING",
        }),
      );
      yield* incidents.deleteReplicationSet({ arn: probeArn });
      yield* incidents.getReplicationSet({ arn: probeArn }).pipe(
        Effect.map((r) => r.replicationSet.status),
        Effect.catchTag("ResourceNotFoundException", () =>
          Effect.succeed("GONE" as const),
        ),
        Effect.repeat({
          schedule: Schedule.max([
            Schedule.fixed("5 seconds"),
            Schedule.recurs(60),
          ]),
          until: (status): boolean => status === "GONE",
        }),
      );

      yield* stack.destroy();

      // Phase 1 — onboard Incident Manager (the fixture's response plan
      // needs an ACTIVE replication set).
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AWS.SSMIncidents.ReplicationSet("Incidents", {});
        }),
      );

      // Phase 2 — deploy the fixture Lambda + response plan + bindings.
      const attrs = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* IncidentsTestFunction;
        }).pipe(Effect.provide(IncidentsTestFunctionLive)),
      );
      expect(attrs.functionUrl).toBeTruthy();
      const baseUrl = attrs.functionUrl!.replace(/\/+$/, "");

      // Readiness: fresh function URLs take a while to start serving 200s.
      yield* HttpClient.get(`${baseUrl}/bindings`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`not ready: ${response.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.fixed("2 seconds"),
            Schedule.recurs(75),
          ]),
        }),
      );

      const bindings = (yield* json(
        HttpClientRequest.get(`${baseUrl}/bindings`),
      )) as { bound: string[] };
      expect(bindings.bound).toHaveLength(14);

      // StartIncident
      const started = (yield* json(
        HttpClientRequest.post(`${baseUrl}/start`),
      )) as { incidentRecordArn: string };
      expect(started.incidentRecordArn).toContain(":incident-record/");
      const arn = encodeURIComponent(started.incidentRecordArn);

      // ListIncidentRecords — poll until the new record is listed.
      yield* json(HttpClientRequest.get(`${baseUrl}/records`)).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (r): boolean =>
            (r as { arns: string[] }).arns.includes(started.incidentRecordArn),
          times: 20,
        }),
      );

      // GetIncidentRecord
      const record = (yield* json(
        HttpClientRequest.get(`${baseUrl}/record?arn=${arn}`),
      )) as { title: string; status: string };
      expect(record.title).toBe("alchemy bindings test incident");
      expect(record.status).toBe("OPEN");

      // CreateTimelineEvent / GetTimelineEvent / UpdateTimelineEvent /
      // ListTimelineEvents
      const created = (yield* json(
        HttpClientRequest.post(`${baseUrl}/timeline?arn=${arn}`),
      )) as { eventId: string };
      expect(created.eventId).toBeTruthy();
      const eventId = encodeURIComponent(created.eventId);
      const event = (yield* json(
        HttpClientRequest.get(
          `${baseUrl}/timeline?arn=${arn}&eventId=${eventId}`,
        ),
      )) as { eventType: string };
      expect(event.eventType).toBe("Custom Event");
      yield* json(
        HttpClientRequest.post(
          `${baseUrl}/timeline-update?arn=${arn}&eventId=${eventId}`,
        ),
      );
      const events = (yield* json(
        HttpClientRequest.get(`${baseUrl}/timeline-events?arn=${arn}`),
      )) as { count: number };
      expect(events.count).toBeGreaterThanOrEqual(1);

      // Related items + findings
      yield* json(HttpClientRequest.post(`${baseUrl}/related?arn=${arn}`));
      const related = (yield* json(
        HttpClientRequest.get(`${baseUrl}/related?arn=${arn}`),
      )) as { count: number };
      expect(related.count).toBeGreaterThanOrEqual(1);
      const findings = (yield* json(
        HttpClientRequest.get(`${baseUrl}/findings?arn=${arn}`),
      )) as { count: number };
      expect(findings.count).toBeGreaterThanOrEqual(0);

      // Resolve, clean up the timeline event and the record.
      yield* json(HttpClientRequest.post(`${baseUrl}/resolve?arn=${arn}`));
      yield* json(
        HttpClientRequest.delete(
          `${baseUrl}/timeline?arn=${arn}&eventId=${eventId}`,
        ),
      );
      yield* json(HttpClientRequest.delete(`${baseUrl}/record?arn=${arn}`));

      // Destroy — response plan and Lambda first, then offboarding.
      yield* stack.destroy();
      const after = yield* incidents.listReplicationSets({});
      expect(after.replicationSetArns).toHaveLength(0);
    }),
  // onboarding (~1-2 min) + Lambda deploy + offboarding (~1-2 min).
  { timeout: 900_000 },
);
