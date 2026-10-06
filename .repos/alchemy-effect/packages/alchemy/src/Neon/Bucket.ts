import * as Neon from "@distilled.cloud/neon";
import type { CORSRule } from "@distilled.cloud/aws/s3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import type { PropsInput } from "../Input.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { createInternalTags, diffTags, hasTags, tagRecord } from "../Tags.ts";
import {
  resolveBranchScope,
  type BranchScope,
  type ResolvedBranchScope,
} from "./BranchScope.ts";
import {
  Credential,
  validateCredential,
  type CredentialAttributes,
} from "./Credential.ts";
import type { Providers } from "./Providers.ts";
import { emptyStorageBucket, makeStorageClient } from "./Storage.ts";

export type BucketProps = BranchScope & {
  /** Bucket name, unique within this branch. Generated when omitted. */
  name?: string;
  /** Anonymous object GET/HEAD access; never grants anonymous listing or writes. @default "private" */
  access?: "private" | "public_read";
  /** S3 CORS rules. Omission removes managed CORS rules. */
  cors?: CORSRule[];
  /** User tags, merged with Alchemy ownership tags. */
  tags?: Record<string, string>;
  /** Empty objects and incomplete multipart uploads before deletion. @default false */
  forceDestroy?: boolean;
  /** Optional management credential; requires storage:read and storage:write on this branch or an ancestor. */
  credential?: CredentialAttributes;
};

export interface BucketAttributes extends ResolvedBranchScope {
  /** Bucket identity within the branch. */
  bucketName: string;
  /** Current anonymous object read policy. */
  access: "private" | "public_read";
  /** Branch-specific path-style S3 endpoint. */
  endpoint: string;
  /** S3 signing region. */
  region: string;
  /** Observed bucket tags, including ownership markers. */
  tags: Record<string, string>;
  /** Observed CORS rules. */
  cors: CORSRule[];
  /** Management credential for declarative objects and cleanup. Never bound into runtime readers. @internal */
  credential: CredentialAttributes;
}

export interface Bucket extends Resource<
  "Neon.Bucket",
  BucketProps,
  BucketAttributes,
  never,
  Providers
> {}
const BucketResource = Resource<Bucket>("Neon.Bucket");

/**
 * Branch-local S3 object storage. Writes do not change an ancestor's data.
 * The management credential is tracked separately and revoked after bucket cleanup.
 * Neon does not expose a supported visibility update API; changing access fails
 * explicitly instead of replacing a populated bucket. Policies and ACL writes are
 * not supported. A private bucket has no anonymously readable object URL.
 * Adopting an inherited bucket materializes its configuration on the child branch
 * without changing ancestor tags, CORS, or object data.
 *
 * ### Creating a Bucket
 * **Example:** Private uploads with browser CORS
 * ```typescript
 * const uploads = yield* Neon.Bucket("Uploads", {
 *   branch,
 *   cors: [{ AllowedOrigins: ["https://app.example.com"], AllowedMethods: ["PUT", "GET"] }],
 * });
 * ```
 *
 * @resource
 * @product Bucket
 */
export const Bucket: typeof BucketResource = Object.assign(
  (
    id: string,
    props:
      | PropsInput<BucketProps>
      | Effect.Effect<PropsInput<BucketProps>, never, Providers>,
  ) =>
    BucketResource(
      id,
      Effect.gen(function* () {
        const news = Effect.isEffect(props) ? yield* props : props;
        const createCredential = yield* Credential;
        const {
          name: _name,
          access: _access,
          cors: _cors,
          tags: _tags,
          forceDestroy: _forceDestroy,
          credential: suppliedCredential,
          ...scope
        } = news;
        const credential =
          suppliedCredential ??
          (yield* createCredential(`${id}StorageCredential`, {
            ...scope,
            scopes: ["storage:read", "storage:write"],
          }));
        return { ...news, credential };
      }),
    ),
  BucketResource,
);

export class UnsupportedBucketAccessUpdate extends Data.TaggedError(
  "UnsupportedBucketAccessUpdate",
)<{
  message: string;
}> {}
export class BucketNotEmpty extends Data.TaggedError("BucketNotEmpty")<{
  message: string;
}> {}
export class BucketConfigurationError extends Data.TaggedError(
  "BucketConfigurationError",
)<{ message: string }> {}

const apiScope = (scope: ResolvedBranchScope) => ({
  project_id: scope.projectId,
  branch_id: scope.branchId,
});
const observe = Effect.fn(function* (scope: ResolvedBranchScope, name: string) {
  const result = yield* Neon.listProjectBranchBuckets(apiScope(scope));
  return result.buckets.find((bucket) => bucket.name === name);
});

export const bucketStorageClient = (bucket: BucketAttributes) =>
  makeStorageClient(
    {
      endpoint: bucket.endpoint,
      region: bucket.region,
      accessKeyId: bucket.credential.tokenId,
      secretAccessKey: bucket.credential.s3SecretAccessKey,
    },
    bucket.bucketName,
  );

const hydrate = Effect.fn(function* (
  scope: ResolvedBranchScope,
  bucket: Neon.Bucket,
  credential: CredentialAttributes,
) {
  const storage = yield* Neon.getProjectBranchStorage(apiScope(scope));
  const attrs = {
    ...scope,
    bucketName: bucket.name,
    access: bucket.access_level,
    endpoint: storage.s3_endpoint,
    region: storage.region,
    credential,
  };
  const client = yield* makeStorageClient(
    {
      endpoint: attrs.endpoint,
      region: attrs.region,
      accessKeyId: credential.tokenId,
      secretAccessKey: credential.s3SecretAccessKey,
    },
    bucket.name,
  );
  const tags = tagRecord(
    (yield* client.getTags().pipe(
      Effect.retry({
        while: (error) => error._tag === "NoSuchBucket",
        schedule: Schedule.spaced("500 millis"),
        times: 8,
      }),
    )).TagSet?.flatMap((tag) =>
      tag.Key !== undefined && tag.Value !== undefined
        ? [{ Key: tag.Key, Value: tag.Value }]
        : [],
    ),
  );
  const cors =
    (yield* client.getCors().pipe(
      Effect.retry({
        while: (error) => error._tag === "NoSuchBucket",
        schedule: Schedule.spaced("500 millis"),
        times: 8,
      }),
    )).CORSRules ?? [];
  return { ...attrs, tags, cors };
});

const credentialOf = Effect.fn(function* (
  props: BucketProps,
  output?: BucketAttributes,
) {
  const credential = props.credential ?? output?.credential;
  if (!credential)
    return yield* new BucketConfigurationError({
      message: "Bucket management credential is missing",
    });
  return credential;
});

export const BucketProvider = () =>
  Provider.succeed(Bucket, {
    stables: ["projectId", "branchId", "bucketName", "endpoint", "region"],
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || !output) return;
      const scope = yield* resolveBranchScope(news);
      if (
        scope.projectId !== output.projectId ||
        scope.branchId !== output.branchId ||
        (news.name !== undefined && news.name !== output.bucketName)
      )
        return { action: "replace" };
    }),
    read: Effect.fn(function* ({ id, fqn, olds, output }) {
      if (
        !output &&
        !olds?.project?.projectId &&
        !(olds?.branch?.projectId && olds.branch.branchId)
      )
        return undefined;
      const scope = output ?? (yield* resolveBranchScope(olds));
      const name =
        output?.bucketName ??
        olds?.name ??
        (yield* createPhysicalName({ id, maxLength: 63, lowercase: true }));
      const bucket = yield* observe(scope, name);
      if (!bucket) return undefined;
      const credential = yield* credentialOf(olds, output);
      const attrs = yield* hydrate(scope, bucket, credential);
      const expected = {
        ...(yield* createInternalTags(fqn)),
        "alchemy::branch": scope.branchId,
      };
      return hasTags(expected, attrs.tags) ? attrs : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ id, fqn, news, output }) {
      const scope = yield* resolveBranchScope(news);
      const credential = yield* credentialOf(news, output);
      yield* validateCredential(credential, scope, "storage:write");
      yield* validateCredential(credential, scope, "storage:read");
      const name =
        news.name ??
        output?.bucketName ??
        (yield* createPhysicalName({ id, maxLength: 63, lowercase: true }));
      let bucket = yield* observe(scope, name);
      if (!bucket) {
        bucket = (yield* Neon.createProjectBranchBucket({
          ...apiScope(scope),
          name,
          access_level: news.access ?? "private",
        })).bucket;
      }
      if (bucket.access_level !== (news.access ?? "private")) {
        return yield* new UnsupportedBucketAccessUpdate({
          message:
            "Neon has no supported bucket access update operation; change access in the console or retain the existing access level",
        });
      }
      const attrs = yield* hydrate(scope, bucket, credential);
      const client = yield* bucketStorageClient(attrs);
      const tags = {
        ...news.tags,
        ...(yield* createInternalTags(fqn)),
        "alchemy::branch": scope.branchId,
      };
      const delta = diffTags(attrs.tags, tags);
      if (delta.removed.length || delta.upsert.length)
        yield* client.putTags(tags).pipe(
          Effect.catchTag("NoSuchBucket", () =>
            Effect.gen(function* () {
              // Inherited buckets are readable before their branch-local configuration exists.
              yield* Neon.createProjectBranchBucket({
                ...apiScope(scope),
                name,
                access_level: news.access ?? "private",
              });
              yield* client.putTags(tags);
            }),
          ),
        );
      const cors = news.cors ?? [];
      if (JSON.stringify(attrs.cors) !== JSON.stringify(cors)) {
        if (cors.length) yield* client.putCors(cors);
        else yield* client.deleteCors();
      }
      return yield* hydrate(scope, bucket, credential);
    }),
    delete: Effect.fn(function* ({ id, olds, output }) {
      const scope = output ?? (yield* resolveBranchScope(olds));
      const bucketName =
        output?.bucketName ??
        olds.name ??
        (yield* createPhysicalName({ id, maxLength: 63, lowercase: true }));
      const bucket = yield* observe(scope, bucketName);
      if (!bucket) return;
      const credential = yield* credentialOf(olds, output);
      const storage = yield* Neon.getProjectBranchStorage(apiScope(scope));
      const client = yield* makeStorageClient(
        {
          endpoint: storage.s3_endpoint,
          region: storage.region,
          accessKeyId: credential.tokenId,
          secretAccessKey: credential.s3SecretAccessKey,
        },
        bucketName,
      );
      yield* client.deleteBucket().pipe(
        Effect.catchTag("BucketNotEmpty", () =>
          Effect.gen(function* () {
            if (!olds.forceDestroy)
              return yield* new BucketNotEmpty({
                message:
                  "Bucket has objects or multipart uploads; set forceDestroy to explicitly empty it",
              });
            yield* emptyStorageBucket(client);
            const objects = yield* client.list({ limit: 1 });
            const uploads = yield* client.listMultipartUploads();
            if (objects.Contents?.length || uploads.Uploads?.length) {
              return yield* new BucketNotEmpty({
                message:
                  "Bucket changed while being emptied; refusing deletion",
              });
            }
            yield* client.deleteBucket();
          }),
        ),
      );
    }),
  });
