import * as Amplify from "@/AWS/Amplify";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class AmplifyTestFunction extends Lambda.Function<Lambda.Function>()(
  "AmplifyTestFunction",
) {}

export default AmplifyTestFunction.make(
  {
    main,
    url: true,
    // GenerateAccessLogs can take longer than Lambda's 3s default while
    // Amplify prepares the pre-signed archive URL. Keep the invocation alive
    // long enough for the handler to return either the typed service result or
    // its structured diagnostic response instead of a raw Function URL 502.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const app = yield* Amplify.App("BindingsTestApp", {
      description: "Amplify bindings fixture (manual deploys, no repo)",
      platform: "WEB",
    });

    const AppId = yield* app.appId;
    const DefaultDomain = yield* app.defaultDomain;

    const createDeployment = yield* Amplify.CreateDeployment(app);
    const startDeployment = yield* Amplify.StartDeployment(app);
    const startJob = yield* Amplify.StartJob(app);
    const stopJob = yield* Amplify.StopJob(app);
    const getJob = yield* Amplify.GetJob(app);
    const listJobs = yield* Amplify.ListJobs(app);
    const deleteJob = yield* Amplify.DeleteJob(app);
    const listArtifacts = yield* Amplify.ListArtifacts(app);
    const getArtifactUrl = yield* Amplify.GetArtifactUrl(app);
    const generateAccessLogs = yield* Amplify.GenerateAccessLogs(app);

    // Event source: creates the EventBridge rule + Lambda permission at
    // deploy; at runtime, delivered events are recorded in instance memory
    // (best-effort — a different instance may serve /events) and exposed on
    // the /events route.
    const deploymentEvents: Amplify.DeploymentStatusChangeDetail[] = [];
    yield* Amplify.consumeDeploymentStatusChanges(
      { id: "BindingsTestApp" },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.sync(() => {
            deploymentEvents.push(event.detail);
          }),
        ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/meta") {
          return yield* HttpServerResponse.json({
            appId: yield* AppId,
            defaultDomain: yield* DefaultDomain,
          });
        }

        if (request.method === "POST" && pathname === "/deployments") {
          const body = (yield* request.json) as { branchName: string };
          const result = yield* createDeployment({
            branchName: body.branchName,
          });
          return yield* HttpServerResponse.json({
            jobId: result.jobId,
            zipUploadUrl: result.zipUploadUrl,
          });
        }

        if (request.method === "POST" && pathname === "/deployments/start") {
          const body = (yield* request.json) as {
            branchName: string;
            jobId?: string;
            sourceUrl?: string;
          };
          const result = yield* startDeployment({
            branchName: body.branchName,
            jobId: body.jobId,
            sourceUrl: body.sourceUrl,
          });
          return yield* HttpServerResponse.json({
            jobSummary: result.jobSummary,
          });
        }

        if (request.method === "GET" && pathname === "/job") {
          const branchName = url.searchParams.get("branchName")!;
          const jobId = url.searchParams.get("jobId")!;
          const result = yield* getJob({ branchName, jobId });
          return yield* HttpServerResponse.json({
            status: result.job.summary.status,
            stepCount: result.job.steps.length,
          });
        }

        if (request.method === "GET" && pathname === "/jobs") {
          const branchName = url.searchParams.get("branchName")!;
          const result = yield* listJobs({ branchName });
          return yield* HttpServerResponse.json({
            jobSummaries: result.jobSummaries,
          });
        }

        if (request.method === "POST" && pathname === "/jobs/start") {
          const body = (yield* request.json) as {
            branchName: string;
            jobType: string;
          };
          // A manual-deploy branch has no connected repo, so RELEASE jobs are
          // rejected by the service — surface the typed tag instead of dying
          // so the test can assert the binding + IAM wiring end-to-end.
          const result = yield* startJob({
            branchName: body.branchName,
            jobType: body.jobType as "RELEASE",
          }).pipe(
            Effect.map((r) => ({
              started: true as const,
              jobId: r.jobSummary.jobId,
            })),
            Effect.catchTag(["BadRequestException", "NotFoundException"], (e) =>
              Effect.succeed({ started: false as const, errorTag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "POST" && pathname === "/jobs/stop") {
          const body = (yield* request.json) as {
            branchName: string;
            jobId: string;
          };
          // Stopping a job that already settled is a BadRequest/NotFound —
          // report the tag rather than 500 so the race stays assertable.
          const result = yield* stopJob({
            branchName: body.branchName,
            jobId: body.jobId,
          }).pipe(
            Effect.map((r) => ({
              stopped: true as const,
              status: r.jobSummary.status,
            })),
            Effect.catchTag(
              [
                "BadRequestException",
                "NotFoundException",
                "LimitExceededException",
              ],
              (e) =>
                Effect.succeed({ stopped: false as const, errorTag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "POST" && pathname === "/jobs/delete") {
          const body = (yield* request.json) as {
            branchName: string;
            jobId: string;
          };
          const result = yield* deleteJob({
            branchName: body.branchName,
            jobId: body.jobId,
          }).pipe(
            Effect.map((r) => ({
              deleted: true as const,
              status: r.jobSummary.status,
            })),
            Effect.catchTag(["BadRequestException", "NotFoundException"], (e) =>
              Effect.succeed({
                deleted: false as const,
                errorTag: e._tag,
                message: e.message,
              }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/artifacts") {
          const branchName = url.searchParams.get("branchName")!;
          const jobId = url.searchParams.get("jobId")!;
          const result = yield* listArtifacts({ branchName, jobId });
          return yield* HttpServerResponse.json({
            artifacts: result.artifacts,
          });
        }

        if (request.method === "GET" && pathname === "/artifact-url") {
          const artifactId = url.searchParams.get("artifactId")!;
          const result = yield* getArtifactUrl({ artifactId });
          return yield* HttpServerResponse.json({
            artifactUrl: result.artifactUrl,
          });
        }

        if (request.method === "POST" && pathname === "/access-logs") {
          const body = (yield* request.json) as { domainName: string };
          const result = yield* generateAccessLogs({
            domainName: body.domainName,
          }).pipe(
            Effect.map((r) => ({ ok: true as const, logUrl: r.logUrl })),
            Effect.catchTag(["BadRequestException", "NotFoundException"], (e) =>
              Effect.succeed({
                ok: false as const,
                errorTag: e._tag,
                message: e.message,
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.succeed({
                ok: false as const,
                errorTag: "UnexpectedCause",
                cause: String(cause),
              }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/events") {
          return yield* HttpServerResponse.json({ events: deploymentEvents });
        }

        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(
        // Surface unexpected failures in the response body — the fixture
        // Lambda has no CloudWatch logs permission, so the HTTP body is the
        // only diagnostic channel the test can observe.
        Effect.catchCause((cause) =>
          HttpServerResponse.json(
            { error: "unhandled", cause: String(cause) },
            { status: 500 },
          ),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.EventSource,
        Amplify.CreateDeploymentHttp,
        Amplify.StartDeploymentHttp,
        Amplify.StartJobHttp,
        Amplify.StopJobHttp,
        Amplify.GetJobHttp,
        Amplify.ListJobsHttp,
        Amplify.DeleteJobHttp,
        Amplify.ListArtifactsHttp,
        Amplify.GetArtifactUrlHttp,
        Amplify.GenerateAccessLogsHttp,
      ),
    ),
  ),
);
