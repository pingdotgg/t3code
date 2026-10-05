import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import type { PolicyDocument } from "@/AWS/IAM/Policy.ts";
import { normalizePolicyDocument } from "@/AWS/IAM/Policy.ts";
import { Secret } from "@/AWS/SecretsManager/Secret.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as secretsmanager from "@distilled.cloud/aws/secrets-manager";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class SecretNotListed extends Data.TaggedError("SecretNotListed") {}

class ResourcePolicyNotAttached extends Data.TaggedError(
  "ResourcePolicyNotAttached",
) {}

class SecretStillExists extends Data.TaggedError("SecretStillExists") {}

class SecretVersionNotVisible extends Data.TaggedError(
  "SecretVersionNotVisible",
)<{
  readonly expectedVersionId: string;
  readonly observedVersionId: string | undefined;
  readonly descriptionMatches: boolean;
}> {}

// Read APIs propagate independently and can return older snapshots on later calls.
const readCurrentSecret = Effect.fn(function* (
  secretArn: string,
  versionId: string,
  description: string,
) {
  return yield* Effect.retry(
    Effect.gen(function* () {
      const value = yield* secretsmanager.getSecretValue({
        SecretId: secretArn,
      });
      const described = yield* secretsmanager.describeSecret({
        SecretId: secretArn,
      });
      if (
        value.VersionId !== versionId ||
        !value.VersionStages?.includes("AWSCURRENT") ||
        described.Description !== description ||
        !described.VersionIdsToStages?.[versionId]?.includes("AWSCURRENT")
      ) {
        return yield* Effect.fail(
          new SecretVersionNotVisible({
            expectedVersionId: versionId,
            observedVersionId: value.VersionId,
            descriptionMatches: described.Description === description,
          }),
        );
      }
      return { value, described };
    }).pipe(
      Effect.tapError((error) =>
        error._tag === "SecretVersionNotVisible"
          ? Effect.logInfo("Waiting for secret version visibility", error)
          : Effect.void,
      ),
    ),
    {
      while: (error) =>
        error._tag === "SecretVersionNotVisible" ||
        error._tag === "ResourceNotFoundException",
      schedule: Schedule.fixed("2 seconds"),
      times: 10,
    },
  );
});

// Secrets Manager marks values as sensitive, so the distilled client can hand
// them back either raw or wrapped in `Redacted` — unwrap for assertions.
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

// Typed wait-until-gone: the provider deletes with
// `ForceDeleteWithoutRecovery`, which completes asynchronously — poll
// `describeSecret` (bounded) until it fails with the typed
// `ResourceNotFoundException`.
const assertSecretDeleted = (secretArn: string) =>
  secretsmanager.describeSecret({ SecretId: secretArn }).pipe(
    Effect.flatMap(() => Effect.fail(new SecretStillExists())),
    Effect.retry({
      while: (e) => e._tag === "SecretStillExists",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
  );

test.provider(
  "create, update value, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const secret = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Secret("LifecycleSecret", {
            description: "lifecycle v1",
            secretString: Redacted.make("initial-value"),
            tags: { Environment: "test" },
          });
        }),
      );

      expect(secret.secretArn).toContain("arn:aws:secretsmanager:");
      expect(secret.secretName).toBeTruthy();
      expect(secret.versionId).toBeTruthy();

      // Out-of-band verification via distilled.
      const { value: v1 } = yield* readCurrentSecret(
        secret.secretArn,
        secret.versionId!,
        "lifecycle v1",
      );
      expect(v1.VersionId).toBe(secret.versionId);
      expect(v1.VersionStages).toContain("AWSCURRENT");
      expect(unwrapString(v1.SecretString)).toBe("initial-value");

      // Update the value + description in place (no replacement).
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Secret("LifecycleSecret", {
            description: "lifecycle v2",
            secretString: Redacted.make("updated-value"),
            tags: { Environment: "test" },
          });
        }),
      );

      expect(updated.secretArn).toBe(secret.secretArn);
      expect(updated.versionId).toBeTruthy();
      expect(updated.versionId).not.toBe(secret.versionId);

      const { value: v2, described } = yield* readCurrentSecret(
        secret.secretArn,
        updated.versionId!,
        "lifecycle v2",
      );
      expect(v2.VersionId).toBe(updated.versionId);
      expect(v2.VersionStages).toContain("AWSCURRENT");
      expect(unwrapString(v2.SecretString)).toBe("updated-value");

      expect(described.Description).toBe("lifecycle v2");
      expect(updated.description).toBe(described.Description);
      expect(described.VersionIdsToStages?.[updated.versionId!]).toContain(
        "AWSCURRENT",
      );

      yield* stack.destroy();

      yield* assertSecretDeleted(secret.secretArn);
    }),
  { tags: ["provider:aws", "provider:aws:secretsmanager", "live"] },
);

// Audit: `secretBinary` is declared as `Redacted.Redacted<Uint8Array>` — this
// exercises the Redacted conversion end-to-end at deploy time: create with a
// binary value, verify the exact bytes on the wire out-of-band via distilled,
// rotate the binary value in place, and verify the new bytes.
// Deterministic checked-in constants (never generated at test time),
// exercising non-UTF8 bytes through the base64 transport.
const BINARY_V1 = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);
const BINARY_V2 = new Uint8Array([42, 7, 128, 129, 130, 0, 255]);

test.provider(
  "binary secret value round-trips (Redacted prop)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const secret = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Secret("BinaryLifecycleSecret", {
            description: "binary lifecycle v1",
            secretBinary: Redacted.make(BINARY_V1),
          });
        }),
      );

      expect(secret.secretArn).toContain("arn:aws:secretsmanager:");
      expect(secret.versionId).toBeTruthy();

      // Out-of-band verification via distilled: exact bytes on the wire.
      const { value: v1 } = yield* readCurrentSecret(
        secret.secretArn,
        secret.versionId!,
        "binary lifecycle v1",
      );
      expect(v1.VersionId).toBe(secret.versionId);
      expect(v1.VersionStages).toContain("AWSCURRENT");
      expect(Array.from(unwrapBinary(v1.SecretBinary)!)).toEqual(
        Array.from(BINARY_V1),
      );
      expect(unwrapString(v1.SecretString)).toBeUndefined();

      // Rotate the binary value in place (no replacement).
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Secret("BinaryLifecycleSecret", {
            description: "binary lifecycle v2",
            secretBinary: Redacted.make(BINARY_V2),
          });
        }),
      );
      expect(updated.secretArn).toBe(secret.secretArn);
      expect(updated.versionId).toBeTruthy();
      expect(updated.versionId).not.toBe(secret.versionId);

      const { value: v2, described } = yield* readCurrentSecret(
        secret.secretArn,
        updated.versionId!,
        "binary lifecycle v2",
      );
      expect(v2.VersionId).toBe(updated.versionId);
      expect(v2.VersionStages).toContain("AWSCURRENT");
      expect(Array.from(unwrapBinary(v2.SecretBinary)!)).toEqual(
        Array.from(BINARY_V2),
      );
      expect(unwrapString(v2.SecretString)).toBeUndefined();

      expect(described.Description).toBe("binary lifecycle v2");
      expect(updated.description).toBe(described.Description);
      expect(described.VersionIdsToStages?.[updated.versionId!]).toContain(
        "AWSCURRENT",
      );

      yield* stack.destroy();
      yield* assertSecretDeleted(secret.secretArn);
    }),
  { tags: ["provider:aws", "provider:aws:secretsmanager", "live"] },
);

// PolicyDocument adoption: a typed `resourcePolicy` deploys, the attached
// policy round-trips (normalized comparison), and re-deploying the identical
// document is clean — reconcile diffs `normalizePolicyDocument(observed)`
// against `normalizePolicyDocument(desired)` and skips `PutResourcePolicy`
// on equivalence. Removing the prop detaches the policy.
test.provider(
  "resource policy deploys and re-deploys clean",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* AWSEnvironment.current;
      const resourcePolicy: PolicyDocument = {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowAccountRead",
            Effect: "Allow",
            Principal: { AWS: `arn:aws:iam::${accountId}:root` },
            Action: ["secretsmanager:GetSecretValue"],
            Resource: "*",
          },
        ],
      };

      const secret = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Secret("PolicySecret", {
            description: "resource policy round-trip",
            secretString: Redacted.make("policy-value"),
            resourcePolicy,
          });
        }),
      );

      // Out-of-band verification via distilled: the attached policy is
      // equivalent to the typed document (bounded retry through propagation).
      const attached = yield* secretsmanager
        .getResourcePolicy({ SecretId: secret.secretArn })
        .pipe(
          Effect.flatMap((response) =>
            response.ResourcePolicy === undefined
              ? Effect.fail(new ResourcePolicyNotAttached())
              : Effect.succeed(response.ResourcePolicy),
          ),
          Effect.retry({
            while: (e) => e._tag === "ResourcePolicyNotAttached",
            schedule: Schedule.max([
              Schedule.fixed("2 seconds"),
              Schedule.recurs(5),
            ]),
          }),
        );
      expect(normalizePolicyDocument(attached)).toBe(
        normalizePolicyDocument(resourcePolicy),
      );

      // Re-deploy the identical PolicyDocument — must be a clean no-op.
      const redeployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Secret("PolicySecret", {
            description: "resource policy round-trip",
            secretString: Redacted.make("policy-value"),
            resourcePolicy,
          });
        }),
      );
      expect(redeployed.secretArn).toBe(secret.secretArn);

      const afterRedeploy = yield* secretsmanager.getResourcePolicy({
        SecretId: secret.secretArn,
      });
      expect(afterRedeploy.ResourcePolicy).toBeTruthy();
      expect(normalizePolicyDocument(afterRedeploy.ResourcePolicy ?? "")).toBe(
        normalizePolicyDocument(resourcePolicy),
      );

      // Removing the prop detaches the policy.
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Secret("PolicySecret", {
            description: "resource policy round-trip",
            secretString: Redacted.make("policy-value"),
          });
        }),
      );
      const removed = yield* secretsmanager.getResourcePolicy({
        SecretId: secret.secretArn,
      });
      expect(removed.ResourcePolicy).toBeUndefined();

      yield* stack.destroy();
      yield* assertSecretDeleted(secret.secretArn);
    }),
  {
    tags: [
      "provider:aws",
      "provider:aws:iam",
      "provider:aws:secretsmanager",
      "live",
    ],
  },
);

// Canonical `list()` test (AWS account/region-scoped collection): deploy a real
// secret, resolve the provider from context via the typed `findProvider`, call
// `list()`, and assert the deployed secret appears in the exhaustively-paginated
// result. `listSecrets` is eventually consistent, so the assertion retries with
// a bounded schedule until the new secret surfaces.
test.provider(
  "list enumerates the deployed secret",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const secret = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Secret("ListSecret", {
            description: "list lifecycle op coverage",
            secretString: Redacted.make("super-secret-value"),
            tags: { Environment: "test" },
          });
        }),
      );

      const provider = yield* Provider.findProvider(Secret);

      yield* Effect.gen(function* () {
        const all = yield* provider.list();
        const found = all.find((s) => s.secretArn === secret.secretArn);
        if (!found) {
          return yield* Effect.fail(new SecretNotListed());
        }
        // `list` hydrates the exact `read` Attributes shape (no plaintext value).
        expect(found.secretName).toBe(secret.secretName);
        expect(found.versionId).toBeUndefined();
        expect(found.tags.Environment).toBe("test");
      }).pipe(
        Effect.retry({
          while: (e) => e._tag === "SecretNotListed",
          schedule: Schedule.max([
            Schedule.exponential(500),
            Schedule.recurs(8),
          ]),
        }),
      );

      yield* stack.destroy();
    }),
  { tags: ["provider:aws", "provider:aws:secretsmanager", "live"] },
);
