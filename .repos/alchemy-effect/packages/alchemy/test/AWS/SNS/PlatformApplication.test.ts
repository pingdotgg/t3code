import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as sns from "@distilled.cloud/aws/sns";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import {
  PlatformApiFunction,
  PlatformApiFunctionLive,
  PlatformFixture,
} from "./platform-handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

describe.sequential("SNS PlatformApplication", () => {
  // Ungated typed-error probe: SNS validates platform credentials at
  // CreatePlatformApplication time, so a fake GCM API key must surface as a
  // typed `InvalidParameterException` ("Platform credentials are invalid").
  // This proves the distilled error mapping and documents exactly why the
  // full lifecycle below is credential-gated, at near-zero cost (nothing is
  // created).
  test.provider(
    "createPlatformApplication rejects fake credentials with a typed error",
    (_stack) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(
          sns.createPlatformApplication({
            Name: "alchemy-test-sns-platform-probe",
            Platform: "GCM",
            Attributes: { PlatformCredential: "invalid-api-key-probe" },
          }),
        );

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("InvalidParameterException");
        }
      }),
    { timeout: 60_000 },
  );

  // Full lifecycle + mobile-push bindings — requires real push-service
  // credentials:
  //   AWS_TEST_SNS_PLATFORM=1
  //   AWS_TEST_SNS_PLATFORM_NAME (default GCM)
  //   AWS_TEST_SNS_PLATFORM_CREDENTIAL
  //   AWS_TEST_SNS_PLATFORM_TOKEN
  test.provider.skipIf(!process.env.AWS_TEST_SNS_PLATFORM)(
    "platform application lifecycle + endpoint bindings",
    (stack) =>
      Effect.gen(function* () {
        if (!process.env.NO_DESTROY) {
          yield* stack.destroy();
        }

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const { application } = yield* PlatformFixture;
            const apiFunction = yield* PlatformApiFunction;
            return { application, apiFunction };
          }).pipe(Effect.provide(PlatformApiFunctionLive)),
        );

        expect(deployed.application.platformApplicationArn).toContain(":app/");
        expect(deployed.application.enabled).toBe(true);

        const baseUrl = deployed.apiFunction.functionUrl!.replace(/\/+$/, "");
        const response = yield* HttpClient.execute(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/endpoint-cycle`),
            { token: process.env.AWS_TEST_SNS_PLATFORM_TOKEN },
          ),
        ).pipe(
          Effect.retry({
            schedule: Schedule.exponential("2 seconds"),
            times: 8,
          }),
          Effect.flatMap((res) => res.json),
        );

        expect((response as any).ok).toBe(true);
        expect((response as any).endpointArn).toContain(":endpoint/");
        expect((response as any).endpointCount).toBeGreaterThanOrEqual(0);

        if (!process.env.NO_DESTROY) {
          yield* stack.destroy();
          yield* assertPlatformApplicationGone(
            deployed.application.platformApplicationArn,
          );
        }
      }),
    { timeout: 300_000 },
  );
});

class PlatformApplicationStillExists extends Data.TaggedError(
  "PlatformApplicationStillExists",
) {}

// Out-of-band proof the trailing destroy left nothing behind: the platform
// application must be observably gone (typed NotFoundException) after destroy.
const assertPlatformApplicationGone = Effect.fn(function* (arn: string) {
  yield* sns
    .getPlatformApplicationAttributes({ PlatformApplicationArn: arn })
    .pipe(
      Effect.flatMap(() => Effect.fail(new PlatformApplicationStillExists())),
      Effect.retry({
        while: (error) => error._tag === "PlatformApplicationStillExists",
        schedule: Schedule.exponential(100),
        times: 8,
      }),
      Effect.catchTag("NotFoundException", () => Effect.void),
      Effect.catchTag("InvalidParameterException", () => Effect.void),
    );
});
