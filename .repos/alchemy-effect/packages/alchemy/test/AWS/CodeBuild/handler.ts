import * as CodeBuild from "@/AWS/CodeBuild";
import * as IAM from "@/AWS/IAM";
import * as Lambda from "@/AWS/Lambda";
import * as Logs from "@/AWS/Logs";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export const FIXTURE_PROJECT_NAME = "alchemy-test-codebuild-bindings";
export const FIXTURE_REPORT_GROUP_NAME =
  "alchemy-test-codebuild-bindings-reports";

const buildspec = [
  "version: 0.2",
  "phases:",
  "  build:",
  "    commands:",
  "      - echo Hello from CodeBuild bindings fixture",
].join("\n");

export class CodeBuildTestFunction extends Lambda.Function<Lambda.Function>()(
  "CodeBuildTestFunction",
) {}

/**
 * Every route answers `{ …fields }` on success or `{ errorTag }` when the
 * operation fails with a TYPED error — the test asserts the tag is a typed,
 * non-authorization tag, which proves both the binding wiring and the IAM
 * grant. An untyped error crashes into a 500 instead.
 */
const errorTagged = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | { errorTag: string }, never, R> =>
  effect.pipe(
    Effect.map((a): A | { errorTag: string } => a),
    Effect.catch((e) => Effect.succeed({ errorTag: e._tag })),
  );

export default CodeBuildTestFunction.make(
  {
    main,
    url: true,
    // Build start/stop fan out SDK calls — AWS's 3s default intermittently
    // times out under cold starts.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const role = yield* IAM.Role("CodeBuildBindingsRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "codebuild.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      inlinePolicies: {
        Logs: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
              Resource: ["*"],
            },
          ],
        },
      },
    });

    // Own CodeBuild's deterministic log destination in the stack instead of
    // allowing the service to create its implicit `/aws/codebuild/...` group.
    // Project depends on this output, so destroy deletes the Project before
    // the LogGroup; removing CreateLogGroup above prevents a late-finishing
    // build from recreating it after the observed LogGroup deletion.
    const buildLogs = yield* Logs.LogGroup("BindingsBuildLogs", {
      logGroupName: `/aws/codebuild/${FIXTURE_PROJECT_NAME}`,
      retention: "1 day",
    });

    const project = yield* CodeBuild.Project("BindingsProject", {
      projectName: FIXTURE_PROJECT_NAME,
      serviceRole: role.roleArn,
      source: { type: "NO_SOURCE", buildspec },
      environment: {
        image: "aws/codebuild/amazonlinux2-x86_64-standard:5.0",
        computeType: "BUILD_GENERAL1_SMALL",
      },
      logsConfig: {
        cloudWatchLogs: {
          status: "ENABLED",
          groupName: buildLogs.logGroupName,
        },
        s3Logs: { status: "DISABLED" },
      },
    });

    const reportGroup = yield* CodeBuild.ReportGroup("BindingsReports", {
      reportGroupName: FIXTURE_REPORT_GROUP_NAME,
      type: "TEST",
    });

    // Build plane
    const startBuild = yield* CodeBuild.StartBuild(project);
    const batchGetBuilds = yield* CodeBuild.BatchGetBuilds(project);
    const stopBuild = yield* CodeBuild.StopBuild(project);
    const retryBuild = yield* CodeBuild.RetryBuild(project);
    const listBuilds = yield* CodeBuild.ListBuildsForProject(project);
    const batchDeleteBuilds = yield* CodeBuild.BatchDeleteBuilds(project);
    const invalidateProjectCache =
      yield* CodeBuild.InvalidateProjectCache(project);
    // Batch-build plane
    const startBuildBatch = yield* CodeBuild.StartBuildBatch(project);
    const stopBuildBatch = yield* CodeBuild.StopBuildBatch(project);
    const retryBuildBatch = yield* CodeBuild.RetryBuildBatch(project);
    const batchGetBuildBatches = yield* CodeBuild.BatchGetBuildBatches(project);
    const listBuildBatches =
      yield* CodeBuild.ListBuildBatchesForProject(project);
    const deleteBuildBatch = yield* CodeBuild.DeleteBuildBatch(project);
    // Sandbox plane
    const startSandbox = yield* CodeBuild.StartSandbox(project);
    const stopSandbox = yield* CodeBuild.StopSandbox(project);
    const batchGetSandboxes = yield* CodeBuild.BatchGetSandboxes(project);
    const listSandboxes = yield* CodeBuild.ListSandboxesForProject(project);
    const startCommandExecution =
      yield* CodeBuild.StartCommandExecution(project);
    const batchGetCommandExecutions =
      yield* CodeBuild.BatchGetCommandExecutions(project);
    const listCommandExecutions =
      yield* CodeBuild.ListCommandExecutionsForSandbox(project);
    // Report plane
    const listReports = yield* CodeBuild.ListReportsForReportGroup(reportGroup);
    const batchGetReports = yield* CodeBuild.BatchGetReports(reportGroup);
    const describeTestCases = yield* CodeBuild.DescribeTestCases(reportGroup);
    const describeCodeCoverages =
      yield* CodeBuild.DescribeCodeCoverages(reportGroup);
    const getReportGroupTrend =
      yield* CodeBuild.GetReportGroupTrend(reportGroup);
    const deleteReport = yield* CodeBuild.DeleteReport(reportGroup);

    // Deploy-time: creates the EventBridge rule (default bus, source
    // aws.codebuild) targeting this Function. Runtime firing rides on the
    // real builds the suite starts; the test verifies the rule deploys.
    yield* CodeBuild.consumeBuildEvents({ kinds: ["state"] }, (events) =>
      Stream.runForEach(events, (event) =>
        Effect.log(
          `codebuild event: ${event.detail["build-id"]} -> ${event.detail["build-status"]}`,
        ),
      ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const route = `${request.method} ${pathname}`;
        const param = (name: string) => url.searchParams.get(name)!;

        switch (route) {
          // ---- build plane ----
          case "POST /build/start": {
            const result = yield* errorTagged(startBuild());
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { buildId: result.build?.id },
            );
          }
          case "GET /build/get": {
            const result = yield* errorTagged(
              batchGetBuilds({ ids: [param("id")] }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { status: result.builds?.[0]?.buildStatus },
            );
          }
          case "GET /build/list": {
            const result = yield* errorTagged(listBuilds());
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { ids: result.ids ?? [] },
            );
          }
          case "POST /build/stop": {
            const body = (yield* request.json) as unknown as { id: string };
            const result = yield* errorTagged(stopBuild({ id: body.id }));
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { status: result.build?.buildStatus },
            );
          }
          case "POST /build/retry": {
            const body = (yield* request.json) as unknown as { id: string };
            const result = yield* errorTagged(retryBuild({ id: body.id }));
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { buildId: result.build?.id },
            );
          }
          case "POST /build/delete": {
            const body = (yield* request.json) as unknown as {
              ids: string[];
            };
            const result = yield* errorTagged(
              batchDeleteBuilds({ ids: body.ids }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : {
                    deleted: result.buildsDeleted ?? [],
                    notDeleted: (result.buildsNotDeleted ?? []).map(
                      (b) => b.id,
                    ),
                  },
            );
          }
          case "POST /cache/invalidate": {
            const result = yield* errorTagged(invalidateProjectCache());
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { ok: true },
            );
          }

          // ---- batch-build plane ----
          case "POST /batch/start": {
            const result = yield* errorTagged(startBuildBatch());
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { batchId: result.buildBatch?.id },
            );
          }
          case "POST /batch/stop": {
            const body = (yield* request.json) as unknown as { id: string };
            const result = yield* errorTagged(stopBuildBatch({ id: body.id }));
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { ok: true },
            );
          }
          case "POST /batch/retry": {
            const body = (yield* request.json) as unknown as { id: string };
            const result = yield* errorTagged(retryBuildBatch({ id: body.id }));
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { ok: true },
            );
          }
          case "GET /batch/get": {
            const result = yield* errorTagged(
              batchGetBuildBatches({ ids: [param("id")] }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : {
                    found: (result.buildBatches ?? []).map((b) => b.id),
                    notFound: result.buildBatchesNotFound ?? [],
                  },
            );
          }
          case "GET /batch/list": {
            const result = yield* errorTagged(listBuildBatches());
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { ids: result.ids ?? [] },
            );
          }
          case "POST /batch/delete": {
            const body = (yield* request.json) as unknown as { id: string };
            const result = yield* errorTagged(
              deleteBuildBatch({ id: body.id }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { ok: true },
            );
          }

          // ---- sandbox plane ----
          case "POST /sandbox/start": {
            const result = yield* errorTagged(startSandbox());
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { sandboxId: result.sandbox?.id },
            );
          }
          case "POST /sandbox/stop": {
            const body = (yield* request.json) as unknown as { id: string };
            const result = yield* errorTagged(stopSandbox({ id: body.id }));
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { ok: true },
            );
          }
          case "GET /sandbox/get": {
            const result = yield* errorTagged(
              batchGetSandboxes({ ids: [param("id")] }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : {
                    statuses: (result.sandboxes ?? []).map((s) => s.status),
                  },
            );
          }
          case "GET /sandbox/list": {
            const result = yield* errorTagged(listSandboxes());
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { ids: result.ids ?? [] },
            );
          }
          case "POST /sandbox/command": {
            const body = (yield* request.json) as unknown as {
              sandboxId: string;
              command: string;
            };
            const result = yield* errorTagged(
              startCommandExecution({
                sandboxId: body.sandboxId,
                command: body.command,
              }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { commandId: result.commandExecution?.id },
            );
          }
          case "GET /sandbox/command-get": {
            const result = yield* errorTagged(
              batchGetCommandExecutions({
                sandboxId: param("sandboxId"),
                commandExecutionIds: [param("commandId")],
              }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : {
                    statuses: (result.commandExecutions ?? []).map(
                      (c) => c.status,
                    ),
                  },
            );
          }
          case "GET /sandbox/commands": {
            const result = yield* errorTagged(
              listCommandExecutions({ sandboxId: param("sandboxId") }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : {
                    count: (result.commandExecutions ?? []).length,
                  },
            );
          }

          // ---- report plane ----
          case "GET /reports/list": {
            const result = yield* errorTagged(listReports());
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { reports: result.reports ?? [] },
            );
          }
          case "GET /reports/get": {
            const result = yield* errorTagged(
              batchGetReports({ reportArns: [param("arn")] }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : {
                    found: (result.reports ?? []).map((r) => r.arn),
                    notFound: result.reportsNotFound ?? [],
                  },
            );
          }
          case "GET /reports/test-cases": {
            const result = yield* errorTagged(
              describeTestCases({ reportArn: param("arn") }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { count: (result.testCases ?? []).length },
            );
          }
          case "GET /reports/coverage": {
            const result = yield* errorTagged(
              describeCodeCoverages({ reportArn: param("arn") }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { count: (result.codeCoverages ?? []).length },
            );
          }
          case "GET /reports/trend": {
            const result = yield* errorTagged(
              getReportGroupTrend({ trendField: "DURATION" }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { average: result.stats?.average },
            );
          }
          case "POST /reports/delete": {
            const body = (yield* request.json) as unknown as { arn: string };
            const result = yield* errorTagged(deleteReport({ arn: body.arn }));
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { ok: true },
            );
          }

          default:
            return yield* HttpServerResponse.json(
              { error: "Not found", route },
              { status: 404 },
            );
        }
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.EventSource,
        CodeBuild.StartBuildHttp,
        CodeBuild.BatchGetBuildsHttp,
        CodeBuild.StopBuildHttp,
        CodeBuild.RetryBuildHttp,
        CodeBuild.ListBuildsForProjectHttp,
        CodeBuild.BatchDeleteBuildsHttp,
        CodeBuild.InvalidateProjectCacheHttp,
        CodeBuild.StartBuildBatchHttp,
        CodeBuild.StopBuildBatchHttp,
        CodeBuild.RetryBuildBatchHttp,
        CodeBuild.BatchGetBuildBatchesHttp,
        CodeBuild.ListBuildBatchesForProjectHttp,
        CodeBuild.DeleteBuildBatchHttp,
        CodeBuild.StartSandboxHttp,
        CodeBuild.StopSandboxHttp,
        CodeBuild.BatchGetSandboxesHttp,
        CodeBuild.ListSandboxesForProjectHttp,
        CodeBuild.StartCommandExecutionHttp,
        CodeBuild.BatchGetCommandExecutionsHttp,
        CodeBuild.ListCommandExecutionsForSandboxHttp,
        CodeBuild.ListReportsForReportGroupHttp,
        CodeBuild.BatchGetReportsHttp,
        CodeBuild.DescribeTestCasesHttp,
        CodeBuild.DescribeCodeCoveragesHttp,
        CodeBuild.GetReportGroupTrendHttp,
        CodeBuild.DeleteReportHttp,
      ),
    ),
  ),
);
