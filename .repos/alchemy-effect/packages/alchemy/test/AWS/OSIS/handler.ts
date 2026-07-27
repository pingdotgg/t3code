import * as Lambda from "@/AWS/Lambda";
import * as OSIS from "@/AWS/OSIS";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class OsisTestFunction extends Lambda.Function<Lambda.Function>()(
  "OsisTestFunction",
) {}

// A syntactically-valid Data Prepper configuration (http source -> s3 sink).
// ValidatePipeline is a static check; the role/bucket are never assumed.
const validConfig = `version: "2"
log-pipeline:
  source:
    http:
      path: "/logs/ingest"
  sink:
    - s3:
        aws:
          sts_role_arn: "arn:aws:iam::123456789012:role/osis-validate-fixture"
          region: "us-west-2"
        bucket: "osis-validate-fixture"
        threshold:
          event_collect_timeout: "60s"
        codec:
          ndjson:
`;

// Structurally broken: the sink references a plugin that does not exist.
const invalidConfig = `version: "2"
bad-pipeline:
  source:
    http:
      path: "/logs/ingest"
  sink:
    - not-a-real-sink-plugin:
        some_option: true
`;

export default OsisTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // Account-level bindings — no resource argument.
    const validatePipeline = yield* OSIS.ValidatePipeline();
    const listPipelineBlueprints = yield* OSIS.ListPipelineBlueprints();
    const getPipelineBlueprint = yield* OSIS.GetPipelineBlueprint();
    const listPipelineEndpointConnections =
      yield* OSIS.ListPipelineEndpointConnections();

    const bound = {
      validatePipeline,
      listPipelineBlueprints,
      getPipelineBlueprint,
      listPipelineEndpointConnections,
    };

    // ValidatePipeline surfaces some invalid configs as a typed
    // ValidationException rather than `isValid: false`; normalize both.
    const validate = (body: string) =>
      validatePipeline({ PipelineConfigurationBody: body }).pipe(
        Effect.map((response) => ({
          isValid: response.isValid === true,
          errors: (response.Errors ?? []).flatMap((e) =>
            e.Message !== undefined ? [e.Message] : [],
          ),
        })),
        Effect.catchTag("ValidationException", (error) =>
          Effect.succeed({
            isValid: false,
            errors: [error.message ?? "ValidationException"],
          }),
        ),
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

        if (request.method === "GET" && pathname === "/validate-good") {
          return yield* HttpServerResponse.json(yield* validate(validConfig));
        }

        if (request.method === "GET" && pathname === "/validate-bad") {
          return yield* HttpServerResponse.json(yield* validate(invalidConfig));
        }

        if (request.method === "GET" && pathname === "/blueprints") {
          const { Blueprints } = yield* listPipelineBlueprints();
          return yield* HttpServerResponse.json({
            names: (Blueprints ?? []).flatMap((blueprint) =>
              blueprint.BlueprintName !== undefined
                ? [blueprint.BlueprintName]
                : [],
            ),
          });
        }

        if (request.method === "GET" && pathname === "/blueprint") {
          const name = url.searchParams.get("name") ?? "";
          const { Blueprint } = yield* getPipelineBlueprint({
            BlueprintName: name,
          });
          return yield* HttpServerResponse.json({
            name: Blueprint?.BlueprintName,
            hasBody:
              typeof Blueprint?.PipelineConfigurationBody === "string" &&
              Blueprint.PipelineConfigurationBody.length > 0,
          });
        }

        if (request.method === "GET" && pathname === "/endpoint-connections") {
          const { PipelineEndpointConnections } =
            yield* listPipelineEndpointConnections();
          return yield* HttpServerResponse.json({
            count: (PipelineEndpointConnections ?? []).length,
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
        OSIS.ValidatePipelineHttp,
        OSIS.ListPipelineBlueprintsHttp,
        OSIS.GetPipelineBlueprintHttp,
        OSIS.ListPipelineEndpointConnectionsHttp,
      ),
    ),
  ),
);
