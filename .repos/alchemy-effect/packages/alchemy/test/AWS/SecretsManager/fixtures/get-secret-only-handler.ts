import * as Lambda from "@/AWS/Lambda";
import * as SecretsManager from "@/AWS/SecretsManager";
import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export class GetSecretOnlyTestFunction extends Lambda.Function<GetSecretOnlyTestFunction>()(
  "GetSecretOnlyTestFunction",
) {}

export default GetSecretOnlyTestFunction.make(
  { main: import.meta.url, functionUrl: true },
  Effect.gen(function* () {
    const secret = yield* SecretsManager.Secret("GetSecretOnlySecret", {
      secretString: Redacted.make("alchemy-sm-get-only-value"),
    });
    const getSecretValue = yield* SecretsManager.GetSecretValue(secret);
    const describeSecret = yield* secretsmanager.describeSecret;
    const secretArn = yield* secret.secretArn;
    const secretName = yield* secret.secretName;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = yield* Effect.sync(() => new URL(request.originalUrl));

        if (request.method === "GET" && url.pathname === "/info") {
          return yield* HttpServerResponse.json({
            secretArn: yield* secretArn,
            secretName: yield* secretName,
          });
        }

        if (request.method === "GET" && url.pathname === "/get-value") {
          const result = yield* getSecretValue({
            VersionId: url.searchParams.get("versionId") ?? undefined,
            VersionStage: url.searchParams.get("versionStage") ?? undefined,
          });
          return yield* HttpServerResponse.json({
            arn: result.ARN,
            name: result.Name,
            versionId: result.VersionId,
            secretString:
              typeof result.SecretString === "string" ||
              result.SecretString === undefined
                ? result.SecretString
                : Redacted.value(result.SecretString),
          });
        }

        if (request.method === "GET" && url.pathname === "/describe-denied") {
          const tag = yield* describeSecret({
            SecretId: yield* secretArn,
          }).pipe(
            Effect.as("Allowed"),
            Effect.catchTag("AccessDeniedException", (error) =>
              Effect.succeed(error._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
        }

        return HttpServerResponse.text("Not found", { status: 404 });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(SecretsManager.GetSecretValueHttp)),
);
