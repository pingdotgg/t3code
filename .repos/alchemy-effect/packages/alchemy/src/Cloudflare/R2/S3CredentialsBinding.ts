import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Output from "../../Output.ts";
import { defaultProviderMode } from "../../ProviderMode.ts";
import { sha256 } from "../../Util/sha256.ts";
import { AccountApiToken } from "../ApiToken/AccountApiToken.ts";
import type { PermissionGroupRef } from "../ApiToken/Common.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Worker } from "../Workers/Worker.ts";
import type { WorkerBinding } from "../Workers/WorkerBinding.ts";
import type { Bucket } from "./Bucket.ts";
import type {
  S3Credentials,
  S3CredentialsAccess,
  S3CredentialsValue,
} from "./S3Credentials.ts";

/**
 * Deploy-time half of `Cloudflare.R2.S3Credentials`, shared by async Worker
 * `env` declarations and the Effect-native bindings (`S3Credentials`,
 * `PresignGetObjectToken`, `PresignPutObjectToken`).
 *
 * Binds `bindingName` on the host Worker to the JSON-encoded
 * {@link S3CredentialsValue} for `bucket`:
 *
 * - **live** — mints (or extends) the Worker's scoped
 *   {@link AccountApiToken} with the permission groups for `access` and
 *   injects a `secret_text` binding. R2 derives S3 credentials from any API
 *   token: the access key id is the token id and the secret access key is
 *   the SHA-256 of the token value.
 * - **local** (`alchemy dev`, `dev:` bucket) — injects the dev-only
 *   `r2_s3_credentials` binding. The local runtime lowers it to the Worker's
 *   local S3 endpoint and fixed local credentials, and serves the bucket on
 *   that endpoint. No token or cloud call is involved.
 *
 * NOT exported from `index.ts`.
 */
export const bindS3Credentials = Effect.fn(function* (
  host: Worker,
  bindingName: string,
  bucket: Bucket,
  access: S3CredentialsAccess,
) {
  if (yield* isLocal(host, bucket)) {
    yield* host.bind`${bindingName}`({
      bindings: [
        {
          type: "r2_s3_credentials",
          name: bindingName,
          bucketName: bucket.bucketName,
        },
      ],
    });
    return;
  }

  const { accountId } = yield* yield* CloudflareEnvironment;
  const token = yield* AccountApiToken(`${host.LogicalId}Token`);
  // One binding id per bucket + access level: bindings sharing an id
  // collapse to one, which would drop a write grant when a read binding
  // targets the same bucket (and vice versa).
  yield* token.bind`Cloudflare.R2.S3Credentials(${bucket.LogicalId}, ${access})`(
    {
      policies: [
        {
          effect: "allow",
          permissionGroups: PERMISSION_GROUPS[access],
          resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
        },
      ],
    },
  );
  const binding = Output.all(
    token.tokenId,
    token.value,
    bucket.bucketName,
    bucket.jurisdiction,
  ).pipe(
    Output.mapEffect(([tokenId, value, bucketName, jurisdiction]) =>
      sha256(Redacted.value(value)).pipe(
        Effect.map((secretAccessKey): WorkerBinding => ({
          type: "secret_text",
          name: bindingName,
          text: JSON.stringify({
            endpoint: liveEndpoint(accountId, jurisdiction),
            bucketName,
            region: "auto",
            accessKeyId: tokenId,
            secretAccessKey,
          } satisfies S3CredentialsValue),
        })),
      ),
    ),
  );
  yield* host.bind`${bindingName}`({ bindings: [binding] });
});

/**
 * A bucket, or its declaration (`Cloudflare.R2.Bucket("Uploads")`), which
 * is resolved when the credentials are bound.
 */
export type BucketInput = Bucket | Effect.Effect<Bucket, never, any>;

/** Resolve a {@link BucketInput} to the bucket resource. */
export const resolveBucket = (bucket: BucketInput) =>
  (Effect.isEffect(bucket)
    ? bucket
    : Effect.succeed(bucket)) as Effect.Effect<Bucket>;

const PERMISSION_GROUPS: Record<S3CredentialsAccess, PermissionGroupRef[]> = {
  read: ["Workers R2 Storage Read"],
  write: ["Workers R2 Storage Write"],
  "read-write": ["Workers R2 Storage Read", "Workers R2 Storage Write"],
};

const liveEndpoint = (
  accountId: string,
  jurisdiction: Bucket.Jurisdiction,
): string =>
  jurisdiction === "default"
    ? `https://${accountId}.r2.cloudflarestorage.com`
    : `https://${accountId}.${jurisdiction}.r2.cloudflarestorage.com`;

/**
 * Whether both the Worker and the bucket are emulated locally in this run.
 * Each resolves its own mode: pinned via `Alchemy.remote()` → live;
 * otherwise the run default (`alchemy dev` → local).
 */
const isLocal = (host: Worker, bucket: Bucket) =>
  Effect.gen(function* () {
    const runDefault = yield* defaultProviderMode;
    return (
      (host.Mode ?? runDefault) === "local" &&
      (bucket.Mode ?? runDefault) === "local"
    );
  });

/**
 * Whether an env value is a `Cloudflare.R2.S3Credentials` declaration (keyed
 * on the static `~alchemy/Kind` marker — the value is also an Effect, so env
 * resolution must check this before yielding Effects). Lives here, free of
 * value imports from `Worker.ts`, so async env resolution can use it without
 * a module cycle.
 */
export const isS3Credentials = (value: unknown): value is S3Credentials =>
  typeof value === "object" &&
  value !== null &&
  "~alchemy/Kind" in value &&
  (value as S3Credentials)["~alchemy/Kind"] === "Cloudflare.R2.S3Credentials";
