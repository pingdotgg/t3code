import { Role } from "@/AWS/IAM/Role.ts";
import * as Lambda from "@/AWS/Lambda";
import * as SageMaker from "@/AWS/SageMaker";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "endpoint-handler.ts");

export class SageMakerEndpointTestFunction extends Lambda.Function<Lambda.Function>()(
  "SageMakerEndpointTestFunction",
) {}

// Gated fixture — deploying a live endpoint takes minutes and requires a
// working serving container (AWS_TEST_SAGEMAKER_IMAGE). Only deployed by
// EndpointBindings.test.ts when AWS_TEST_SAGEMAKER_ENDPOINT=1.
export default SageMakerEndpointTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const image = process.env.AWS_TEST_SAGEMAKER_IMAGE!;
    const modelData = process.env.AWS_TEST_SAGEMAKER_MODEL_DATA;

    const role = yield* Role("SageMakerBindingsEndpointRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "sagemaker.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      managedPolicyArns: ["arn:aws:iam::aws:policy/AmazonSageMakerFullAccess"],
    });
    const model = yield* SageMaker.Model("BindingsEndpointModel", {
      executionRoleArn: role.roleArn,
      primaryContainer: {
        Image: image,
        ...(modelData ? { ModelDataUrl: modelData } : {}),
      },
    });
    const config = yield* SageMaker.EndpointConfig("BindingsEndpointConfig", {
      productionVariants: [
        {
          VariantName: "AllTraffic",
          ModelName: model.modelName,
          ServerlessConfig: { MemorySizeInMB: 2048, MaxConcurrency: 1 },
        },
      ],
    });
    const endpoint = yield* SageMaker.Endpoint("BindingsEndpoint", {
      endpointConfigName: config.endpointConfigName,
    });

    const describeEndpoint = yield* SageMaker.DescribeEndpoint(endpoint);
    const updateWeights =
      yield* SageMaker.UpdateEndpointWeightsAndCapacities(endpoint);

    const bound = { describeEndpoint, updateWeights };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({ bound: Object.keys(bound) });
        }

        if (request.method === "GET" && pathname === "/describe-endpoint") {
          const described = yield* describeEndpoint();
          return yield* HttpServerResponse.json({
            endpointName: described.EndpointName,
            status: described.EndpointStatus,
            variants: (described.ProductionVariants ?? []).map(
              (v) => v.VariantName,
            ),
          });
        }

        if (request.method === "GET" && pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        SageMaker.DescribeEndpointHttp,
        SageMaker.UpdateEndpointWeightsAndCapacitiesHttp,
      ),
    ),
  ),
);
