import * as AWS from "@alchemy.run/aws";
import * as EC2 from "@alchemy.run/aws/EC2";
import * as Endpoint from "@alchemy.run/aws/Endpoint";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Region from "@alchemy.run/aws/Region";
import { Bucket } from "@alchemy.run/aws/S3";
import { Queue } from "@alchemy.run/aws/SQS";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import * as ec2 from "@distilled.cloud/aws/ec2";
import type { RegionName } from "@distilled.cloud/aws/Region";
import * as Alchemy from "alchemy";
/**
 * Credential-free `alchemy dev` for AWS.
 *
 * THE RULING: local emulation is invisible plumbing — `alchemy dev`
 * with zero AWS credentials must work, landing every emulatable resource in
 * the local floci emulator, while `Alchemy.remote()` resources demand real
 * credentials up front with a typed, actionable error.
 *
 * ## How zero-credentials is arranged
 *
 * This file exercises the real resolution path with nothing configured:
 *
 *  1. `Test.make({ profile: <name that exists nowhere on disk> })` — the
 *     harness's `withProfileOverride` makes `ALCHEMY_PROFILE` resolve to a
 *     profile that has no AWS (or any) section, so the real on-disk
 *     `~/.alchemy` config (e.g. the `testing` SSO profile set by
 *     `--profile testing`) is never consulted.
 *  2. Ambient AWS_* env credentials are neutralized via the ConfigProvider
 *     seam: a masking provider is `Layer.provide`d onto `AWS.providers()`,
 *     so `AWSEnvironment.Default`'s env-var probe (`{ method: "env" }`)
 *     finds nothing even when the shell exports AWS keys. All other config
 *     (ALCHEMY_PROFILE, etc.) falls through to the harness provider.
 *
 * With neither a profile nor env creds, `AWSEnvironment.Default` in dev mode
 * falls back to the local emulator environment (dummy creds, account
 * 000000000000, endpoint localhost:4566, `ensureFloci`) instead of failing.
 *
 * Requires Docker (floci runs as the shared `alchemy-floci` container);
 * emulator-touching tests are skipped when the daemon is unavailable.
 */
import { CredentialsRequired } from "alchemy/Auth/Demand";
import { ProfileStore, type ProfileStoreService } from "alchemy/Auth/Profile";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

const FLOCI_ENDPOINT = "http://localhost:4566";

/**
 * A profile name that exists in no `~/.alchemy` config. `getProfile`
 * returns `undefined` for it, which is exactly the "user never
 * configured a profile" starting state.
 */
const NO_CREDS_PROFILE = "credfree-dev-test-does-not-exist";

/**
 * Config keys that could leak ambient AWS credentials (or redirect the
 * emulator endpoint / region) from the developer's shell or .env files
 * into the environment resolution under test.
 */
const MASKED_AWS_KEYS = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_ACCOUNT_ID",
  "AWS_ENDPOINT_URL",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
]);

/**
 * ConfigProvider that hides the AWS_* credential keys and delegates every
 * other lookup to the ambient provider (so ALCHEMY_PROFILE overrides and
 * .env config still work). Provided onto `AWS.providers()` so the
 * environment resolution captured at layer build sees a shell with no AWS
 * credentials, regardless of what the real shell exports.
 */
const maskAwsEnv = Layer.effect(
  ConfigProvider.ConfigProvider,
  Effect.gen(function* () {
    const base = yield* ConfigProvider.ConfigProvider;
    return ConfigProvider.make((path) =>
      path.length === 1 && typeof path[0] === "string" && MASKED_AWS_KEYS.has(path[0])
        ? Effect.succeed(undefined)
        : base.load(path),
    );
  }),
);

const providers = AWS.providers().pipe(Layer.provide(maskAwsEnv));

// `dev: true` runs the same topology as the real `alchemy dev` command
// (including the RPC sidecar default for RPC-backed providers).
const testOptions = { providers, profile: NO_CREDS_PROFILE };
const { test, deploy, destroy } = Test.make({ ...testOptions, dev: true });

/**
 * Raw (non-distilled) call against the emulator gateway — out-of-band proof
 * that a resource exists IN THE EMULATOR, not the real cloud.
 */
const rawAwsJson = Effect.fn(function* (options: {
  service: string;
  region: string;
  target: string;
  body: Record<string, unknown>;
}) {
  const client = yield* HttpClient.HttpClient;
  return yield* client.execute(
    HttpClientRequest.post(`${FLOCI_ENDPOINT}/`).pipe(
      HttpClientRequest.setHeaders({
        "content-type": "application/x-amz-json-1.0",
        "x-amz-target": options.target,
        "x-amz-date": "20260101T000000Z",
        authorization: `AWS4-HMAC-SHA256 Credential=test/20260101/${options.region}/${options.service}/aws4_request, SignedHeaders=host;x-amz-date, Signature=dummy`,
      }),
      HttpClientRequest.setBody(
        HttpBody.text(JSON.stringify(options.body), "application/x-amz-json-1.0"),
      ),
    ),
  );
});

/**
 * The DX ruling, end to end: a dev deploy with NO configured profile and NO
 * env credentials must succeed, transparently landing the resources in the
 * local emulator. Forcing `AWSEnvironment.current` inside the stack program
 * additionally pins the credential fallback itself: resolution yields the
 * synthesized local environment (dummy account, emulator endpoint) instead
 * of prompting or dying.
 */
test.provider(
  "dev deploy with zero AWS credentials lands in the local emulator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const outputs = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("CredFreeBucket");
          const queue = yield* Queue("CredFreeQueue");
          // Force the ambient AWS environment: with no profile and no env
          // creds, dev mode must synthesize the local emulator environment
          // rather than prompting for credentials or failing.
          const env = yield* AWSEnvironment.current;
          return {
            bucket,
            queue,
            accountId: env.accountId,
            region: env.region,
            endpoint: env.endpoint,
          };
        }),
      );

      // The synthesized environment IS the `{ method: "local" }` one.
      expect(outputs.accountId).toBe("000000000000");
      expect(outputs.region).toBe("us-east-1");
      expect(outputs.endpoint).toBe(FLOCI_ENDPOINT);

      // Emulator identities: the dummy-account ARNs prove no real AWS
      // account was involved.
      expect(outputs.bucket.bucketArn).toContain(outputs.bucket.bucketName);
      expect(outputs.queue.queueArn).toContain(":000000000000:");
      expect(outputs.queue.queueUrl).toContain(outputs.queue.queueName);

      // Out-of-band: the queue exists in the emulator gateway.
      const listQueues = yield* rawAwsJson({
        service: "sqs",
        region: "us-east-1",
        target: "AmazonSQS.ListQueues",
        body: {},
      });
      expect(listQueues.status).toBe(200);
      const queues = (yield* listQueues.json) as { QueueUrls?: string[] };
      expect(queues.QueueUrls?.some((url) => url.endsWith(`/${outputs.queue.queueName}`))).toBe(
        true,
      );

      // Destroy must be equally credential-free (rows are stamped local).
      yield* stack.destroy();

      const after = yield* rawAwsJson({
        service: "sqs",
        region: "us-east-1",
        target: "AmazonSQS.ListQueues",
        body: {},
      });
      const queuesAfter = (yield* after.json) as { QueueUrls?: string[] };
      expect(
        queuesAfter.QueueUrls?.some((url) => url.endsWith(`/${outputs.queue.queueName}`)) ?? false,
      ).toBe(false);
    }),
  { tags: ["provider:aws", "provider:aws:s3", "provider:aws:sqs", "local"], timeout: 240_000 },
);

/** Floci-scoped context for the raw distilled calls the test makes itself. */
const flociContext = Layer.mergeAll(
  Endpoint.of(FLOCI_ENDPOINT),
  Region.of("us-east-1"),
  Layer.succeed(
    Credentials,
    Effect.succeed({
      accessKeyId: Redacted.make("test"),
      secretAccessKey: Redacted.make("test"),
      sessionToken: undefined,
      region: "us-east-1" as RegionName,
    }),
  ),
);

/**
 * `AWS.EC2.Network` reads availability zones while it is declared, so
 * evaluating this program needs a reachable EC2 API.
 */
const NetworkStack = Alchemy.Stack(
  "CredFreeNetwork",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const network = yield* EC2.Network("Network", { cidrBlock: "10.0.0.0/16" });
    return { vpcId: network.vpcId };
  }),
);

/**
 * `alchemy destroy` (live mode, no `--dev`) of a stage `alchemy dev` created
 * must not evaluate the program against the real cloud (#1976). With zero
 * credentials, evaluating `EC2.Network` live fails; destroy plans from state
 * alone and deletes every row through the local provider its mode records.
 */
test(
  "destroy of a dev stage needs no AWS credentials",
  Effect.gen(function* () {
    yield* destroy(NetworkStack);
    const { vpcId } = yield* deploy(NetworkStack);
    expect(vpcId).toMatch(/^vpc-/);

    // The same call `alchemy destroy --stage <dev stage>` makes: live mode.
    yield* Core.destroy(testOptions, NetworkStack);

    const vpcs = yield* ec2
      .describeVpcs({ Filters: [{ Name: "vpc-id", Values: [vpcId] }] })
      .pipe(Effect.provide(flociContext));
    expect(vpcs.Vpcs ?? []).toEqual([]);
  }),
  { tags: ["provider:aws", "provider:aws:ec2", "local"], timeout: 240_000 },
);

/**
 * Profile service with nothing configured. Mutation and configuration methods
 * are tripwires: the credential-demand path must fail with the typed
 * `CredentialsRequired` — it never starts a configure flow (logins belong to
 * `alchemy profile edit` exclusively).
 */
const unexpectedProfileMutation = Effect.die(
  new Error("the credential-free path must not mutate profiles"),
);
const noCredsProfile: ProfileStoreService = {
  readManifest: unexpectedProfileMutation,
  getProfile: () => Effect.succeed(undefined),
  ensureProfile: () => unexpectedProfileMutation,
  createProfile: () => unexpectedProfileMutation,
  renameProfile: () => unexpectedProfileMutation,
  current: Effect.succeed({ name: NO_CREDS_PROFILE, source: "configuration" }),
  setProviderConfig: () => unexpectedProfileMutation,
  deleteProviderConfig: () => unexpectedProfileMutation,
  deleteProfile: () => Effect.succeed(false),
  loadProviderConfig: () => unexpectedProfileMutation,
};

/**
 * The test runner exports CI=true, but the CI contract for the
 * credential-demand seam is "use env-var credentials" — a different behavior
 * than the one under test. Mask CI and AWS credentials at the demand seam
 * as well as provider construction, so fake-profile wrappers and .env files
 * cannot turn the missing-credentials assertion into an environment login.
 */
const maskCredentialDemand = Layer.effect(
  ConfigProvider.ConfigProvider,
  Effect.gen(function* () {
    const base = yield* ConfigProvider.ConfigProvider;
    return ConfigProvider.make((path) =>
      path.length === 1 &&
      typeof path[0] === "string" &&
      (path[0] === "CI" || MASKED_AWS_KEYS.has(path[0]))
        ? Effect.succeed(undefined)
        : base.load(path),
    );
  }),
);

/**
 * The other half of the ruling: a resource pinned to the real cloud via
 * `Alchemy.remote()` must NOT silently fall back to the emulator. With no
 * credentials configured, the dev deploy fails up front — before apply —
 * with the typed `CredentialsRequired` error naming the demanding resource
 * and pointing at `alchemy profile edit`.
 */
test.provider(
  "remote() without credentials fails with a typed CredentialsRequired error",
  (stack) =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        stack
          .deploy(
            Effect.gen(function* () {
              const bucket = yield* Bucket("RemoteBucket").pipe(Alchemy.remote());
              return { bucket };
            }),
          )
          .pipe(
            // No saved profile, CI mode, or ambient AWS credentials.
            Effect.provideService(ProfileStore, noCredsProfile),
            Effect.provide(maskCredentialDemand),
          ),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        const error = result.failure as CredentialsRequired;
        expect(error._tag).toBe("CredentialsRequired");
        expect(error.provider).toBe("AWS");
        expect(error.reason).toBe("remote");
        expect(error.resources.some((fqn) => fqn.includes("RemoteBucket"))).toBe(true);
        expect(error.message).toContain("AWS credentials are required");
        expect(error.message).toContain("RemoteBucket");
        expect(error.message).toContain(
          `alchemy profile edit --profile ${NO_CREDS_PROFILE} --add AWS`,
        );
        expect(error.message).toContain("Alchemy.remote()");
      }
    }),
  { tags: ["provider:aws", "provider:aws:s3", "local"], timeout: 60_000 },
);
