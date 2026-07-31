import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import CognitoTriggerFunctionLive, {
  CognitoTriggerFunction,
} from "./trigger-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "CognitoTriggers");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Retry transient 5xx only (cold re-init, IAM / trigger-permission
// propagation); 4xx and assertion failures surface immediately.
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
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
  );

const decodeJwtPayload = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));

describe("Cognito UserPool Triggers", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "Cognito triggers setup: destroying previous stack",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Cognito triggers setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* CognitoTriggerFunction;
        }).pipe(Effect.provide(CognitoTriggerFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/config`;

      yield* Effect.logInfo(
        `Cognito triggers setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Cognito triggers setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("UserPoolTriggerEventSource", () => {
    test.provider(
      "preSignUp auto-confirms sign-up; preTokenGeneration stamps a claim",
      (_stack) =>
        Effect.gen(function* () {
          const config = (yield* send(
            HttpClientRequest.get(`${baseUrl}/config`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            userPoolId: string;
            clientId: string;
          };

          const response = (yield* send(
            HttpClientRequest.post(
              `${baseUrl}/sign-up-flow?username=trigger-user`,
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            userConfirmed: boolean | undefined;
            userStatus: string | undefined;
            emailVerified: string | undefined;
            idToken: string | undefined;
          };

          // PreSignUp auto-confirm: the sign-up response itself reports the
          // user as confirmed, and the pool shows CONFIRMED — no
          // confirmation code was ever entered.
          expect(response.userConfirmed).toBe(true);
          expect(response.userStatus).toBe("CONFIRMED");
          expect(response.emailVerified).toBe("true");

          // Password auth succeeded immediately after sign-up, proving the
          // account was usable without confirmation.
          expect(response.idToken).toBeTruthy();

          // PreTokenGeneration: the ID token carries the claim the trigger
          // handler stamped in, and is a real JWT issued by our pool.
          const payload = decodeJwtPayload(response.idToken!);
          expect(payload.alchemyTrigger).toBe("pre-token-generation");
          expect(payload.iss).toContain(`/${config.userPoolId}`);
          expect(payload["cognito:username"]).toBe("trigger-user");
          expect(payload.aud).toBe(config.clientId);
        }),
      { timeout: 120_000 },
    );
  });
});
