import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as backup from "@distilled.cloud/aws/backup";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import BackupTestFunctionLive, {
  BackupTestFunction,
  FIXTURE_VAULT_NAME,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "BackupBindings");

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

// The shared Lambda fixture occasionally answers a transient 5xx under
// full-suite parallel load (cold re-init, IAM propagation on the freshly
// attached backup policy that the handler's `Effect.orDie` surfaces as a
// 500). Retry only 5xx; a genuine 4xx/assertion failure surfaces
// immediately.
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

describe.sequential("Backup Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("Backup test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Backup test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* BackupTestFunction;
        }).pipe(Effect.provide(BackupTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      const readinessUrl = `${baseUrl}/bindings`;
      yield* Effect.logInfo(
        `Backup test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Backup test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();
      // Out-of-band proof the fixture vault is gone (AWS Backup reports a
      // missing vault as AccessDeniedException, not ResourceNotFoundException).
      // The raw afterAll context has no providers layer (only `test.provider`
      // bodies do), so the distilled call must be wrapped in `withProviders`
      // to satisfy AWS credentials.
      const vault = yield* Core.withProviders(
        backup
          .describeBackupVault({ BackupVaultName: FIXTURE_VAULT_NAME })
          .pipe(
            Effect.catchTag(
              ["ResourceNotFoundException", "AccessDeniedException"],
              () => Effect.succeed(undefined),
            ),
          ),
        testOptions,
        "BackupBindings",
      );
      expect(vault).toBeUndefined();
    }),
    { timeout: 120_000 },
  );

  describe("binding registration", () => {
    test.provider("all 20 capabilities initialize in the runtime", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/bindings`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect((response as any).bound).toHaveLength(20);
      }),
    );
  });

  describe("ListRecoveryPointsByBackupVault", () => {
    test.provider("lists the fixture vault's recovery points", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/list-recovery-points`),
        ).pipe(Effect.flatMap((r) => r.json));
        // A fresh vault has zero recovery points — assert the call
        // round-trips (BackupVaultName injection + vault-scoped IAM).
        expect((response as any).count).toBe(0);
      }),
    );
  });

  describe("ListBackupJobs", () => {
    test.provider("lists the account's backup jobs", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/list-backup-jobs`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect(typeof (response as any).count).toBe("number");
      }),
    );
  });

  describe("ListRestoreJobs", () => {
    test.provider("lists the account's restore jobs", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/list-restore-jobs`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect(typeof (response as any).count).toBe("number");
      }),
    );
  });

  describe("ListCopyJobs", () => {
    test.provider("lists the account's copy jobs", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/list-copy-jobs`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect(typeof (response as any).count).toBe("number");
      }),
    );
  });

  describe("ListProtectedResources", () => {
    test.provider("lists the account's protected resources", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/list-protected-resources`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect(typeof (response as any).count).toBe("number");
      }),
    );
  });

  describe("GetSupportedResourceTypes", () => {
    test.provider("returns the supported resource types", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/supported-resource-types`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect((response as any).resourceTypes).toContain("DynamoDB");
      }),
    );
  });

  describe("DescribeBackupJob", () => {
    test.provider(
      "returns the typed not-found error for an unknown job id",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/describe-backup-job-not-found`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect((response as any).found).toBe(false);
        }),
    );
  });

  describe("DescribeRecoveryPoint", () => {
    test.provider(
      "returns the typed not-found error for an unknown recovery point",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(
              `${baseUrl}/describe-recovery-point-not-found`,
            ),
          ).pipe(Effect.flatMap((r) => r.json));
          expect((response as any).found).toBe(false);
        }),
    );
  });

  describe("GetRecoveryPointRestoreMetadata", () => {
    test.provider(
      "returns the typed not-found error for an unknown recovery point",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/restore-metadata-not-found`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect((response as any).found).toBe(false);
        }),
    );
  });

  describe("GetRestoreJobMetadata", () => {
    test.provider(
      "returns the typed not-found error for an unknown restore job",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/restore-job-metadata-not-found`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect((response as any).found).toBe(false);
        }),
    );
  });

  describe("PutRestoreValidationResult", () => {
    // A verdict can only be posted against a live restore-test job (minutes
    // of provisioning); the fixture drives the binding through its typed
    // error path — an IAM gap would surface AccessDeniedException (500)
    // instead of a typed tag.
    test.provider(
      "surfaces a typed error for an unknown restore job",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.post(
              `${baseUrl}/put-restore-validation-not-found`,
            ),
          ).pipe(Effect.flatMap((r) => r.json));
          expect([
            "ResourceNotFoundException",
            "InvalidParameterValueException",
            "MissingParameterValueException",
            "InvalidRequestException",
          ]).toContain((response as any).tag);
        }),
    );
  });

  describe("StopBackupJob", () => {
    test.provider("surfaces a typed error for an unknown job id", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.post(`${baseUrl}/stop-backup-job-not-found`),
        ).pipe(Effect.flatMap((r) => r.json));
        expect([
          "ResourceNotFoundException",
          "InvalidParameterValueException",
          "InvalidRequestException",
        ]).toContain((response as any).tag);
      }),
    );
  });

  describe("StartRestoreJob", () => {
    // A real restore needs a live recovery point (a completed backup job —
    // minutes of provisioning). The fixture drives the binding through its
    // typed error path: role injection + backup:StartRestoreJob +
    // iam:PassRole are all exercised, and an IAM gap would surface
    // AccessDeniedException (a 500) instead of the typed tag.
    test.provider(
      "surfaces a typed error for an unknown recovery point",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.post(`${baseUrl}/start-restore-not-found`),
          ).pipe(Effect.flatMap((r) => r.json));
          expect([
            "ResourceNotFoundException",
            "InvalidParameterValueException",
            "MissingParameterValueException",
            "InvalidRequestException",
          ]).toContain((response as any).tag);
        }),
    );
  });
});
