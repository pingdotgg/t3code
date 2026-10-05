import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as IAM from "@distilled.cloud/aws/iam";
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import SecretsManagerTestFunctionLive, {
  SecretsManagerTestFunction,
} from "./handler";
import GetSecretOnlyTestFunctionLive, {
  GetSecretOnlyTestFunction,
} from "./fixtures/get-secret-only-handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(
  testOptions,
  "SecretsManagerBindings",
  "test/AWS/SecretsManager/Bindings.test.ts",
);

// Lambda function URL cold-start (DNS, IAM propagation, init) can take
// well over 60s on a fresh deploy under parallel-suite load. Budget ~150s
// of readiness polling so we don't fail the whole suite on a slow init.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let getOnlyUrl: string;
let getOnlyFunction: { functionName: string; roleName: string } | undefined;
let getOnlySecret: { secretArn: string; secretName: string } | undefined;

const policyDocument = Schema.fromJsonString(
  Schema.Struct({
    Version: Schema.optional(Schema.String),
    Id: Schema.optional(Schema.String),
    Statement: Schema.Array(
      Schema.Struct({
        Sid: Schema.optional(Schema.String),
        Effect: Schema.String,
        Action: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
        Resource: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
      }),
    ),
  }),
);

const secretRolePermissions = Effect.fn(function* (roleName: string) {
  const pages = yield* IAM.listRolePolicies
    .pages({ RoleName: roleName })
    .pipe(Stream.runCollect);
  const policies = yield* Effect.forEach(
    pages.flatMap((page) => page.PolicyNames),
    Effect.fn(function* (PolicyName) {
      const policy = yield* IAM.getRolePolicy({
        RoleName: roleName,
        PolicyName,
      });
      const decoded = yield* Effect.try(() =>
        decodeURIComponent(policy.PolicyDocument),
      );
      return yield* Schema.decodeUnknownEffect(policyDocument, {
        onExcessProperty: "error",
      })(decoded);
    }),
  );
  return policies.flatMap((policy) =>
    policy.Statement.flatMap((statement) => {
      const actions =
        typeof statement.Action === "string"
          ? [statement.Action]
          : statement.Action;
      const resources =
        typeof statement.Resource === "string"
          ? [statement.Resource]
          : statement.Resource;
      return actions.flatMap((action) =>
        resources.map((resource) => ({
          effect: statement.Effect,
          action,
          resource,
        })),
      );
    }),
  );
});

const getOnlyValue = Schema.Struct({
  arn: Schema.String,
  name: Schema.String,
  versionId: Schema.String,
  secretString: Schema.String,
});

const readGetOnlyValue = (query = "") =>
  HttpClient.get(`${getOnlyUrl}/get-value${query}`).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : Effect.fail(new Error(`GetSecretValue failed: ${response.status}`)),
    ),
    Effect.flatMap(Schema.decodeUnknownEffect(getOnlyValue)),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }),
  );

class FixtureStillExists extends Data.TaggedError("FixtureStillExists")<{
  readonly resource: string;
}> {}

const assertGetOnlyResourcesDeleted = Effect.gen(function* () {
  yield* Effect.all(
    [
      getOnlySecret
        ? secretsmanager
            .describeSecret({ SecretId: getOnlySecret.secretArn })
            .pipe(
              Effect.flatMap(() =>
                Effect.fail(new FixtureStillExists({ resource: "secret" })),
              ),
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              Effect.retry({
                while: (error) => error._tag === "FixtureStillExists",
                schedule: Schedule.spaced("2 seconds"),
                times: 10,
              }),
            )
        : Effect.void,
      getOnlyFunction
        ? Lambda.getFunction({
            FunctionName: getOnlyFunction.functionName,
          }).pipe(
            Effect.flatMap(() =>
              Effect.fail(new FixtureStillExists({ resource: "function" })),
            ),
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            Effect.retry({
              while: (error) => error._tag === "FixtureStillExists",
              schedule: Schedule.spaced("2 seconds"),
              times: 10,
            }),
          )
        : Effect.void,
    ],
    { concurrency: "unbounded" },
  );
});

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under
// full-suite parallel load (cold re-init, IAM propagation on the freshly
// attached secretsmanager policy that the handler's `Effect.orDie`
// surfaces as a 500). Those are not assertion failures: retry the request
// a few times before surfacing it. A genuine 4xx/assertion failure is
// returned immediately (only 5xx is retried).
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

// Deterministic binary payload (checked-in constant — never generated at
// test time): base64 of bytes [0,1,2,3,250,251,252,253,254,255,42,7],
// exercising non-UTF8 bytes through the base64 transport.
const BINARY_BASE64 = "AAECA/r7/P3+/yoH";

// GetSecretValue's round-trip and PutSecretValue both act on ONE shared
// fixture secret; the global vitest `sequence: { concurrent: true }` would
// let the put race the read and fail it with BindingNotConsistent.
describe.sequential(
  "SecretsManager Bindings",
  {
    tags: [
      "provider:aws",
      "provider:aws:batch",
      "provider:aws:lambda",
      "provider:aws:secretsmanager",
      "live",
    ],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* Effect.logInfo(
          "SecretsManager test setup: destroying previous resources",
        );
        yield* sharedStack.destroy();

        yield* Effect.logInfo("SecretsManager test setup: deploying fixture");
        const { shared, getOnly } = yield* sharedStack.deploy(
          Effect.gen(function* () {
            return {
              shared: yield* SecretsManagerTestFunction,
              getOnly: yield* GetSecretOnlyTestFunction,
            };
          }).pipe(
            Effect.provide(SecretsManagerTestFunctionLive),
            Effect.provide(GetSecretOnlyTestFunctionLive),
          ),
        );

        getOnlyFunction = getOnly;
        expect(getOnly.functionUrl).toBeTruthy();
        getOnlyUrl = getOnly.functionUrl!.replace(/\/+$/, "");
        getOnlySecret = yield* HttpClient.get(`${getOnlyUrl}/info`).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? response.json
              : Effect.fail(
                  new Error(`Function not ready: ${response.status}`),
                ),
          ),
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Struct({
                secretArn: Schema.String,
                secretName: Schema.String,
              }),
            ),
          ),
          Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }),
        );

        expect(shared.functionUrl).toBeTruthy();
        baseUrl = shared.functionUrl!.replace(/\/+$/, "");
        const readinessUrl = `${baseUrl}/describe`;

        yield* Effect.logInfo(
          `SecretsManager test setup: probing readiness at ${readinessUrl}`,
        );

        yield* HttpClient.get(readinessUrl).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? Effect.succeed(response)
              : Effect.fail(
                  new Error(`Function not ready: ${response.status}`),
                ),
          ),
          Effect.tap(() =>
            Effect.logInfo(
              "SecretsManager test setup: fixture responded successfully",
            ),
          ),
          Effect.tapError((error) =>
            Effect.logWarning(
              `SecretsManager test setup: fixture not ready yet (${String(error)})`,
            ),
          ),
          Effect.retry({ schedule: readinessPolicy }),
        );
      }),
      { timeout: 240_000 },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(
      sharedStack
        .destroy()
        .pipe(
          Effect.andThen(
            Core.withProviders(
              assertGetOnlyResourcesDeleted,
              testOptions,
              "SecretsManagerBindings",
            ),
          ),
        ),
      { timeout: 120_000 },
    );

    describe("GetSecretValue", () => {
      test.provider(
        "reads a string with only the GetSecretValue binding",
        (_stack) =>
          Effect.gen(function* () {
            const value = yield* readGetOnlyValue();
            expect(value.secretString).toBe("alchemy-sm-get-only-value");
            expect(value.arn).toBe(getOnlySecret!.secretArn);
            expect(value.name).toBe(getOnlySecret!.secretName);
            expect(value.versionId).toBeTruthy();

            const query = yield* Effect.sync(() =>
              new URLSearchParams({
                versionId: value.versionId,
                versionStage: "AWSCURRENT",
              }).toString(),
            );
            const versioned = yield* readGetOnlyValue(`?${query}`);
            expect(versioned).toEqual(value);
          }),
        { timeout: 120_000 },
      );

      test.provider(
        "grants exactly GetSecretValue on the isolated secret ARN",
        (_stack) =>
          Effect.gen(function* () {
            const roleName = getOnlyFunction!.roleName;
            const permissions = yield* secretRolePermissions(roleName);
            expect(permissions).toEqual([
              {
                effect: "Allow",
                action: "secretsmanager:GetSecretValue",
                resource: getOnlySecret!.secretArn,
              },
            ]);
            const attached = yield* IAM.listAttachedRolePolicies
              .pages({ RoleName: roleName })
              .pipe(Stream.runCollect);
            expect(
              attached.flatMap((page) =>
                (page.AttachedPolicies ?? []).map((policy) => policy.PolicyArn),
              ),
            ).toEqual([
              "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
            ]);
          }),
        { tags: ["provider:aws:iam"], timeout: 120_000 },
      );

      test.provider(
        "denies raw DescribeSecret after an authorized GetSecretValue read",
        (_stack) =>
          Effect.gen(function* () {
            const value = yield* readGetOnlyValue();
            expect(value.secretString).toBe("alchemy-sm-get-only-value");
            expect(value.arn).toBe(getOnlySecret!.secretArn);

            const response = yield* HttpClient.get(
              `${getOnlyUrl}/describe-denied`,
            );
            expect(response.status).toBe(200);
            const denied = yield* response.json.pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.Struct({
                    tag: Schema.Literal("AccessDeniedException"),
                  }),
                ),
              ),
            );
            expect(denied.tag).toBe("AccessDeniedException");
          }),
        { timeout: 120_000 },
      );

      test.provider("reads the string secret value round-trip", (_stack) =>
        Effect.gen(function* () {
          // GetSecretValue is eventually consistent right after the fixture
          // secret is (re)created; poll until the fixture value is observed.
          const response = yield* fetchUntil(
            send(HttpClientRequest.get(`${baseUrl}/string-value`)).pipe(
              Effect.flatMap((r) => r.json),
            ),
            (body) => body?.secretString === "alchemy-sm-fixture-value",
          );

          expect((response as any).secretString).toBe(
            "alchemy-sm-fixture-value",
          );
          expect((response as any).arn).toContain("arn:aws:secretsmanager:");
          expect((response as any).versionId).toBeTruthy();
        }),
      );
    });

    describe("PutSecretValue", () => {
      test.provider("rotates the string secret value", (_stack) =>
        Effect.gen(function* () {
          const put = yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/put-string`),
              { value: "alchemy-sm-rotated-value" },
            ),
          ).pipe(Effect.flatMap((r) => r.json));

          expect((put as any).versionId).toBeTruthy();

          // Read-after-write on a fresh version is eventually consistent;
          // poll until the new version is served as AWSCURRENT.
          const got = yield* fetchUntil(
            send(HttpClientRequest.get(`${baseUrl}/string-value`)).pipe(
              Effect.flatMap((r) => r.json),
            ),
            (body) => body?.versionId === (put as any).versionId,
          );

          expect((got as any).secretString).toBe("alchemy-sm-rotated-value");
          expect((got as any).versionId).toBe((put as any).versionId);
        }),
      );

      test.provider("writes and reads back a binary secret value", (_stack) =>
        Effect.gen(function* () {
          const put = yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/put-binary`),
              { base64: BINARY_BASE64 },
            ),
          ).pipe(Effect.flatMap((r) => r.json));

          expect((put as any).versionId).toBeTruthy();

          // Read-after-write on a fresh version is eventually consistent;
          // poll until the new version is served as AWSCURRENT.
          const got = yield* fetchUntil(
            send(HttpClientRequest.get(`${baseUrl}/binary-value`)).pipe(
              Effect.flatMap((r) => r.json),
            ),
            (body) => body?.versionId === (put as any).versionId,
          );

          expect((got as any).base64).toBe(BINARY_BASE64);
          // A binary version carries no SecretString.
          expect((got as any).secretString).toBeUndefined();
          expect((got as any).versionId).toBe((put as any).versionId);
        }),
      );
    });

    describe("DescribeSecret", () => {
      test.provider("describes the bound secret", (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/describe`),
          ).pipe(Effect.flatMap((r) => r.json));

          expect((response as any).arn).toContain("arn:aws:secretsmanager:");
          expect((response as any).name).toBeTruthy();
          expect((response as any).description).toBe(
            "alchemy binding fixture (string value)",
          );
        }),
      );
    });

    describe("GetRandomPassword", () => {
      test.provider("generates a password of the requested length", (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/random-password?length=24`),
          ).pipe(Effect.flatMap((r) => r.json));

          expect(typeof (response as any).password).toBe("string");
          expect((response as any).password).toHaveLength(24);
        }),
      );
    });

    describe("ListSecrets", () => {
      test.provider("lists the bound secret by name filter", (_stack) =>
        Effect.gen(function* () {
          const described = yield* send(
            HttpClientRequest.get(`${baseUrl}/describe`),
          ).pipe(Effect.flatMap((r) => r.json));
          const name = (described as any).name as string;

          // ListSecrets is eventually consistent; poll until the freshly
          // created secret surfaces in the filtered listing.
          const response = yield* fetchUntil(
            send(
              HttpClientRequest.get(
                `${baseUrl}/list?name=${encodeURIComponent(name)}`,
              ),
            ).pipe(Effect.flatMap((r) => r.json)),
            (body) => Array.isArray(body?.names) && body.names.includes(name),
          );

          expect((response as any).names).toContain(name);
        }),
      );
    });

    describe("ListSecretVersionIds", () => {
      test.provider(
        "lists the string secret's versions with stages",
        (_stack) =>
          Effect.gen(function* () {
            const response = yield* fetchUntil(
              send(HttpClientRequest.get(`${baseUrl}/versions`)).pipe(
                Effect.flatMap((r) => r.json),
              ),
              (body) =>
                Array.isArray(body?.versions) &&
                body.versions.some((version: any) =>
                  version.stages?.includes("AWSCURRENT"),
                ),
            );

            const current = (response as any).versions.find((version: any) =>
              version.stages.includes("AWSCURRENT"),
            );
            expect(current.versionId).toBeTruthy();
          }),
      );
    });

    describe("BatchGetSecretValue", () => {
      test.provider("reads both bound secrets in one call", (_stack) =>
        Effect.gen(function* () {
          // BatchGetSecretValue is eventually consistent right after the
          // fixture secrets are created; poll until both values are served.
          const response = yield* fetchUntil(
            send(HttpClientRequest.get(`${baseUrl}/batch`)).pipe(
              Effect.flatMap((r) => r.json),
            ),
            (body) =>
              Array.isArray(body?.values) &&
              body.values.length === 2 &&
              body.values.every(
                (entry: any) =>
                  typeof entry.secretString === "string" &&
                  entry.secretString.length > 0,
              ),
          );

          expect((response as any).values).toHaveLength(2);
          expect((response as any).errors).toHaveLength(0);
        }),
      );
    });

    // The RotationEventSource wires this same fixture Lambda as the rotation
    // function: RotateSecret kicks off the 4-step protocol
    // (createSecret -> setSecret -> testSecret -> finishSecret), which the
    // handler implements via the GetRandomPassword / PutSecretValue /
    // DescribeSecret / UpdateSecretVersionStage bindings. Runs LAST — it
    // permanently changes the rotation secret's value.
    describe("RotationEventSource", () => {
      test.provider("rotation is configured on the secret", (_stack) =>
        Effect.gen(function* () {
          const status = yield* send(
            HttpClientRequest.get(`${baseUrl}/rotation-status`),
          ).pipe(Effect.flatMap((r) => r.json));

          expect((status as any).rotationEnabled).toBe(true);
        }),
      );

      test.provider(
        "RotateSecret triggers the rotation protocol end-to-end",
        (_stack) =>
          Effect.gen(function* () {
            const before = yield* fetchUntil(
              send(HttpClientRequest.get(`${baseUrl}/rotation-value`)).pipe(
                Effect.flatMap((r) => r.json),
              ),
              (body) => typeof body?.secretString === "string",
            );

            const rotate = yield* send(
              HttpClientRequest.post(`${baseUrl}/rotate`),
            ).pipe(Effect.flatMap((r) => r.json));
            // The fixture surfaces typed RotateSecret failures as
            // `{ error, message }` — assert none so failures are readable.
            expect(rotate).not.toHaveProperty("error");
            expect((rotate as any).versionId).toBeTruthy();

            // Secrets Manager drives the protocol asynchronously — poll until
            // the handler's finishSecret promoted the new version.
            const after = yield* fetchUntil(
              send(HttpClientRequest.get(`${baseUrl}/rotation-value`)).pipe(
                Effect.flatMap((r) => r.json),
              ),
              (body) =>
                typeof body?.secretString === "string" &&
                body.secretString.startsWith("alchemy-sm-rotated-"),
              45,
            );

            expect((after as any).secretString).toMatch(/^alchemy-sm-rotated-/);
            expect((after as any).versionId).not.toBe(
              (before as any).versionId,
            );
          }),
        { timeout: 150_000 },
      );
    });
  },
);

// A request hit a Lambda instance observing not-yet-consistent control-plane
// state (ListSecrets lags fresh creates by a few seconds). Retry.
class BindingNotConsistent extends Data.TaggedError("BindingNotConsistent") {}

const fetchUntil = <A>(
  fetch: Effect.Effect<unknown, any, HttpClient.HttpClient>,
  ready: (body: any) => boolean,
  attempts = 20,
) =>
  fetch.pipe(
    Effect.flatMap((body) =>
      ready(body)
        ? Effect.succeed(body as A)
        : Effect.fail(new BindingNotConsistent()),
    ),
    Effect.retry({
      while: (e) => e._tag === "BindingNotConsistent",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(attempts),
      ]),
    }),
  );
