import * as EMRServerless from "@/AWS/EMRServerless";
import * as IAM from "@/AWS/IAM";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Well-formed (16 chars of [0-9a-z]) but nonexistent ids — probes must answer
// with the typed ResourceNotFoundException, which proves the IAM grant passed
// authorization AND the application id was injected from the binding.
const FAKE_JOB_RUN_ID = "00abcdefabcdef01";
const FAKE_SESSION_ID = "00abcdefabcdef01";

/** Deterministic names shared with the test for out-of-band verification. */
export const BINDINGS_APP_NAME = "alchemy-test-emrs-bind";
export const BINDINGS_ROLE_NAME = "alchemy-test-emrs-bind-role";

export class EmrServerlessTestFunction extends Lambda.Function<Lambda.Function>()(
  "EmrServerlessTestFunction",
) {}

export default EmrServerlessTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // The Spark application the bindings are bound to. Auto-start lets a job
    // submission start it; auto-stop reaps it after a minute idle. In the
    // CREATED/STOPPED state it costs nothing.
    const app = yield* EMRServerless.Application("BindingApp", {
      applicationName: BINDINGS_APP_NAME,
      releaseLabel: "emr-7.5.0",
      autoStartConfiguration: { enabled: true },
      autoStopConfiguration: { enabled: true, idleTimeout: "1 minute" },
      tags: { purpose: "alchemy-test" },
    });

    // The execution role submitted job runs assume (no data permissions —
    // the fixture cancels jobs immediately after submission).
    yield* IAM.Role("JobRole", {
      roleName: BINDINGS_ROLE_NAME,
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "emr-serverless.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
    });

    // Event source: subscribe the host to EMR Serverless job-run state
    // changes. The deploy proves the EventBridge rule + invoke permission.
    yield* EMRServerless.consumeJobRunEvents(
      { kinds: ["job-run-state-change"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `emr-serverless job ${event.detail.jobRunId} -> ${event.detail.state}`,
          ),
        ),
    );

    const startJobRun = yield* EMRServerless.StartJobRun(app);
    const getJobRun = yield* EMRServerless.GetJobRun(app);
    const cancelJobRun = yield* EMRServerless.CancelJobRun(app);
    const listJobRuns = yield* EMRServerless.ListJobRuns(app);
    const listJobRunAttempts = yield* EMRServerless.ListJobRunAttempts(app);
    const getDashboardForJobRun =
      yield* EMRServerless.GetDashboardForJobRun(app);
    const getResourceDashboard = yield* EMRServerless.GetResourceDashboard(app);
    const startApplication = yield* EMRServerless.StartApplication(app);
    const stopApplication = yield* EMRServerless.StopApplication(app);
    const startSession = yield* EMRServerless.StartSession(app);
    const getSession = yield* EMRServerless.GetSession(app);
    const terminateSession = yield* EMRServerless.TerminateSession(app);
    const listSessions = yield* EMRServerless.ListSessions(app);
    const getSessionEndpoint = yield* EMRServerless.GetSessionEndpoint(app);

    const bound = {
      startJobRun,
      getJobRun,
      cancelJobRun,
      listJobRuns,
      listJobRunAttempts,
      getDashboardForJobRun,
      getResourceDashboard,
      startApplication,
      stopApplication,
      startSession,
      getSession,
      terminateSession,
      listSessions,
      getSessionEndpoint,
    };

    // Run an operation and answer with its typed outcome: `ok` on success,
    // the error's `_tag` otherwise. Probes assert the tag — a typed
    // service error (not AccessDeniedException) proves the IAM grant and
    // the injected application id both work.
    const probe = <A, E extends { _tag: string }>(
      effect: Effect.Effect<A, E>,
    ) =>
      effect.pipe(
        Effect.map(() => ({ tag: "ok", detail: "" }) as const),
        Effect.catch((error) =>
          Effect.succeed({ tag: error._tag, detail: String(error) } as const),
        ),
        Effect.flatMap((outcome) => HttpServerResponse.json(outcome)),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({ bound: Object.keys(bound) });
        }

        // Real reads: application id injected from the binding.
        if (request.method === "GET" && pathname === "/jobruns") {
          const { jobRuns } = yield* listJobRuns().pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            ids: jobRuns.map((run) => run.id),
          });
        }
        if (request.method === "GET" && pathname === "/sessions") {
          return yield* probe(listSessions());
        }

        // Typed not-found probes on nonexistent sub-resources.
        if (request.method === "GET" && pathname === "/jobrun") {
          return yield* probe(getJobRun({ jobRunId: FAKE_JOB_RUN_ID }));
        }
        if (request.method === "GET" && pathname === "/jobrun-dashboard") {
          return yield* probe(
            getDashboardForJobRun({ jobRunId: FAKE_JOB_RUN_ID }),
          );
        }
        if (request.method === "GET" && pathname === "/jobrun-attempts") {
          return yield* probe(
            listJobRunAttempts({ jobRunId: FAKE_JOB_RUN_ID }),
          );
        }
        if (request.method === "POST" && pathname === "/jobrun-cancel-fake") {
          return yield* probe(cancelJobRun({ jobRunId: FAKE_JOB_RUN_ID }));
        }
        if (request.method === "GET" && pathname === "/session") {
          return yield* probe(getSession({ sessionId: FAKE_SESSION_ID }));
        }
        if (request.method === "GET" && pathname === "/session-endpoint") {
          return yield* probe(
            getSessionEndpoint({ sessionId: FAKE_SESSION_ID }),
          );
        }
        if (request.method === "POST" && pathname === "/session-terminate") {
          return yield* probe(terminateSession({ sessionId: FAKE_SESSION_ID }));
        }
        if (request.method === "GET" && pathname === "/resource-dashboard") {
          return yield* probe(
            getResourceDashboard({
              resourceId: FAKE_JOB_RUN_ID,
              resourceType: "SPARK_DRIVER",
            }),
          );
        }
        // startSession is registration-covered; the runtime probe proves the
        // grant + PassRole path end-to-end (the fixture application has no
        // interactive configuration, so the service answers with a typed
        // validation error rather than starting a billable session).
        if (request.method === "POST" && pathname === "/session-start") {
          const roleArn = url.searchParams.get("roleArn");
          if (!roleArn) {
            return yield* HttpServerResponse.json(
              { error: "roleArn query parameter required" },
              { status: 400 },
            );
          }
          return yield* probe(startSession({ executionRoleArn: roleArn }));
        }

        // Application control.
        if (request.method === "POST" && pathname === "/app-start") {
          return yield* probe(startApplication());
        }
        if (request.method === "POST" && pathname === "/app-stop") {
          return yield* probe(stopApplication());
        }

        // Real job-run round trip: submit (SparkPi from the EMR image — no
        // S3 assets), then the test cancels it immediately.
        if (request.method === "POST" && pathname === "/jobrun-run") {
          const roleArn = url.searchParams.get("roleArn");
          if (!roleArn) {
            return yield* HttpServerResponse.json(
              { error: "roleArn query parameter required" },
              { status: 400 },
            );
          }
          const started = yield* startJobRun({
            executionRoleArn: roleArn,
            jobDriver: {
              sparkSubmit: {
                entryPoint:
                  "local:///usr/lib/spark/examples/src/main/python/pi.py",
              },
            },
            executionTimeoutMinutes: 10,
          }).pipe(Effect.orDie);
          return yield* HttpServerResponse.json({
            jobRunId: started.jobRunId,
            arn: started.arn,
          });
        }
        if (request.method === "POST" && pathname === "/jobrun-cancel") {
          const id = url.searchParams.get("id");
          if (!id) {
            return yield* HttpServerResponse.json(
              { error: "id query parameter required" },
              { status: 400 },
            );
          }
          const cancelled = yield* cancelJobRun({ jobRunId: id }).pipe(
            Effect.orDie,
          );
          return yield* HttpServerResponse.json({
            jobRunId: cancelled.jobRunId,
          });
        }
        if (request.method === "GET" && pathname === "/jobrun-detail") {
          const id = url.searchParams.get("id");
          if (!id) {
            return yield* HttpServerResponse.json(
              { error: "id query parameter required" },
              { status: 400 },
            );
          }
          const { jobRun } = yield* getJobRun({ jobRunId: id }).pipe(
            Effect.orDie,
          );
          return yield* HttpServerResponse.json({
            jobRunId: jobRun.jobRunId,
            state: jobRun.state,
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
        EMRServerless.StartJobRunHttp,
        EMRServerless.GetJobRunHttp,
        EMRServerless.CancelJobRunHttp,
        EMRServerless.ListJobRunsHttp,
        EMRServerless.ListJobRunAttemptsHttp,
        EMRServerless.GetDashboardForJobRunHttp,
        EMRServerless.GetResourceDashboardHttp,
        EMRServerless.StartApplicationHttp,
        EMRServerless.StopApplicationHttp,
        EMRServerless.StartSessionHttp,
        EMRServerless.GetSessionHttp,
        EMRServerless.TerminateSessionHttp,
        EMRServerless.ListSessionsHttp,
        EMRServerless.GetSessionEndpointHttp,
      ),
    ),
  ),
);
