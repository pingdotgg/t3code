import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import SecretsManagerTestFunctionLive, {
  SecretsManagerTestFunction,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "SecretsManagerBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take
// well over 60s on a fresh deploy under parallel-suite load. Budget ~150s
// of readiness polling so we don't fail the whole suite on a slow init.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

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
describe.sequential("SecretsManager Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "SecretsManager test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo("SecretsManager test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* SecretsManagerTestFunction;
        }).pipe(Effect.provide(SecretsManagerTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/describe`;

      yield* Effect.logInfo(
        `SecretsManager test setup: probing readiness at ${readinessUrl}`,
      );

      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
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

  afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
    timeout: 60_000,
  });

  describe("GetSecretValue", () => {
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

        expect((response as any).secretString).toBe("alchemy-sm-fixture-value");
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
    test.provider("lists the string secret's versions with stages", (_stack) =>
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
          expect((after as any).versionId).not.toBe((before as any).versionId);
        }),
      { timeout: 150_000 },
    );
  });
});

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
