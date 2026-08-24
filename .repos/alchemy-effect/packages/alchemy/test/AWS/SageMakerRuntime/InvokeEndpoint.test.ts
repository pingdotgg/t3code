import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as sagemaker from "@distilled.cloud/aws/sagemaker-runtime";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: invoking a nonexistent endpoint must surface as a
// typed `ValidationError` from distilled's `InvokeEndpointError` union — this
// proves both the SDK's typed error mapping and that the binding's callable is
// wired against the real data-plane API, at near-zero cost (no endpoint is
// provisioned — a real endpoint costs $$ per hour). The full live invocation
// (with a real deployed endpoint) is gated behind AWS_TEST_SAGEMAKER_ENDPOINT=1
// in test/AWS/SageMaker/Endpoint.test.ts.
test.provider(
  "invoking a nonexistent endpoint returns a typed ValidationError",
  (_stack) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        sagemaker.invokeEndpoint({
          EndpointName: "alchemy-nonexistent-endpoint-probe",
          ContentType: "application/json",
          Body: JSON.stringify({ instances: [[0]] }),
        }),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("ValidationError");
      }
    }),
  { timeout: 60_000 },
);

test.provider(
  "async-invoking a nonexistent endpoint returns a typed ValidationError",
  (_stack) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        sagemaker.invokeEndpointAsync({
          EndpointName: "alchemy-nonexistent-endpoint-probe",
          ContentType: "application/json",
          InputLocation:
            "s3://alchemy-nonexistent-bucket-probe/input/request.json",
        }),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("ValidationError");
      }
    }),
  { timeout: 60_000 },
);

test.provider(
  "stream-invoking a nonexistent endpoint returns a typed ValidationError",
  (_stack) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        sagemaker.invokeEndpointWithResponseStream({
          EndpointName: "alchemy-nonexistent-endpoint-probe",
          ContentType: "application/json",
          Body: JSON.stringify({ inputs: "hello" }),
        }),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("ValidationError");
      }
    }),
  { timeout: 60_000 },
);
