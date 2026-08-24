import * as DataBrew from "@/AWS/DataBrew";
import * as IAM from "@/AWS/IAM";
import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export const SOURCE_KEY = "raw/data.csv";

/**
 * Shared foundation for the bindings fixture: bucket + DataBrew service role
 * + dataset + published recipe. The Bindings test deploys this FIRST, seeds
 * the CSV source object, and only then deploys the full fixture — DataBrew
 * validates the dataset's source object with the job role when the job and
 * project are created.
 */
export const foundation = Effect.gen(function* () {
  const bucket = yield* S3.Bucket("DataBrewBindingsBucket", {
    forceDestroy: true,
  });
  const role = yield* IAM.Role("DataBrewBindingsRole", {
    assumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "databrew.amazonaws.com" },
          Action: ["sts:AssumeRole"],
        },
      ],
    },
    managedPolicyArns: [
      "arn:aws:iam::aws:policy/service-role/AwsGlueDataBrewServiceRole",
      "arn:aws:iam::aws:policy/AmazonS3FullAccess",
    ],
  });
  const dataset = yield* DataBrew.Dataset("DataBrewBindingsSource", {
    format: "CSV",
    formatOptions: { csv: { delimiter: ",", headerRow: true } },
    input: {
      s3InputDefinition: { bucket: bucket.bucketName, key: SOURCE_KEY },
    },
  });
  const recipe = yield* DataBrew.Recipe("DataBrewBindingsRecipe", {
    publish: true,
    steps: [
      {
        action: {
          operation: "UPPER_CASE",
          parameters: { sourceColumn: "name" },
        },
      },
    ],
  });
  return { bucket, role, dataset, recipe };
});

export class DataBrewTestFunction extends Lambda.Function<Lambda.Function>()(
  "DataBrewTestFunction",
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

export default DataBrewTestFunction.make(
  {
    main,
    url: true,
    // Session start + action retries fan out SDK calls — AWS's 3s default
    // intermittently times out under cold starts.
    timeout: Duration.seconds(90),
  },
  Effect.gen(function* () {
    const base = yield* foundation;

    const profileJob = yield* DataBrew.Job("DataBrewBindingsProfileJob", {
      type: "PROFILE",
      datasetName: base.dataset.datasetName,
      role: base.role.roleArn,
      outputLocation: { bucket: base.bucket.bucketName, key: "profiles/" },
      jobSample: { mode: "CUSTOM_ROWS", size: 100 },
      maxCapacity: 2,
      timeout: "30 minutes",
    });

    const project = yield* DataBrew.Project("DataBrewBindingsProject", {
      datasetName: base.dataset.datasetName,
      recipeName: base.recipe.recipeName,
      sample: { type: "FIRST_N", size: 100 },
      role: base.role.roleArn,
    });

    // Job-run plane
    const startJobRun = yield* DataBrew.StartJobRun(profileJob);
    const stopJobRun = yield* DataBrew.StopJobRun(profileJob);
    const describeJobRun = yield* DataBrew.DescribeJobRun(profileJob);
    const listJobRuns = yield* DataBrew.ListJobRuns(profileJob);
    // Recipe plane
    const publishRecipe = yield* DataBrew.PublishRecipe(base.recipe);
    // Interactive-session plane
    const startProjectSession = yield* DataBrew.StartProjectSession(project);
    const sendProjectSessionAction =
      yield* DataBrew.SendProjectSessionAction(project);

    // Deploy-time: creates the EventBridge rule (default bus, source
    // aws.databrew) targeting this Function. Runtime firing rides on the
    // real job runs the suite starts; the test verifies the rule deploys.
    yield* DataBrew.consumeJobEvents({}, (events) =>
      Stream.runForEach(events, (event) =>
        Effect.log(
          `databrew event: ${event.detail.jobRunId} of ${event.detail.jobName} -> ${event.detail.state}`,
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
          // ---- job-run plane ----
          case "POST /run/start": {
            const result = yield* errorTagged(startJobRun());
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { runId: result.RunId },
            );
          }
          case "GET /run/list": {
            const result = yield* errorTagged(listJobRuns());
            return yield* HttpServerResponse.json(
              "errorTag" in result
                ? result
                : { runIds: (result.JobRuns ?? []).map((r) => r.RunId) },
            );
          }
          case "GET /run/get": {
            const result = yield* errorTagged(
              describeJobRun({ RunId: param("id") }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { state: result.State },
            );
          }
          case "POST /run/stop": {
            const body = (yield* request.json) as unknown as { id: string };
            const result = yield* errorTagged(stopJobRun({ RunId: body.id }));
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { runId: result.RunId },
            );
          }

          // ---- recipe plane ----
          case "POST /recipe/publish": {
            const result = yield* errorTagged(
              publishRecipe({ Description: "published by bindings fixture" }),
            );
            return yield* HttpServerResponse.json(
              "errorTag" in result ? result : { name: result.Name },
            );
          }

          // ---- interactive-session plane ----
          case "POST /session/run": {
            const started = yield* errorTagged(
              startProjectSession({ AssumeControl: true }),
            );
            if ("errorTag" in started) {
              return yield* HttpServerResponse.json({ started });
            }
            // A fresh session takes a little while to become actionable —
            // surfaced as ConflictException. Bounded retry (6 × 5s).
            const action = yield* errorTagged(
              sendProjectSessionAction({
                Preview: true,
                // The Redacted session token flows straight back in.
                ClientSessionId: started.ClientSessionId,
                RecipeStep: {
                  Action: {
                    Operation: "UPPER_CASE",
                    Parameters: { sourceColumn: "name" },
                  },
                },
              }).pipe(
                Effect.retry({
                  while: (e): boolean => e._tag === "ConflictException",
                  schedule: Schedule.max([
                    Schedule.fixed("5 seconds"),
                    Schedule.recurs(6),
                  ]),
                }),
              ),
            );
            return yield* HttpServerResponse.json({
              started: {
                name: started.Name,
                hasSessionId: started.ClientSessionId !== undefined,
              },
              action:
                "errorTag" in action
                  ? action
                  : { actionId: action.ActionId ?? null },
            });
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
        DataBrew.StartJobRunHttp,
        DataBrew.StopJobRunHttp,
        DataBrew.DescribeJobRunHttp,
        DataBrew.ListJobRunsHttp,
        DataBrew.PublishRecipeHttp,
        DataBrew.StartProjectSessionHttp,
        DataBrew.SendProjectSessionActionHttp,
      ),
    ),
  ),
);
