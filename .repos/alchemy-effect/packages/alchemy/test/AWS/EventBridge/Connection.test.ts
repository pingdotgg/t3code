import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as eventbridge from "@distilled.cloud/aws/eventbridge";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const CONNECTION_NAME = "alchemy-test-eb-connection";
const DESTINATION_NAME = "alchemy-test-eb-destination";

test.provider(
  "connection (Redacted API key) + api destination lifecycle",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create — the API key value is Redacted end-to-end; EventBridge
      // stores it in Secrets Manager.
      const deployOnce = (options: {
        description?: string;
        rateLimit?: number;
      }) =>
        stack.deploy(
          Effect.gen(function* () {
            const connection = yield* AWS.EventBridge.Connection(
              "TestConnection",
              {
                name: CONNECTION_NAME,
                description: options.description,
                authorizationType: "API_KEY",
                authParameters: {
                  apiKeyAuthParameters: {
                    apiKeyName: "x-api-key",
                    apiKeyValue: Redacted.make("alchemy-test-secret-value"),
                  },
                },
              },
            );
            const destination = yield* AWS.EventBridge.ApiDestination(
              "TestDestination",
              {
                name: DESTINATION_NAME,
                connectionArn: connection.connectionArn,
                invocationEndpoint: "https://example.com/events",
                httpMethod: "POST",
                invocationRateLimitPerSecond: options.rateLimit,
              },
            );
            return { connection, destination };
          }),
        );

      const { connection, destination } = yield* deployOnce({ rateLimit: 5 });

      expect(connection.connectionName).toBe(CONNECTION_NAME);
      expect(connection.connectionState).toBe("AUTHORIZED");
      expect(connection.secretArn).toBeTruthy();
      expect(destination.apiDestinationName).toBe(DESTINATION_NAME);
      expect(destination.apiDestinationState).toBe("ACTIVE");

      // Out-of-band verify via distilled — the secret never appears in
      // attributes or describe output (only its Secrets Manager ARN).
      const describedConnection = yield* eventbridge.describeConnection({
        Name: CONNECTION_NAME,
      });
      expect(describedConnection.AuthorizationType).toBe("API_KEY");
      expect(describedConnection.SecretArn).toBeTruthy();
      expect(
        describedConnection.AuthParameters?.ApiKeyAuthParameters?.ApiKeyName,
      ).toBe("x-api-key");

      const describedDestination = yield* eventbridge.describeApiDestination({
        Name: DESTINATION_NAME,
      });
      expect(describedDestination.InvocationEndpoint).toBe(
        "https://example.com/events",
      );
      expect(describedDestination.InvocationRateLimitPerSecond).toBe(5);

      // Update — description and rate limit sync in place (no replace).
      const { connection: updatedConnection, destination: updatedDestination } =
        yield* deployOnce({ description: "updated connection", rateLimit: 10 });
      expect(updatedConnection.connectionArn).toBe(connection.connectionArn);
      expect(updatedDestination.apiDestinationArn).toBe(
        destination.apiDestinationArn,
      );

      const afterUpdate = yield* eventbridge.describeConnection({
        Name: CONNECTION_NAME,
      });
      expect(afterUpdate.Description).toBe("updated connection");
      const destinationAfterUpdate = yield* eventbridge.describeApiDestination({
        Name: DESTINATION_NAME,
      });
      expect(destinationAfterUpdate.InvocationRateLimitPerSecond).toBe(10);

      yield* stack.destroy();

      // Typed wait-until-gone — connection deletion is asynchronous
      // (DELETING state), so poll until NotFound.
      const gone = yield* eventbridge
        .describeConnection({ Name: CONNECTION_NAME })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(true),
          ),
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (isGone): boolean => isGone,
            times: 15,
          }),
        );
      expect(gone).toBe(true);

      const destinationGone = yield* eventbridge
        .describeApiDestination({ Name: DESTINATION_NAME })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(true),
          ),
        );
      expect(destinationGone).toBe(true);
    }),
  { timeout: 180_000 },
);
