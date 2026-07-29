import * as Lambda from "@/AWS/Lambda";
import * as SecretsManager from "@/AWS/SecretsManager";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Secrets Manager marks values as sensitive, so the distilled client can hand
// them back either raw or wrapped in `Redacted` — unwrap for JSON transport.
const unwrapString = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : typeof value === "string"
      ? value
      : Redacted.value(value);

const unwrapBinary = (
  value: Uint8Array | Redacted.Redacted<Uint8Array> | undefined,
): Uint8Array | undefined =>
  value === undefined
    ? undefined
    : value instanceof Uint8Array
      ? value
      : Redacted.value(value);

export class SecretsManagerTestFunction extends Lambda.Function<Lambda.Function>()(
  "SecretsManagerTestFunction",
) {}

export default SecretsManagerTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const stringSecret = yield* SecretsManager.Secret("StringSecret", {
      description: "alchemy binding fixture (string value)",
      secretString: Redacted.make("alchemy-sm-fixture-value"),
    });
    // Created without an initial value: the binary round-trip is driven
    // entirely through the PutSecretValue/GetSecretValue bindings.
    const binarySecret = yield* SecretsManager.Secret("BinarySecret", {
      description: "alchemy binding fixture (binary value)",
    });
    // Rotated by this function itself via the RotationEventSource below.
    const rotationSecret = yield* SecretsManager.Secret("RotationSecret", {
      description: "alchemy binding fixture (rotated value)",
      secretString: Redacted.make("alchemy-sm-rotation-initial"),
    });

    const getStringSecret = yield* SecretsManager.GetSecretValue(stringSecret);
    const putStringSecret = yield* SecretsManager.PutSecretValue(stringSecret);
    const getBinarySecret = yield* SecretsManager.GetSecretValue(binarySecret);
    const putBinarySecret = yield* SecretsManager.PutSecretValue(binarySecret);
    const describeStringSecret =
      yield* SecretsManager.DescribeSecret(stringSecret);
    const getRandomPassword = yield* SecretsManager.GetRandomPassword();
    const listSecrets = yield* SecretsManager.ListSecrets();
    const listStringVersions =
      yield* SecretsManager.ListSecretVersionIds(stringSecret);
    const batchGetSecrets = yield* SecretsManager.BatchGetSecretValue([
      stringSecret,
      rotationSecret,
    ]);

    // Rotation-protocol bindings for the rotation secret.
    const getRotationValue =
      yield* SecretsManager.GetSecretValue(rotationSecret);
    const putRotationValue =
      yield* SecretsManager.PutSecretValue(rotationSecret);
    const describeRotationSecret =
      yield* SecretsManager.DescribeSecret(rotationSecret);
    const updateRotationStage =
      yield* SecretsManager.UpdateSecretVersionStage(rotationSecret);
    const listRotationVersions =
      yield* SecretsManager.ListSecretVersionIds(rotationSecret);
    const rotateRotationSecret =
      yield* SecretsManager.RotateSecret(rotationSecret);

    // Register this function as the rotation function for the rotation
    // secret. The handler implements the 4-step protocol against the secret
    // itself (self-contained: no downstream system to `setSecret`/`testSecret`).
    yield* SecretsManager.onSecretRotation(
      rotationSecret,
      { rotationRules: { scheduleExpression: "rate(4 hours)" } },
      (event) =>
        Effect.gen(function* () {
          if (event.Step === "createSecret") {
            // Idempotent: skip if the pending version already exists.
            const versions = yield* listRotationVersions({
              IncludeDeprecated: true,
            });
            const exists = (versions.Versions ?? []).some(
              (version) => version.VersionId === event.ClientRequestToken,
            );
            if (!exists) {
              const generated = yield* getRandomPassword({
                PasswordLength: 24,
                ExcludePunctuation: true,
              });
              const password = unwrapString(generated.RandomPassword) ?? "";
              yield* putRotationValue({
                ClientRequestToken: event.ClientRequestToken,
                SecretString: `alchemy-sm-rotated-${password}`,
                VersionStages: ["AWSPENDING"],
              });
            }
          } else if (event.Step === "finishSecret") {
            const described = yield* describeRotationSecret();
            const stages = described.VersionIdsToStages ?? {};
            const currentVersion = Object.entries(stages).find(([, labels]) =>
              (labels ?? []).includes("AWSCURRENT"),
            )?.[0];
            if (currentVersion !== event.ClientRequestToken) {
              yield* updateRotationStage({
                VersionStage: "AWSCURRENT",
                MoveToVersionId: event.ClientRequestToken,
                RemoveFromVersionId: currentVersion,
              });
            }
          }
          // setSecret / testSecret: nothing to apply or verify — the secret
          // is self-contained.
        }).pipe(
          // Secrets Manager runs a validation invocation right after the
          // rotation schedule is configured at deploy time — the freshly
          // attached role policies may not have propagated yet. A failed
          // validation wedges the rotation "in progress", so retry through
          // the IAM-propagation window (bounded).
          Effect.retry({
            while: (e): boolean => e._tag === "AccessDeniedException",
            schedule: Schedule.max([
              Schedule.fixed("2 seconds"),
              Schedule.recurs(8),
            ]),
          }),
          Effect.asVoid,
          Effect.orDie,
        ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/string-value") {
          const result = yield* getStringSecret();
          return yield* HttpServerResponse.json({
            name: result.Name,
            arn: result.ARN,
            versionId: result.VersionId,
            secretString: unwrapString(result.SecretString),
          });
        }

        if (request.method === "POST" && pathname === "/put-string") {
          const body = (yield* request.json) as unknown as { value: string };
          const result = yield* putStringSecret({ SecretString: body.value });
          return yield* HttpServerResponse.json({
            versionId: result.VersionId,
          });
        }

        if (request.method === "POST" && pathname === "/put-binary") {
          const body = (yield* request.json) as unknown as { base64: string };
          const bytes = yield* Effect.sync(
            () => new Uint8Array(Buffer.from(body.base64, "base64")),
          );
          const result = yield* putBinarySecret({ SecretBinary: bytes });
          return yield* HttpServerResponse.json({
            versionId: result.VersionId,
          });
        }

        if (request.method === "GET" && pathname === "/binary-value") {
          const result = yield* getBinarySecret();
          const bytes = unwrapBinary(result.SecretBinary);
          const base64 = bytes
            ? yield* Effect.sync(() => Buffer.from(bytes).toString("base64"))
            : undefined;
          return yield* HttpServerResponse.json({
            versionId: result.VersionId,
            secretString: unwrapString(result.SecretString),
            base64,
          });
        }

        if (request.method === "GET" && pathname === "/describe") {
          const result = yield* describeStringSecret();
          return yield* HttpServerResponse.json({
            name: result.Name,
            arn: result.ARN,
            description: result.Description,
          });
        }

        if (request.method === "GET" && pathname === "/random-password") {
          const length = Number(url.searchParams.get("length") ?? "24");
          const result = yield* getRandomPassword({
            PasswordLength: length,
            ExcludePunctuation: true,
          });
          return yield* HttpServerResponse.json({
            password: unwrapString(result.RandomPassword),
          });
        }

        if (request.method === "GET" && pathname === "/list") {
          const name = url.searchParams.get("name");
          if (!name) {
            return HttpServerResponse.text("Missing name", { status: 400 });
          }
          const result = yield* listSecrets({
            Filters: [{ Key: "name", Values: [name] }],
          });
          return yield* HttpServerResponse.json({
            names: (result.SecretList ?? []).map((entry) => entry.Name),
          });
        }

        if (request.method === "GET" && pathname === "/versions") {
          const result = yield* listStringVersions({
            IncludeDeprecated: true,
          });
          return yield* HttpServerResponse.json({
            versions: (result.Versions ?? []).map((version) => ({
              versionId: version.VersionId,
              stages: version.VersionStages ?? [],
            })),
          });
        }

        if (request.method === "GET" && pathname === "/batch") {
          const result = yield* batchGetSecrets();
          return yield* HttpServerResponse.json({
            values: (result.SecretValues ?? [])
              .map((entry) => ({
                name: entry.Name,
                secretString: unwrapString(entry.SecretString),
              }))
              .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
            errors: (result.Errors ?? []).map((error) => error.ErrorCode),
          });
        }

        if (request.method === "POST" && pathname === "/rotate") {
          // Error-transparent: surface the typed failure to the test as a
          // 409 body instead of an opaque 500 from `orDie`.
          const result = yield* Effect.result(rotateRotationSecret());
          if (Result.isFailure(result)) {
            return yield* HttpServerResponse.json(
              {
                error: result.failure._tag,
                message:
                  (result.failure as { Message?: string }).Message ??
                  (result.failure as { message?: string }).message,
              },
              { status: 409 },
            );
          }
          return yield* HttpServerResponse.json({
            versionId: result.success.VersionId,
          });
        }

        if (request.method === "GET" && pathname === "/rotation-value") {
          const result = yield* Effect.result(getRotationValue());
          if (Result.isFailure(result)) {
            return yield* HttpServerResponse.json(
              {
                error: result.failure._tag,
                message:
                  (result.failure as { Message?: string }).Message ??
                  (result.failure as { message?: string }).message,
              },
              { status: 409 },
            );
          }
          return yield* HttpServerResponse.json({
            versionId: result.success.VersionId,
            secretString: unwrapString(result.success.SecretString),
          });
        }

        if (request.method === "GET" && pathname === "/rotation-status") {
          const result = yield* describeRotationSecret();
          return yield* HttpServerResponse.json({
            rotationEnabled: result.RotationEnabled === true,
            lastRotated: result.LastRotatedDate,
          });
        }

        return yield* HttpServerResponse.json(
          {
            error: "Not found",
            method: request.method,
            pathname,
          },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        SecretsManager.GetSecretValueHttp,
        SecretsManager.PutSecretValueHttp,
        SecretsManager.DescribeSecretHttp,
        SecretsManager.GetRandomPasswordHttp,
        SecretsManager.ListSecretsHttp,
        SecretsManager.ListSecretVersionIdsHttp,
        SecretsManager.BatchGetSecretValueHttp,
        SecretsManager.UpdateSecretVersionStageHttp,
        SecretsManager.RotateSecretHttp,
        Lambda.SecretRotationEventSource,
      ),
    ),
  ),
);
